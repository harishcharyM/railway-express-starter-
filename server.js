
// Minimal MQTT broker over WebSockets
// Works on Railway: binds to process.env.PORT and serves MQTT over ws://<host>/mqtt

require('dotenv').config();
const http = require('http');
const ws = require('ws');
const morgan = require('morgan');
const aedes = require('aedes')();

const PORT = process.env.PORT || 3000;

// Basic logging for broker events
aedes.on('client', (client) => {
  console.log(`[MQTT] Client connected: ${client ? client.id : '(no-id)'}`);
});
aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT] Client disconnected: ${client ? client.id : '(no-id)'}`);
});
aedes.on('subscribe', (subs, client) => {
  console.log(`[MQTT] ${client && client.id} subscribed: ${subs.map(s => s.topic).join(', ')}`);
});
aedes.on('publish', (packet, client) => {
  if (client) {
    console.log(`[MQTT] ${client.id} published to ${packet.topic}: ${packet.payload.toString()}`);
  }
});

// Create an HTTP server (required for WebSocket)
const server = http.createServer((req, res) => {
  // Optional: health endpoint for Railway
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  // Simple info page
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MQTT WebSocket broker running. Connect via ws(s)://<your-host>/mqtt');
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// Attach WebSocket server at path /mqtt and wire to Aedes
const wss = new ws.Server({ server, path: '/mqtt' });
wss.on('connection', function connection(wsClient) {
  const stream = ws.createWebSocketStream(wsClient);
  aedes.handle(stream);
});

// Optional logging for HTTP requests via morgan-like
server.on('request', morgan('dev'));

server.listen(PORT, () => {
  console.log(`HTTP/WebSocket server listening on PORT=${PORT}`);
  console.log(`WebSocket MQTT endpoint: ws(s)://<your-host>/mqtt`);
});
