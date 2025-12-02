
// server.js
// MQTT broker (Aedes) over WebSockets + HTTP UI with an in-memory device registry.
// Devices are appended when first seen, kept forever, and auto-marked OFFLINE if stale.
//
// Endpoints:
// - GET  /              : Info
// - GET  /health        : Health check
// - GET  /devices       : Auto-refreshing HTML table (every 5s)
// - GET  /api/devices   : JSON { items: [{device,status,updatedAt,lastSeen,firstSeen}], count }
// WebSocket MQTT endpoint: ws(s)://<host>/mqtt
//
// MQTT messages:
// - Topic: "devices/status"
// - Payload JSON: { "device": "Device-01", "status": "online", "ts": 1733055000000 }
//   (Fallback plain: "Device-01,online")

require('dotenv').config();

const http   = require('http');
const ws     = require('ws');
const aedes  = require('aedes')();
const morgan = require('morgan');

const PORT    = process.env.PORT || 3000;
const WS_PATH = '/mqtt';

// ---- Auto-offline threshold ----
// If a device hasn't sent in STALE_MS, it is marked "offline".
const STALE_MS = Number(process.env.STALE_MS || 30000); // 30s default

// ---------------- In-memory device registry ----------------
// deviceStatus: {
//   [deviceName]: {
//     status: 'online' | 'offline' | string,
//     firstSeen: ISOString,
//     lastSeen: ISOString,
//     updatedAt: ISOString  // last time we updated "status" (could be same as lastSeen or when marked offline)
//   }
// }
const deviceStatus = Object.create(null);

// Helper: escape HTML
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  if (!client) return; // skip broker-origin

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
      const nowIso = new Date(ts ? Number(ts) : Date.now()).toISOString();
      // Append if new, else update
      if (!deviceStatus[device]) {
        deviceStatus[device] = {
          status,            // as sent by the device ("online"/"offline"/etc.)
          firstSeen: nowIso, // first time we ever saw this device
          lastSeen:  nowIso, // last message time
          updatedAt: nowIso  // last time we updated status field
        };
      } else {
        deviceStatus[device].status    = status;
        deviceStatus[device].lastSeen  = nowIso;
        deviceStatus[device].updatedAt = nowIso;
      }

      console.log(`[MQTT] ${client.id} -> devices/status: ${device} = ${status}`);
    } else {
      console.warn(`[MQTT] devices/status payload ignored (bad format): ${payloadStr}`);
    }
  }
});

// ---------------- Auto-offline background task ----------------
// Every 5 seconds, mark any stale device as "offline"
// (we DO NOT delete devices; they remain listed)
setInterval(() => {
  const now = Date.now();
  for (const [name, info] of Object.entries(deviceStatus)) {
    const last = Date.parse(info.lastSeen || info.updatedAt || info.firstSeen || new Date().toISOString());
    const stale = isNaN(last) ? true : (now - last > STALE_MS);
    if (stale && info.status !== 'offline') {
      info.status    = 'offline';
      info.updatedAt = new Date().toISOString();
      // Note: we do not change lastSeen here; lastSeen remains the time of the last incoming message.
    }
  }
}, 5000);

// ---------------- HTTP server: UI + API + health ----------------
const server = http.createServer((req, res) => {
  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', staleMs: STALE_MS }));
    return;
  }

  // JSON API
  if (req.method === 'GET' && req.url === '/api/devices') {
    const items = Object.entries(deviceStatus).map(([name, info]) => ({
      device:    name,
      status:    info.status,
      updatedAt: info.updatedAt,
      lastSeen:  info.lastSeen,
      firstSeen: info.firstSeen
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json'
      // If UI is on another host, you can enable CORS:
      // ,'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ items, count: items.length }));
    return;
  }

  // UI (auto-refresh every 5s)
  if (req.method === 'GET' && req.url === '/devices') {
    const html =
`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Device Live Status</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; max-width: 980px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f3f3f3; text-align: left; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 0.9rem; }
    .online  { background: #d5f5d5; color: #175217; }
    .offline { background: #ffd7d7; color: #6d1111; }
    .unknown { background: #eee;    color: #333; }
    .muted { color: #666; font-size: 0.9rem; }
    code { background: #0001; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Device Live Status</h1>
    <p class="muted">Auto-refreshes every 5 seconds • Stale threshold: ${STALE_MS} ms</p>
    <table id="tbl">
      <thead>
        <tr>
          <th>Device</th>
          <th>Status</th>
          <th>Last Update (UTC)</th>
          <th>Last Seen (UTC)</th>
          <th>First Seen (UTC)</th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="5">Loading…</td></tr></tbody>
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
          tbody.innerHTML = '<tr><td colspan="5">No devices yet. Publish to topic <code>devices/status</code> to register.</td></tr>';
          return;
        }

        var htmlRows = '';
        for (var i = 0; i < items.length; i++) {
          var x   = items[i];
          var dev = escapeHtml(x.device || '');
          var st  = String(x.status || '').toLowerCase();
          var cls = (st === 'online') ? 'online' : ((st === 'offline') ? 'offline' : 'unknown');
          var upd = escapeHtml(x.updatedAt || '');
          var lst = escapeHtml(x.lastSeen || '');
          var fst = escapeHtml(x.firstSeen || '');
          htmlRows += '<tr>'
                   + '<td>' + dev + '</td>'
                   + '<td><span class="badge ' + cls + '">' + escapeHtml(x.status || '') + '</span></td>'
                   + '<td>' + upd + '</td>'
                   + '<td>' + lst + '</td>'
                   + '<td>' + fst + '</td>'
                   + '</tr>';
        }
        tbody.innerHTML = htmlRows;
      } catch (e) {
        console.error('Load error:', e);
        var tbody = document.getElementById('rows');
        tbody.innerHTML = '<tr><td colspan="5">Error loading. Check console.</td></tr>';
      }
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Info page
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(
      'MQTT WebSocket broker running. Connect via ws(s)://<host>' + WS_PATH + '\n' +
      'Publish device status to topic "devices/status" with JSON payload:\n' +
      '{"device":"Device-01","status":"online","ts":<epochMillis>}\n' +
      'UI: GET /devices • API: GET /api/devices • Health: GET /health\n' +
      'Stale threshold (auto-offline): ' + STALE_MS + ' ms\n'
    );
    return;
  }

  // 404
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
  console.log(`WS  console.log(`WS MQTT endpoint: ws(s)://<your-host>${WS_PATH}`);
  console.log(`View devices at GET /devices`);
