
// server.js
// MQTT broker (Aedes) over WebSockets + HTTP UI:
// - Landing page "/" with links to /devices and /control (open in new tab)
// - /devices: auto-refreshing table showing device status (online/offline)
// - /control: per-device toggle + manual command; publishes "<device>:<on|off>" to MQTT
// - /api/devices: JSON list of devices
// - /api/command: publish a command to MQTT (devices/command)
// - /health: health endpoint
//
// MQTT topics:
// - Ingest: "devices/status"
//   Payload preferred: JSON { "device": "Device-01", "status": "online", "ts": <epochMillis> }
//   Fallback: "Device-01,online" or "Device-01:online"
// - Commands (host->device): "devices/command"
//   Payload: "<device>:<on|off>"
//
// NOTE: In-memory registry resets on restart/redeploy. For persistence, use Redis/Postgres.

require('dotenv').config();

const http   = require('http');      // Core HTTP
const ws     = require('ws');        // WebSocket server
const aedes  = require('aedes')();   // MQTT broker
const morgan = require('morgan');    // HTTP request logger (middleware style)

const PORT          = process.env.PORT || 3000;      // Railway injects PORT
const WS_PATH       = '/mqtt';
const COMMAND_TOPIC = process.env.COMMAND_TOPIC || 'devices/command';

// Auto-offline logic: mark device as offline if stale
const STALE_MS = Number(process.env.STALE_MS || 30000); // default 30s

// ---------------- In-memory device registry ----------------
// deviceStatus: {
//   [deviceName]: {
//     status: 'online'|'offline'|string,
//     firstSeen: ISOString,
//     lastSeen: ISOString,   // last incoming message time
     // updatedAt: ISOString  // last time we changed "status" (incoming or auto-offline)
     // }
// }
const deviceStatus = Object.create(null);

// Helpers
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
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

// Ingest device status messages
aedes.on('publish', (packet, client) => {
  // Only handle client-origin publishes (skip broker-origin)
  if (!client) return;

  const topic      = packet?.topic || '';
  const payloadStr = packet?.payload ? packet.payload.toString() : '';

  if (topic === 'devices/status') {
    let device, status, ts;

    // Try JSON first
    try {
      const obj = JSON.parse(payloadStr);
      device = String(obj.device || '').trim();
      status = String(obj.status || '').trim();
      ts     = obj.ts;
    } catch {
      // Fallback: "Device-01,online" or "Device-01:online"
      const parts = payloadStr.split(/[,:]/).map(s => s.trim());
      if (parts.length >= 2) {
        device = parts[0];
        status = parts[1];
      }
    }

    if (device && status) {
      const nowIso = new Date(ts ? Number(ts) : Date.now()).toISOString();
      if (!deviceStatus[device]) {
        // Append new device
        deviceStatus[device] = {
          status, firstSeen: nowIso, lastSeen: nowIso, updatedAt: nowIso
        };
      } else {
        // Update existing
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
// Every 5s, mark any device "offline" if (now - lastSeen) > STALE_MS.
// We DO NOT delete devices; they remain listed.
setInterval(() => {
  const now = Date.now();
  for (const [name, info] of Object.entries(deviceStatus)) {
    const last = Date.parse(info.lastSeen || info.updatedAt || info.firstSeen || new Date().toISOString());
    const stale = isNaN(last) ? true : (now - last > STALE_MS);
    if (stale && info.status !== 'offline') {
      info.status    = 'offline';
      info.updatedAt = new Date().toISOString();
      // lastSeen remains the time of the last incoming message
    }
  }
}, 5000);

// ---------------- HTTP server (with Morgan wrapper) ----------------
const logger = morgan('dev');

const server = http.createServer((req, res) => {
  // Let Morgan log first; provide a no-op next for plain http
  logger(req, res, async () => {

    // Util: read JSON body for POST /api/command
    async function readJsonBody() {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({});
          }
        });
      });
    }

    // -------- Landing page "/" (links open in new tab) --------
    if (req.method === 'GET' && req.url === '/') {
      const html =
`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Main Host • Dashboard</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    main { max-width: 720px; margin: 0 auto; }
    h1   { margin-bottom: 0.5rem; }
    p    { color: #666; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 1rem; }
    .card {
      border: 1px solid #ddd; border-radius: 8px; padding: 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .card h2 { margin: 0; font-size: 1.2rem; }
    .card p  { margin: 0; font-size: 0.95rem; color: #555; }
    .card a {
      align-self: flex-start;
      display: inline-block; padding: 6px 12px; border-radius: 6px;
      background: #0b78ff; color: #fff; text-decoration: none;
    }
    .card a:hover { background: #075fcc; }
    .muted { color: #777; font-size: 0.9rem; }
    code { background: #0001; padding: 2px 4px; border-radius: 4px; }
    ul { margin-top: 1rem; }
    ul li { margin: 4px 0; }
  </style>
</head>
<body>
  <main>
    <h1>Main Host</h1>
    <p class="muted">Use the links below. Each opens in a <strong>new tab</strong>.</p>
    <div class="grid">
      <div class="card">
        <h2>Devices</h2>
        <p>Live device table (auto-refresh every 5s). Shows <code>online/offline</code> based on last seen.</p>
        /devicesOpen Devices</a>
      </div>
      <div class="card">
        <h2>Control</h2>
        <p>Send <code>&lt;device&gt;:&lt;on|off&gt;</code> commands via toggle per device or manual input.</p>
        <a href="/control" target="_blank" rel="  </div>

    <h3>Quick endpoints</h3>
    <ul>
      <li>/health/health</a></li>
      <li><a href="/api/devices" target="_blank" rel="
    <p class="muted">MQTT WebSocket endpoint: <code>ws(s)://&lt;host&gt;${WS_PATH}</code></p>
  </main>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // -------- Health --------
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', staleMs: STALE_MS, commandTopic: COMMAND_TOPIC }));
      return;
    }

    // -------- Devices API --------
    if (req.method === 'GET' && req.url === '/api/devices') {
      const items = Object.entries(deviceStatus).map(([name, info]) => ({
        device: name,
        status: info.status,
        updatedAt: info.updatedAt,
        lastSeen:  info.lastSeen,
        firstSeen: info.firstSeen
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, count: items.length }));
      return;
    }

    // -------- Command API: { device, status } -> publish "<device>:<on|off>" --------
    if (req.method === 'POST' && req.url === '/api/command') {
      const body   = await readJsonBody();
      const device = String(body.device || '').trim();
      const status = String(body.status || '').trim().toLowerCase(); // 'on'|'off'

      if (!device || !status || !['on', 'off'].includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid device/status. Expected { device, status: "on"|"off" }' }));
        return;
      }

      const payload = `${device}:${status}`;
      aedes.publish({ topic: COMMAND_TOPIC, payload, qos: 0, retain: false }, (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Publish failed', details: err.message }));
        } else {
          console.log(`[HOST->MQTT] command published -> ${COMMAND_TOPIC}: ${payload}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, topic: COMMAND_TOPIC, payload }));
        }
      });
      return;
    }

    // -------- Devices UI (auto-refresh every 5s) --------
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
    <p>/controlOpen Control</a></p>
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
    function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
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

    // -------- Control UI (toggle per device + manual send) --------
    if (req.method === 'GET' && req.url === '/control') {
      const html =
`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Device Control</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; max-width: 980px; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f3f3f3; text-align: left; }
    .muted { color: #666; font-size: 0.9rem; }
    .toggle { width: 50px; height: 24px; }
    .row-controls { display: flex; gap: 8px; align-items: center; }
    #msg { margin-top: 1rem; color: #175217; }
    #err { margin-top: 1rem; color: #6d1111; }
    a.button { display:inline-block; padding:8px 14px; background:#0b78ff; color:#fff; border-radius:6px; text-decoration:none; }
    a.button:hover { background:#075fcc; }
  </style>
</head>
<body>
  <main>
    <h1>Device Control</h1>
    <p class="muted">Toggle <strong>On/Off</strong> next to a device and click <strong>Send</strong>. Payload format: <code>device_name:on|off</code></p>
    <p>/devicesOpen Devices</a></p>
    <table id="tbl">
      <thead><tr><th>Device</th><th>Current Status</th><th>Control</th><th>Action</th></tr></thead>
      <tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody>
    </table>

    <h2>Manual Command</h2>
    <div class="row-controls">
      <input type="text" id="manual-device" placeholder="Device name" />
      <label><input type="checkbox" id="manual-toggle" /> On</label>
      <button id="manual-send">Send</button>
    </div>

    <div id="msg"></div><div id="err"></div>
  </main>
  <script>
    function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    async function loadTable() {
      const tbody = document.getElementById('rows');
      try {
        const res = await fetch('/api/devices', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4">No devices yet. Publish to <code>devices/status</code> to register.</td></tr>';
          return;
        }
        var htmlRows = '';
        for (var i = 0; i < items.length; i++) {
          var x = items[i];
          var dev = escapeHtml(x.device || '');
          var st  = String(x.status || '').toLowerCase();
          var checked = (st === 'on' || st === 'online') ? 'checked' : '';
          var id = 'toggle_' + dev.replace(/[^a-zA-Z0-9_-]/g, '_');
          htmlRows += '<tr>'
                   + '<td>' + dev + '</td>'
                   + '<td>' + escapeHtml(x.status || '') + '</td>'
                   + '<td><label><input type="checkbox" class="toggle" id="' + id + '" ' + checked + '> On</label></td>'
                   + '<td><button data-device="' + dev + '" data-toggle-id="' + id + '" class="send-btn">Send</button></td>'
                   + '</tr>';
        }
        tbody.innerHTML = htmlRows;

        // Wire buttons
        var buttons = document.getElementsByClassName('send-btn');
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].addEventListener('click', async function(e) {
            var device = this.getAttribute('data-device');
            var tid    = this.getAttribute('data-toggle-id');
            var checked = document.getElementById(tid).checked;
            await sendCommand(device, checked ? 'on' : 'off');
          });
        }
      } catch (e) {
        console.error('Load error:', e);
        tbody.innerHTML = '<tr><td colspan="4">Error loading. Check console.</td></tr>';
      }
    }

    async function sendCommand(device, status) {
      var msg = document.getElementById('msg');
      var err = document.getElementById('err');
      msg.textContent = ''; err.textContent = '';
      try {
        const res = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device: device, status: status })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        msg.textContent = 'Sent: ' + data.payload + ' (topic: ' + data.topic + ')';
      } catch (e) {
        console.error('Send error:', e);
        err.textContent = 'Failed: ' + e.message;
      }
    }

    document.getElementById('manual-send').addEventListener('click', async function() {
      var device = document.getElementById('manual-device').value.trim();
      var status = document.getElementById('manual-toggle').checked ? 'on' : 'off';
      if (!device) { alert('Enter device name'); return; }
      await sendCommand(device, status);
    });

    loadTable();
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // -------- 404 fallback --------
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
});

// ---------------- WebSocket endpoint for MQTT ----------------
constconst wss = new ws.Server({ server, path: WS_PATH });
wss.on('connection', (socket) => {
  const stream = ws.createWebSocketStream(socket);
  aedes.handle(stream);
});

// Start server
server.listen(PORT, () => {
  console.log(`Broker + UI listening on PORT=${PORT}`);
  console.log('WS MQTT endpoint: ws(s)://<your-host>' + WS_PATH);
  console.log('Landing: GET / • Status: GET /devices • Control: GET /control • Health: GET /health')
});
