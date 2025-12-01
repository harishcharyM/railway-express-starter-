
const express = require('express');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Railway Express Starter';

// Logs requests
app.use(morgan('dev'));

// Serves static assets from /public
app.use(express.static(path.join(__dirname, 'public')));

// Home
app.get('/', (req, res) => {
  res.send(`<!doctype html> ... <h1>🚄 ${APP_NAME}</h1> ...`);
});

// Health check (used by Railway)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', env: process.env.NODE_ENV || 'unknown' });
});

// Sample API
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from Railway Express Starter!' });
});

