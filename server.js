
// server.js
// MQTT broker (Aedes) over WebSockets + HTTP UI that auto-refreshes device statuses every 5 seconds.
//
// Endpoints:
// - GET  /              : Info page
// - GET  /health        : Health check
// - GET  /devices       : Auto-refreshing HTML table of device statuses
// - GET  /api/devices   : JSON ({ items: [{device, status, updatedAt}], count })
// WebSocket MQTT endpoint: ws(s)://<host>/mqtt
//
// MQTT messages:
// - Expect topic: "devices/status"
// - Payload (preferred JSON): { "device": "Device-01", "status": "online", "ts": 1733055000000 }
// - Fallback text format supported: "Device-01,online" or "Device-01:online"

require('dotenv').config();

const http   = require('http');   // built-in HTTP server
const ws     = require('ws');     // WebSocket server
const aedes  = require('aedes')();// MQTT broker
const morgan = require('morgan'); // HTTP request logging (optional)

const PORT    = process.env.PORT || 3000; // Railway injects PORT
const WS_PATH = '/mqtt';

// ---------------- In-memory device registry ----------------
// deviceStatus: { [deviceName]: { status: 'online'|'offline'|string, updatedAt: ISOString } }
const deviceStatus = Object.create(null);
const MAX_DEVICES  = 1000;

// Helper: escape HTML for safe rendering
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------- MQTT broker events ----------------
aedes.on('client', (client) => {
  console.log(`[MQTT] client connected: ${client?.id || '(no-id)'}`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT] client disconnected: ${client?.id || '(no-id)'}`);
});

aedes.on('subscribe', (subs, client) => {
  const topics = Array.isArray(subs) ? subs.map(s => s.topic).join(', ') : String(subs);
  console.log(`[MQTT] ${client?.id} subscribed: ${topics}`);
});

// Capture client-origin publishes and update registry
aedes.on('publish', (packet, client) => {
  // Only client-origin publishes (skip broker-origin to avoid loops)
  if (!client) return;

  const topic      = packet?.topic || '';
  const payloadStr = packet?.payload ? packet.payload.toString() : '';

  if (topic === 'devices/status') {
    let device, status, ts;

    // Try JSON payload first
    try {
      const obj = JSON.parse(payloadStr);
      device = String(obj.device || '').trim();
      status = String(obj.status || '').trim();
      ts     = obj.ts;
    } catch {
      // Fallback: CSV "Device-01,online" or "Device-01:online"
      const parts = payloadStr.split(/[,:]/).map(s => s.trim());
      if (parts.length >= 2) {
        device = parts[0];
        status = parts[1];
      }
    }

    if (device && status) {
      deviceStatus[device] = {
        status,
        updatedAt: new Date(ts ? Number(ts) : Date.now()).toISOString()
      };

      // Keep registry size bounded
      const names = Object.keys(deviceStatus);
      if (names.length > MAX_DEVICES) {
        names.sort((a, b) =>
          deviceStatus[a].updatedAt < deviceStatus[b].updatedAt ? -1 : 1
        );
        delete deviceStatus[names[0]];
      }

      console.log(`[MQTT] ${client.id} -> devices/status: ${device} = ${status}`);
    } else {
      console.warn(`[MQTT] devices/status payload ignored (bad format): ${payloadStr}`);
    }
  }
});

// ---------------- HTTP server: UI + API + health ----------------
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // JSON API: current device statuses
  if (req.method === 'GET' && req.url === '/api/devices') {
    const items = Object.entries(deviceStatus).map(([name, info]) => ({
      device: name,
      status: info.status,
      updatedAt: info.updatedAt
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      // If you serve /devices from another host, uncomment the CORS line below:
      // 'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({ items, count: items.length }));
  }

  // HTML UI: auto-refreshing table (5 seconds)
  if (req.method === 'GET' && req.url === '/devices') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Device Live Status</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; max-width: 840px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f3f3f3; text-align: left; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 0.9rem; }
    .online  { background: #d5f5d5; color: #175217; }
    .offline { background: #ffd7d7; color: #6d1111; }
    .unknown { background: #eee;    color: #333; }
    .muted { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <h1>Device Live Status</h1>
    <p class="muted">Auto-refreshes every 5 seconds</p>
    <table id="tbl">
      <thead>
        <tr><th>Device</th><th>Status</th><th>Last Update (UTC)</th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="3">Loading…</td></tr></tbody>
    </table>
  </main>
  <script>
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    async function load() {
      try {
        const res = await fetch('/api/devices', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        const tbody = document.getElementById('rows');

        if (items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3">No data yet. Waiting for MQTT publishes…</td></tr>';
          return;
        }

        let html = '';
        for (const x of items) {
          const dev = escapeHtml(x.device || '');
          const st  = String(x.status || '').toLowerCase();
          const cls = st === 'online' ? 'online' : (st === 'offline' ? 'offline' : 'unknown');
          const upd = escapeHtml(x.updatedAt || '');
          html += '<tr>'
               + '<td>' + dev + '</td>'
               + '<td><span class="badge ' + cls + '">' + escapeHtml(x.status || '') + '</span></td>'
               + '<td>' + upd + '</td>'
               + '</tr>';
        }
        tbody.innerHTML = html;
      } catch (e) {
        console.error('Load error:', e);
        const tbody = document.getElementById('rows');
        tbody.innerHTML = '<tr><td colspan="3">Error loading. Check console.</td></tr>';
      }
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`);
  }

  // Info page
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(
      `MQTT WebSocket broker running. Connect via ws(s)://<host>${WS_PATH}\n` +
      `Publish device status to topic "devices/status" with JSON payload:\n` +
      `{"device":"Device-01","status":"online","ts":<epochMillis>}\n` +
      `View live table at GET /devices (auto-refresh 5s)`
    );
  }

  // Default 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------- WebSocket endpoint for MQTT ----------------
const wss = new ws.Server({ server, path: WS_PATH });
wss.on('connection', (socket) => {
  const stream = ws.createWebSocketStream(socket);
  aedes.handle(stream);
});

// Optional: HTTP request logging
server.on('request', morgan('dev'));

server.listen(PORT, () => {
  console.log(`Broker + UI listening on PORT=${PORT}`);
  console.log(`WS MQTT endpoint: ws(s)://<your-host>${WS_PATH}`);
   console.log(`View devices at GET /devices`);
