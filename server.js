// server.js
const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');      // extracted game folders
const TMP_DIR = path.join(__dirname, 'tmp');             // multer temp
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // keep uploaded games 24h

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();

// Multer config - accept only .zip and limit size
const storage = multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => {
  const name = Date.now() + '-' + file.originalname;
  cb(null, name);
}});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype;
    // allow .zip files only
    if (ext === '.zip' || mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// Serve uploader UI
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'uploader.html')));

// Serve uploaded games at /play/<id>/...
app.use('/play', express.static(UPLOAD_DIR, {
  index: false,
  extensions: ['html']
}));

// Upload endpoint
app.post('/upload', upload.single('gamezip'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const id = uuidv4();
    const outDir = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(outDir, { recursive: true });

    // Unzip with safety: prevent zip-slip (reject entries with .. or absolute paths)
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(req.file.path)
        .pipe(unzipper.Parse());

      stream.on('entry', async entry => {
        const entryPath = entry.path.replace(/\\/g, '/'); // normalize
        // Reject absolute paths or parent traversal attempts
        if (entryPath.includes('..') || path.isAbsolute(entryPath)) {
          entry.autodrain();
          return;
        }
        // compute destination path
        const destPath = path.join(outDir, entryPath);
        const destDir = path.dirname(destPath);
        // ensure directory
        fs.mkdirSync(destDir, { recursive: true });

        if (entry.type === 'Directory') {
          entry.autodrain();
        } else {
          entry.pipe(fs.createWriteStream(destPath));
        }
      });

      stream.on('close', resolve);
      stream.on('error', reject);
    });

    // cleanup tmp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    // Validate presence of index.html at root or in nested folder (we allow root/index.html)
    // If index.html is not present at root, attempt to find first index.html in the extracted tree and move/copy it to root
    const walk = (dir) => {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const f of files) {
        const full = path.join(dir, f.name);
        if (f.isFile() && f.name.toLowerCase() === 'index.html') return full;
        if (f.isDirectory()) {
          const found = walk(full);
          if (found) return found;
        }
      }
      return null;
    };

    const foundIndex = walk(outDir);
    if (!foundIndex) {
      // cleanup
      fs.rmSync(outDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'ZIP must include an index.html file' });
    }

    // If index isn't at the root of outDir, keep structure but it's okay; we will give user the path
    // Compute relative index path
    const relIndex = path.relative(outDir, foundIndex).split(path.sep).join('/');
    const playUrl = `/play/${id}/${relIndex}`;

    // Respond with playable URL and info
    res.json({
      id,
      playUrl,
      message: 'Upload successful. Use the playUrl to open the game.'
    });

  } catch (err) {
    console.error('Upload error', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// Simple API to list recent uploads (optional)
app.get('/recent', (req, res) => {
  const items = fs.readdirSync(UPLOAD_DIR).map(name => {
    try {
      const stat = fs.statSync(path.join(UPLOAD_DIR, name));
      return { id: name, mtime: stat.mtimeMs, url: `/play/${name}/index.html` };
    } catch (e) { return null; }
  }).filter(Boolean).sort((a,b)=> b.mtime - a.mtime).slice(0, 50);
  res.json(items);
});

// Cleanup old uploads periodically
setInterval(() => {
  try {
    const now = Date.now();
    for (const id of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, id);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > MAX_AGE_MS) {
        console.log('Removing old upload', id);
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  } catch (e) {
    console.error('Cleanup error', e);
  }
}, 60 * 60 * 1000); // every hour

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Upload games (zip containing index.html) at POST /upload`);
});
