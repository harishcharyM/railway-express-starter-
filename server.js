
const express = require('express');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Welcome to my World --> HaRiSh';

app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send(`<h1>${APP_NAME}</h1><ul><li>/health/health</a></li><li>/api/hello/api/hello</a></li></ul>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/hello', (req, res) => res.json({ message: 'Deployed the host!' }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
