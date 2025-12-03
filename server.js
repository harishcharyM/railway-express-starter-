
// server.js (with login/auth)
// MQTT broker (Aedes) + WebSockets + HTTP UI + Cookie-based login

require('dotenv').config();

const http   = require('http');
const ws     = require('ws');
const aedes  = require('aedes')();
const morgan = require('morgan');
const crypto = require('crypto');

// ---------- Config ----------
const PORT            = process.env.PORT ?? 3000;
const WS_PATH         = '/mqtt';
const COMMAND_TOPIC   = process.env.COMMAND_TOPIC ?? 'devices/command';
const STALE_MS        = Number(process.env.STALE_MS ?? 30000);
const ADMIN_USER      = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS      = process.env.ADMIN_PASS ?? 'Harish@123'; // change me!
const SESSION_SECRET  = process.env.SESSION_SECRET ?? 'Harish@123';
const SESSION_MAX_AGE = Number(process.env.SESSION_MAX_AGE_MS ?? 8 * 60 * 60 * 1000); // 8h
const COOKIE_SECURE   = String(process.env.COOKIE_SECURE ?? 'false') === 'true';

// ---------- Device registry ----------
const deviceStatus = Object.create(null);

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeId(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, '_');
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = Object.create(null);
  if (!header) return out;
  const parts = header.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}
function setCookie(res, name, value, options = {}) {
  const attrs = [];
  attrs.push(`${name}=${encodeURIComponent(value)}`);
  attrs.push('Path=/');
  attrs.push('HttpOnly');
  attrs.push('SameSite=Lax');
  if (COOKIE_SECURE) attrs.push('Secure');
  if (options.maxAge != null) attrs.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.expires) attrs.push(`Expires=${options.expires.toUTCString()}`);
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
}
function sign(b64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
}
function makeSession(username) {
  const payload = { u: username, exp: Date.now() + SESSION_MAX_AGE };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(b64);
  return `${b64}.${sig}`;
}
function checkSession(token) {
  if (!token) return null;
  const [b64, sig] = String(token).split('.');
  if (!b64 || !sig) return null;
  if (sign(b64) !== sig) return null;
  try {
    const obj = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj.u;
  } catch {
    return null;
  }
}
async function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body ?? '{}')); }
      catch { resolve({}); }
    });
  });
}
async function readFormBody(req) {
  // application/x-www-form-urlencoded
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      resolve(obj);
    });
  });
}

// ---------- MQTT events ----------
aedes.on('client', (client) => {
  console.log(`[MQTT] client connected: ${client?.id ?? '(no-id)'}`);
});
aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT] client disconnected: ${client?.id ?? '(no-id)'}`);
});
aedes.on('subscribe', (subs, client) => {
  const topics = Array.isArray(subs) ? subs.map(s => s.topic).join(', ') : String(subs);
  console.log(`[MQTT] ${client?.id} subscribed: ${topics}`);
});
aedes.on('publish', (packet, client) => {
  // Only handle client-origin publishes
  if (!client) return;
  const topic = packet?.topic ?? '';
  const payloadStr = packet?.payload ? packet.payload.toString() : '';

  if (topic === 'devices/status') {
    let device, status, ts;
    try {
      const obj = JSON.parse(payloadStr);
      device = String(obj.device ?? '').trim();
      status = String(obj.status ?? '').trim();
      ts = obj.ts;
    } catch {
      const parts = payloadStr.split(/[,:]/).map(s => s.trim());
      if (parts.length >= 2) {
        device = parts[0];
        status = parts[1];
      }
    }

    if (device && status) {
      const nowIso = new Date(ts ? Number(ts) : Date.now()).toISOString();
      if (!deviceStatus[device]) {
        deviceStatus[device] = { status, firstSeen: nowIso, lastSeen: nowIso, updatedAt: nowIso };
      } else {
        deviceStatus[device].status = status;
        deviceStatus[device].lastSeen = nowIso;
        deviceStatus[device].updatedAt = nowIso;
      }
      console.log(`[MQTT] ${client.id} -> devices/status: ${device} = ${status}`);
    } else {
      console.warn(`[MQTT] devices/status payload ignored (bad format): ${payloadStr}`);
    }
  }
});

// ---------- Auto-offline ----------
setInterval(() => {
  const now = Date.now();
  for (const [name, info] of Object.entries(deviceStatus)) {
    const last = Date.parse(info.lastSeen ?? info.updatedAt ?? info.firstSeen ?? new Date().toISOString());
    const stale = isNaN(last) ? true : (now - last > STALE_MS);
    if (stale && info.status !== 'offline') {
      info.status = 'offline';
      info.updatedAt = new Date().toISOString();
    }
  }
}, 5000);

// ---------- HTTP server ----------
const logger = morgan('dev');
const server = http.createServer((req, res) => {
  logger(req, res, async () => {

    // Parse URL
    let urlObj;
    try {
      urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      urlObj = { pathname: req.url, searchParams: new URLSearchParams() };
    }
    const pathname = urlObj.pathname;

    // ---- Authentication gate (protect everything except /login and /health) ----
    const cookies = parseCookies(req);
    const user = checkSession(cookies.sid);
    const isPublic = (pathname === '/login' || pathname === '/health');

    if (!user && !isPublic) {
      // Redirect to login with ?next=
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(req.url)}` });
      res.end();
      return;
    }

    // ---------- LOGIN (GET) ----------
    if (req.method === 'GET' && pathname === '/login') {
      const errMsg = urlObj.searchParams.get('error') ?? '';
      const next = urlObj.searchParams.get('next') ?? '/';
      const html =
`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Login • Main Host</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    main { max-width: 440px; margin: 0 auto; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
    .row { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    label { font-weight: 600; }
    input[type="text"], input[type="password"] { padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
    button { padding: 10px 14px; border: none; border-radius: 6px; background: #0b78ff; color: #fff; cursor: pointer; }
    button:hover { background: #075fcc; }
    .err { color: #6d1111; margin-top: 8px; }
    .muted { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in</h1>
    <p class="muted">Use your admin credentials to access Devices & Control.</p>
    <div class="card">
      /login
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <div class="row">
          <label for="user">Username</label>
          <input id="user" name="user" type="text" autocomplete="username" required />
        </div>
        <div class="row">
          <label for="pass">Password</label>
          <input id="pass" name="pass" type="password" autocomplete="current-password" required />
        </div>
        <div class="row">
          <button type="submit">Login</button>
        </div>
        ${errMsg ? `<div class="err">${escapeHtml(errMsg)}</div>` : ''}
      </form>
    </div>
    <p class="muted" style="margin-top:12px;">MQTT WebSocket endpoint: <code>ws(s)://&lt;host&gt;${WS_PATH}</code></p>
  </main>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ---------- LOGIN (POST) ----------
    if (req.method === 'POST' && pathname === '/login') {
      const form = await readFormBody(req);
      const next = String(form.next ?? '/');
      const userIn = String(form.user ?? '').trim();
      const passIn = String(form.pass ?? '').trim();
      console.log("entering userIn and Password ");
      if (userIn === ADMIN_USER && passIn === ADMIN_PASS) {
        console.log("userIn and Password matched");
        const token = makeSession(userIn);
        setCookie(res, 'sid', token, { maxAge: SESSION_MAX_AGE });
        res.writeHead(302, { Location: next });
        res.end();
        return;
      } else {
        console.log("userIn and Password Not matched");
        res.writeHead(302, { Location: `/login?error=${encodeURIComponent('Invalid credentials')}&next=${encodeURIComponent(next)}` });
        res.end();
        return;
      }
    }

    // ---------- LOGOUT ----------
    if (req.method === 'GET' && pathname === '/logout') {
      clearCookie(res, 'sid');
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    // ---------- Health ----------
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', staleMs: STALE_MS, commandTopic: COMMAND_TOPIC }));
      return;
    }

    // ---------- Landing (protected) ----------
    if (req.method === 'GET' && pathname === '/') {
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
    h1 { margin-bottom: 0.5rem; }
    p { color: #666; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 1rem; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
    .card h2 { margin: 0; font-size: 1.2rem; }
    .card p { margin: 0; font-size: 0.95rem; color: #555; }
    .card a { align-self: flex-start; display: inline-block; padding: 6px 12px; border-radius: 6px; background: #0b78ff; color: #fff; text-decoration: none; }
    .card a:hover { background: #075fcc; }
    .row { display:flex; gap:8px; align-items:center; margin-top: 12px; }
    .muted { color: #777; font-size: 0.9rem; }
    code { background: #0001; padding: 2px 4px; border-radius: 4px; }
    ul { margin-top: 1rem; }
    ul li { margin: 4px 0; }
  </style>
</head>
<body>
  <main>
    <h1>Welcome <strong>${escapeHtml(user)}</strong></h1>
    <p class="muted">Click a card or the button to open the page.</p>

    <div class="grid">
      /devices
        <h2>Devices</h2>
        <p>Live device table (auto-refresh every 5s). Shows <code>online/offline</code> based on last seen.</p>
        /devicesOpen Devices</a>
      </div>

      /control
        <h2>Control</h2>
        <p>Send <code>&lt;device&gt;:&lt;on/off&gt;</code> commands via toggle per device or manual input.</p>
        /controlOpen Control</a>
      </div>
    </div>

    <h3>Quick endpoints</h3>
    <ul>
      <li>/health/health</a></li>
      <li>/api/devices/api/devices</a></li>
    </ul>

    <div class="row">
      /logoutLogout</a>
      <span class="muted">MQTT WebSocket endpoint: <code>ws(s)://&lt;host&gt;${WS_PATH}</code></span>
    </div>
  </main>

  <script>
    // Make entire card clickable (same tab)
    document.querySelectorAll('.card[data-href]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName.toLowerCase() === 'a') return;
        const href = card.getAttribute('data-href');
        if (href) window.location.href = href;
      });
    });
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ---------- Devices API (protected) ----------
    if (req.method === 'GET' && pathname === '/api/devices') {
      const items = Object.entries(deviceStatus).map(([name, info]) => ({
        device: name,
        status: info.status,
        updatedAt: info.updatedAt,
        lastSeen: info.lastSeen,
        firstSeen: info.firstSeen
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, count: items.length }));
      return;
    }

    // ---------- Command API (protected) ----------
    if (req.method === 'POST' && pathname === '/api/command') {
      const body = await readJsonBody(req);
      const device = String(body.device ?? '').trim();
      const status = String(body.status ?? '').trim().toLowerCase(); // 'on'|'off'

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

    // ---------- Devices UI (protected) ----------
    if (req.method === 'GET' && pathname === '/devices') {
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
    .online { background: #d5f5d5; color: #175217; }
    .offline { background: #ffd7d7; color: #6d1111; }
    .unknown { background: #eee; color: #333; }
    .muted { color: #666; font-size: 0.9rem; }
    code { background: #0001; padding: 2px 4px; border-radius: 4px; }
    a.button { display:inline-block; padding:8px 14px; background:#0b78ff; color:#fff; border-radius:6px; text-decoration:none; }
    a.button:hover { background:#075fcc; }
  </style>
</head>
<body>
  <main>
    <h1>Device Live Status</h1>
    <p class="muted">Auto-refreshes every 5 seconds • Stale threshold: ${STALE_MS} ms</p>
    <p>/controlOpen Control</a> • /Home</a> • /logoutLogout</a></p>

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
          var x = items[i];
          var dev = escapeHtml(x.device ?? '');
          var st = String(x.status ?? '').toLowerCase();
          var cls = (st === 'online') ? 'online' : ((st === 'offline') ? 'offline' : 'unknown');
          var upd = escapeHtml(x.updatedAt ?? '');
          var lst = escapeHtml(x.lastSeen ?? '');
          var fst = escapeHtml(x.firstSeen ?? '');
          htmlRows += '<tr>'
            + '<td>' + dev + '</td>'
            + '<td><span class="badge ' + cls + '">' + escapeHtml(x.status ?? '') + '</span></td>'
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

    // ---------- Control UI (protected) ----------
    if (req.method === 'GET' && pathname === '/control') {
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
    <p class="muted">Toggle <strong>On/Off</strong> next to a device and click <strong>Send</strong>. Payload: <code>device_name:on|off</code></p>
    <p>/devicesOpen Devices</a> • /Home</a> • /logoutLogout</a></p>

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
          var dev = escapeHtml(x.device ?? '');
          var st = String(x.status ?? '').toLowerCase();
          var checked = (st === 'on' || st === 'online') ? 'checked' : '';
          var id = 'toggle_' + dev.replace(/[^a-zA-Z0-9_\-]/g, '_');
          htmlRows += '<tr>'
            + '<td>' + dev + '</td>'
            + '<td>' + escapeHtml(x.status ?? '') + '</td>'
            + '<td><label><input type="checkbox" class="toggle" id="' + id + '" ' + checked + '> On</label></td>'
            + '<td><button data-device="' + dev + '" data-toggle-id="' + id + '" class="send-btn">Send</button></td>'
            + '</tr>';
        }
        tbody.innerHTML = htmlRows;

        var buttons = document.getElementsByClassName('send-btn');
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].addEventListener('click', async function(e) {
            var device = this.getAttribute('data-device');
            var tid = this.getAttribute('data-toggle-id');
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
        if (!res.ok || !data.ok) throw new Error(data.error ?? ('HTTP ' + res.status));
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

    // ---------- 404 ----------
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
});

// ---------- WebSocket endpoint for MQTT ----------
const wss = new ws.Server({ server, path: WS_PATH });
wss.on('connection', (socket) => {
  const stream = ws.createWebSocketStream(socket);
  aedes.handle(stream);
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`Broker + UI + Login listening on PORT=${PORT}`);
  console.log('WS MQTT endpoint: ws(s)://<your-host>' + WS_PATH);
  console.log('Landing: GET / • Status: GET /devices • Control: GET /control • Health: GET /health • Login: GET/POST /login • Logout: GET /logout');
});
