
const http = require('http');
const ws = require('ws');
const aedes = require('aedes')();
const morgan = require('morgan');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// ---------------- In-memory store ----------------
const messages = []; // [{ msg: string, at: ISOString }]
const MAX_ITEMS = 500;

// Escape HTML helper
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- Forward from MQTT to /simply ----------------
// If you want to forward client messages, you can do it locally instead of POSTing out.
// We'll just push them into `messages` right here.
aedes.on('publish', (packet, client) => {
  if (!client) return; // only client-origin messages
  const payloadStr = packet?.payload ? packet.payload.toString() : '';
  messages.push({ msg: payloadStr, at: new Date().toISOString() });
  if (messages.length > MAX_ITEMS) messages.shift();
  console.log(`[MQTT] ${client.id} -> ${packet.topic}: ${payloadStr}`);
});

// ---------------- HTTP server ----------------
const server = http.createServer((req, res) => {
  // Simple logger (optional)
  // (If you had morgan wired via server.on('request', morgan('dev')), keep that).
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // Render all messages
  if (req.method === 'GET' && req.url === '/simply') {
    const list = messages
      .map(item => `<li><code>${escapeHtml(item.msg)}</code> <small>${item.at}</small></li>`)
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Broadcast Messages</title>
  <style>
    body{font-family:system-ui;margin:2rem}
    ul{list-style:disc;padding-left:1.2rem}
    code{background:#0001;padding:2px 4px;border-radius:4px}
    small{color:#666;margin-left:8px}
    .empty{color:#999}
  </style>
</head>
<body>
  <main>
    <h1>Broadcast Messages</h1>
    ${messages.length === 0
      ? '<p class="empty">No messages yet. Waiting for MQTT publishes…</p>'
      : `<ul>${list}</ul>`}
  </main>
</body>
</html>`);
  }

  // Accept external POST /simply { message: "..." } if you still want to push from another service
  if (req.method === 'POST' && req.url === '/simply') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const msg = (json.message || '').trim();
        if (!msg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid message' }));
        }
        messages.push({ msg, at: new Date().toISOString() });
        if (messages.length > MAX_ITEMS) messages.shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: messages.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  // Default info page
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('MQTT WebSocket broker is running. Connect via ws(s)://<host>/mqtt\nView messages at /simply');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------- WS endpoint for MQTT ----------------
const wss = new ws.Server({ server, path: '/mqtt' });
wss.on('connection', (socket) => {
  const stream = ws.createWebSocketStream(socket);
  aedes.handle(stream);
});

// Optional HTTP request logging
server.on('request', morgan('dev'));

server.listen(PORT, () => {
  console.log(`Broker + HTTP UI listening on PORT=${PORT}`);
  console.log(`WS MQTT endpoint: ws(s)://<your-host>/mqtt`);
  console.log(`View messages at GET /simply`);
});
