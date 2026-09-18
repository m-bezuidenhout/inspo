const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4300;
const LIBRARY = path.join(__dirname, 'library');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);

fs.mkdirSync(LIBRARY, { recursive: true });

/**
 * Turns whatever the user typed into a safe folder name that can never escape
 * the library directory. Returns null if nothing usable is left.
 */
function safeFolderName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

function folderPath(name) {
  const safe = safeFolderName(name);
  if (!safe) return null;
  const full = path.join(LIBRARY, safe);
  // Belt and braces: the resolved path must still sit inside the library.
  if (path.dirname(full) !== LIBRARY) return null;
  return full;
}

function isImage(file) {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

async function listImages(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && isImage(e.name));
  const stats = await Promise.all(
    files.map(async (e) => {
      const s = await fsp.stat(path.join(dir, e.name));
      return { name: e.name, size: s.size, addedAt: s.mtimeMs };
    })
  );
  return stats.sort((a, b) => b.addedAt - a.addedAt);
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = folderPath(req.params.folder);
    if (!dir) return cb(new Error('Invalid folder name'));
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .slice(0, 40) || 'inspiration';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    cb(null, `${stamp}__${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
  fileFilter(req, file, cb) {
    cb(null, isImage(file.originalname) || file.mimetype.startsWith('image/'));
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/library', express.static(LIBRARY, { maxAge: '1h' }));

// --- Folders ---------------------------------------------------------------

app.get('/api/folders', async (req, res, next) => {
  try {
    const entries = await fsp.readdir(LIBRARY, { withFileTypes: true });
    const folders = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const images = await listImages(path.join(LIBRARY, e.name));
          return {
            name: e.name,
            count: images.length,
            cover: images[0] ? `/library/${encodeURIComponent(e.name)}/${encodeURIComponent(images[0].name)}` : null,
            updatedAt: images[0] ? images[0].addedAt : 0,
          };
        })
    );
    folders.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ folders, libraryPath: LIBRARY });
  } catch (err) {
    next(err);
  }
});

app.post('/api/folders', async (req, res, next) => {
  try {
    const name = safeFolderName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'Please give the folder a name.' });
    const dir = folderPath(name);
    if (fs.existsSync(dir)) return res.status(409).json({ error: `"${name}" already exists.` });
    await fsp.mkdir(dir, { recursive: true });
    res.status(201).json({ name });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/folders/:folder', async (req, res, next) => {
  try {
    const dir = folderPath(req.params.folder);
    if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'Folder not found.' });
    const images = await listImages(dir);
    if (images.length > 0) {
      return res.status(409).json({ error: 'Delete the images inside it first.' });
    }
    await fsp.rmdir(dir);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Images ----------------------------------------------------------------

app.get('/api/folders/:folder/images', async (req, res, next) => {
  try {
    const dir = folderPath(req.params.folder);
    if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'Folder not found.' });
    const images = await listImages(dir);
    res.json({
      images: images.map((img) => ({
        ...img,
        url: `/library/${encodeURIComponent(req.params.folder)}/${encodeURIComponent(img.name)}`,
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/folders/:folder/images', upload.array('images', 40), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No images were uploaded. Only image files are accepted.' });
  }
  res.status(201).json({ added: files.length });
});

app.delete('/api/folders/:folder/images/:file', async (req, res, next) => {
  try {
    const dir = folderPath(req.params.folder);
    const file = path.basename(req.params.file);
    if (!dir || !isImage(file)) return res.status(400).json({ error: 'Invalid request.' });
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Image not found.' });
    await fsp.unlink(target);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Errors ----------------------------------------------------------------

app.use((err, req, res, next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  const message =
    err.code === 'LIMIT_FILE_SIZE'
      ? 'That image is larger than the 25 MB limit.'
      : err.message || 'Something went wrong.';
  console.error(err);
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  console.log(`\n  Design Inspiration is running`);
  console.log(`  Open:    http://localhost:${PORT}`);
  console.log(`  Images:  ${LIBRARY}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Your inspiration library is ALREADY running in another window.`);
    console.log(`  Nothing is broken - just open http://localhost:${PORT}\n`);
    console.log(`  (To restart it instead, close the other window first.)\n`);
    process.exit(0);
  }
  throw err;
});
