
// server.js
// MQTT broker (Aedes) over WebSockets + a small HTTP UI that refreshes every 5 seconds to show device statuses.

require('dotenv').config();
const http = require('http');
const ws = require('ws');
const aedes = require('aedes')();
const morgan = require('morgan');

const PORT = process.env.PORT || 3000;
const WS_PATH = '/mqtt';

// ---------------- In-memory device registry ----------------
// deviceStatus: { [deviceName]: { status: 'online'|'offline'|string, updatedAt: ISOString } }
const deviceStatus = Object.create(null);
const MAX_DEVICES = 1000;

// Helper: escape HTML
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- MQTT handlers ----------------
aedes.on('client', (client) => {
  console.log(`[MQTT] client connected: ${client?.id || '(no-id)'}`);
});
aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT] client disconnected: ${client?.id || '(no-id)'}`);
});
aedes.on('subscribe', (subs, client) => {
  console.log(`[MQTT] ${client?.id} subscribed: ${subs.map(s => s.topic).join(', ')}`);
});

// Capture client-origin publishes and update registry
aedes.on('publish', (packet, client) => {
  if (!client) return; // skip broker-origin publishes
  const topic = packet?.topic || '';
  const payloadStr = packet?.payload ? packet.payload.toString() : '';

  // We only care about device status topic
  if (topic === 'devices/status') {
    let device, status, ts;

    // Try JSON first
    try {
      const obj = JSON.parse(payloadStr);
      device = String(obj.device || '').trim();
      status = String(obj.status || '').trim();
      ts = obj.ts;
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

      // Keep map size in check
      const names = Object.keys(deviceStatus);
      if (names.length > MAX_DEVICES) {
        // Remove oldest (simple heuristic): sort by updatedAt and drop first
        names.sort((a, b) => (deviceStatus[a].updatedAt < deviceStatus[b].updatedAt ? -1 : 1));
        delete deviceStatus[names[0]];
      }

      console.log(`[MQTT] ${client.id} -> devices/status: ${device} = ${status}`);
    } else {
      console.warn(`[MQTT] devices/status payload ignored (bad format): ${payloadStr}`);
    }
  }
});

// ---------------- HTTP server (UI + API) ----------------
const server = http.createServer((req, res) => {
  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // JSON API for the page
  if (req.method === 'GET' && req.url === '/api/devices') {
    const out = Object.entries(deviceStatus)
      .map(([name, info]) => ({ device: name, status: info.status, updatedAt: info.updatedAt }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: out, count: out.length }));
  }

  // Simple UI (auto-refresh every 5s via fetch)
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
    .online { background: #d5f5d5; color: #175217; }
    .offline { background: #ffd7d7; color: #6d1111; }
    .unknown { background: #eee; color: #333; }
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
    async function load() {
      try {
        const res = await fetch('/api/devices', { cache: 'no-store' });
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        const tbody = document.getElementById('rows');
        if (items.length === 0) {
          tbody.innerHTML = '<tr><td colspan=\"3\">No data yet. Waiting for MQTT publishes…</td></tr>';
          return;
        }
        tbody.innerHTML = items.map(x => {
          const status = (x.status || '').toLowerCase();
          const cls = status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'unknown';
          return '<tr>' +
            '<td>' + ${'`'}${'${'}escapeHtml(x.device){'}'}${'`'} + '</td>' +
            '<td><span class="badge ' + cls + '">' + ${'`'}${'${'}escapeHtml(x.status){'}'}${'`'} + '</span></td>' +
            '<td>' + ${'`'}${'${'}escapeHtml(x.updatedAt){'}'}${'`'} + '</td>' +
          '</tr>';
        }).join('');
      } catch (e) {
        console.error('Load error', e);
      }
    }
    // Minimal inline escaping (same as server, duplicated for safety)
    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    load();
    setInterval(load, 5000); // 5-second auto refresh
  </script>
</body>
</html>`);
  }

  // Default info page
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`MQTT WS broker running. Connect via ws(s)://<host>${WS_PATH}
- Publish device status to topic "devices/status" with JSON: {"device":"Device-01","status":"online","ts":<epochMillis>}
- View live table at GET /devices (auto-refresh 5s)`);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------- WebSocket endpoint ----------------
const wss = new ws.Server({ server, path: WS_PATH });
wss.on('connection', (socket) => {
  const stream = ws.createWebSocketStream(socket);
  aedes.handle(stream);
});

server.on('request', morgan('dev'));

server.listen(PORT, () => {
  console.log(`Broker + UI listening on PORT=${PORT}`);
  console.log(`WS MQTT endpoint: ws(s)://<your-host>${WS_PATH}`);
  console.log(`View devices at GET /devices`);
});
