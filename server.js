
const fs = require('fs');
const path = require('path');
const multer = require('multer');
// ensure uploads dir
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, file.originalname) // keep original name
});
const upload = multer({ storage });

// upload API (field name: 'file')
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `/files/${encodeURIComponent(req.file.filename)}`;
  res.json({ ok: true, filename: req.file.filename, size: req.file.size, url: fileUrl });
});

// serve uploaded files
app.get('/files/:filename', (req, res) => {
  const filePath = path.join(uploadsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});
