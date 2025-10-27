const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const shell = require('shelljs');

const app = express();
const PORT = 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BUILD_DIR = path.join(__dirname, 'builds');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR);

const upload = multer({ dest: UPLOAD_DIR });

// Serve static files
app.use('/downloads', express.static(BUILD_DIR));

// Upload ZIP
app.post('/upload', upload.single('gamezip'), async (req, res) => {
  if (!req.file) return res.status(400).send({ error: 'No file uploaded' });

  const id = uuidv4();
  const tmpDir = path.join(UPLOAD_DIR, id);
  fs.mkdirSync(tmpDir);

  // Unzip uploaded game
  await fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: tmpDir }))
    .promise();

  // Remove original zip
  fs.unlinkSync(req.file.path);

  // Check index.html exists
  if (!fs.existsSync(path.join(tmpDir, 'index.html'))) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return res.status(400).send({ error: 'ZIP must contain index.html' });
  }

  // Create build folder
  const buildPath = path.join(BUILD_DIR, id);
  fs.mkdirSync(buildPath);

  // Copy to Capacitor www folder
  const wwwPath = path.join(__dirname, 'www');
  shell.rm('-rf', wwwPath + '/*');
  shell.cp('-R', tmpDir + '/*', wwwPath);

  // Android build
  console.log('Building Android APK...');
  if (shell.exec('npx cap sync android').code !== 0) {
    return res.status(500).send({ error: 'Capacitor sync failed' });
  }
  // APK path (debug)
  const apkPath = path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apkPath)) return res.status(500).send({ error: 'APK not built yet. Open Android Studio and build.' });

  // Copy APK to builds folder
  const apkDest = path.join(buildPath, 'app-debug.apk');
  shell.cp(apkPath, apkDest);

  // iOS project preparation
  shell.exec('npx cap sync ios');
  // iOS IPA cannot be auto-signed without Xcode & Apple Dev account
  const iosProject = path.join(__dirname, 'ios');
  shell.cp('-R', iosProject, path.join(buildPath, 'ios-project'));

  return res.send({
    message: 'Build ready',
    apk: `/downloads/${id}/app-debug.apk`,
    iosProject: `/downloads/${id}/ios-project`
  });
});

// Simple upload form
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'uploader.html'));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
