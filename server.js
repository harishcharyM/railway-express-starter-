
const express = require('express');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

let appName = process.env.APP_NAME || 'Railway Node Root Starter';

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Home page with form
app.get('/', (req, res) => {
  res.send(`<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName}</title>
    /styles.css
  </head>
  <body>
    <main>
      <h1>${appName}</h1>
      <form id="name-form">
        <label for="appName">Set project name:</label>
        <input id="appName" name="appName" type="text" value="${appName}" required />
        <button type="submit">Update</button>
      </form>
      <p>Links:</p>
      <ul>
        <li>/health/health</a></li>
        <li>/api/hello/api/hello</a></li>
      </ul>
      /app.js</script>
    </main>
  </body>
  </html>`);
});

// Endpoint to update name (in-memory)
app.post('/set-name', (req, res) => {
  const { appName: newName } = req.body || {};
  if (typeof newName !== 'string' || !newName.trim()) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  appName = newName.trim();
  return res.json({ ok: true, appName });
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Sample API
app.get('/api/hello', (req, res) => res.json({ message: `Hello from ${appName}!` }));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

