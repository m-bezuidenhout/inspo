const express = require('express');
const multer = require('multer');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const config = require('./config');
const { KINDS, KIND_IDS, classify } = require('./detect');
const { normaliseTags } = require('./tagstore');
const { LocalBackend, isImage } = require('./backends/local');

const app = express();

// --- Which shelf are we using? ---------------------------------------------

// The local backend is a single shared object: one folder, one tags.json, no
// accounts. The hosted one is scoped to whichever library the person signing in
// belongs to, so it is built per request instead.
const local = config.backend === 'local' ? new LocalBackend(config.libraryDir) : null;

let hosted = null;
if (config.backend === 'supabase') {
  hosted = require('./backends/supabase');
}

/**
 * The backend for this request. Everything below talks to whatever this returns
 * and never asks which it is.
 */
function backendFor(req) {
  if (!config.authRequired) return local;
  return new hosted.SupabaseBackend(config.supabase, {
    libraryId: req.membership.libraryId,
    userId: req.user.id,
  });
}

/**
 * Reads the Supabase access token the page sends and attaches whoever it
 * belongs to. Never rejects on its own - the routes decide what needs a user,
 * so that signing in and the health check stay reachable.
 */
async function identify(req, res, next) {
  if (!config.authRequired) return next();
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    req.user = await hosted.userFromToken(config.supabase, token);
    // Signed in is not the same as allowed in: this is what decides which
    // shared library they are part of, if any.
    req.membership = req.user ? await hosted.resolveMembership(config.supabase, req.user) : null;
  } catch (err) {
    console.error('Could not work out membership:', err.message);
    req.user = null;
    req.membership = null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!config.authRequired) return next();
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!req.membership) {
    return res.status(403).json({
      error: 'You are signed in, but not a member of this library yet. Ask the owner to invite you.',
    });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!config.authRequired) return res.status(400).json({ error: 'Not a hosted library.' });
  if (!req.membership || req.membership.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can do that.' });
  }
  next();
}

// --- Uploads ---------------------------------------------------------------

/**
 * Uploads are staged on disk, not held in memory.
 *
 * Buffering the whole request would mean 40 files at 25 MB each sitting in RAM
 * at once - a gigabyte, on a host that may only have half that. Staging them
 * and reading one at a time keeps the peak at a single file no matter how many
 * were dropped. The staging directory is temporary and wiped after each
 * request, so nothing accumulates.
 */
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
  fileFilter(req, file, cb) {
    cb(null, isImage(file.originalname) || file.mimetype.startsWith('image/'));
  },
});

/**
 * Hands the backend the same shape it always had, except the bytes arrive when
 * asked for rather than all up front. Whoever calls this must call the returned
 * cleanup, or staged files pile up in the temporary directory.
 */
function stagedFiles(files) {
  return {
    files: files.map((file) => ({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      read: () => fsp.readFile(file.path),
    })),
    async cleanUp() {
      await Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => {})));
    },
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Local images are served straight off disk. The hosted backend hands out
// signed URLs instead, so this route simply does not exist there.
if (config.backend === 'local') {
  app.use('/library', express.static(config.libraryDir, { maxAge: '1h' }));
}

app.use(identify);

// --- Reference data --------------------------------------------------------

/**
 * Everything the page needs before it can draw anything: the list of types, and
 * how to sign in when the library is hosted.
 */
app.get('/api/config', (req, res) => {
  res.json({
    kinds: KINDS,
    backend: config.backend,
    authRequired: config.authRequired,
    // Safe to publish: row-level security is what protects the data, not this.
    supabaseUrl: config.authRequired ? config.supabase.url : null,
    supabaseAnonKey: config.authRequired ? config.supabase.anonKey : null,
    signedIn: Boolean(req.user),
    email: req.user ? req.user.email : null,
    role: req.membership ? req.membership.role : null,
    // Signed in but in no library: the page shows "ask to be invited".
    member: Boolean(req.membership),
    // So the page can listen for changes to this library and nothing else.
    // Not a secret: it identifies a library you are already a member of, and
    // row-level security is what decides what you may actually read.
    libraryId: req.membership ? req.membership.libraryId : null,
  });
});

// --- People ----------------------------------------------------------------

app.get('/api/people', requireUser, requireOwner, async (req, res, next) => {
  try {
    res.json({ people: await hosted.listPeople(config.supabase, req.membership.libraryId) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/people', requireUser, requireOwner, async (req, res, next) => {
  try {
    const added = await hosted.invitePerson(
      config.supabase,
      req.membership.libraryId,
      req.user.id,
      (req.body || {}).email
    );
    res.status(201).json(added);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/people/:id', requireUser, requireOwner, async (req, res, next) => {
  try {
    await hosted.removePerson(config.supabase, req.membership.libraryId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Kept so an older page still boots and can tell you to reload.
app.get('/api/kinds', (req, res) => {
  res.json({ kinds: KINDS });
});

/**
 * What the detector WOULD say, without uploading anything. The add-images
 * dialog uses this to show its suggestion before you commit, so the detector
 * stays the single source of truth rather than being reimplemented in the page.
 */
app.post('/api/detect', (req, res) => {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files.slice(0, 40) : [];
  res.json({
    results: files.map((file) => {
      const name = typeof file.name === 'string' ? file.name : '';
      const width = Number(file.width) || 0;
      const height = Number(file.height) || 0;
      return { name, ...classify(name, width, height) };
    }),
  });
});

// --- Images ----------------------------------------------------------------

app.get('/api/images', requireUser, async (req, res, next) => {
  try {
    const backend = backendFor(req);
    const images = await backend.list();
    res.json({
      images,
      facets: facetsFor(images),
      libraryPath: config.backend === 'local' ? config.libraryDir : 'Supabase',
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/images', requireUser, upload.array('images', 40), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No images were uploaded. Only image files are accepted.' });
    }

    // Tags typed on the add-images dialog apply to everything in the batch,
    // which is the whole point of tagging a drop of screenshots at once.
    let tags = [];
    try {
      tags = normaliseTags(JSON.parse(req.body.tags || '[]'));
    } catch {
      tags = [];
    }

    // A type chosen on the dialog overrides the suggestion for the whole batch.
    const kind = KIND_IDS.has(req.body.kind) ? req.body.kind : null;

    const staged = stagedFiles(files);
    try {
      const backend = backendFor(req);
      const added = await backend.add(staged.files, { tags, kind });
      res.status(201).json({ added: added.length, images: added });
    } finally {
      // Even if a backend threw halfway, nothing is left behind on disk.
      await staged.cleanUp();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Changes the type, the tags, or both. Also accepts width/height from the
 * browser for formats the server cannot measure - if the type has not been
 * touched, those dimensions get it re-detected properly.
 */
app.patch('/api/images/:id', requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.kind !== undefined && !KIND_IDS.has(body.kind)) {
      return res.status(400).json({ error: 'Unknown kind.' });
    }

    const backend = backendFor(req);
    const record = await backend.update(req.params.id, {
      kind: body.kind,
      tags: body.tags,
      width: Number(body.width) || 0,
      height: Number(body.height) || 0,
    });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/images/:id', requireUser, async (req, res, next) => {
  try {
    const backend = backendFor(req);
    await backend.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Helpers ---------------------------------------------------------------

/** Kind and tag counts, so the filters can show them. */
function facetsFor(images) {
  const kindCounts = new Map();
  const tagCounts = new Map();

  for (const image of images) {
    kindCounts.set(image.kind, (kindCounts.get(image.kind) || 0) + 1);
    for (const tag of image.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  return {
    kinds: KINDS.filter((k) => kindCounts.has(k.id)).map((k) => ({
      ...k,
      count: kindCounts.get(k.id),
    })),
    tags: [...tagCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

// Hosting platforms poll this to decide whether the app is alive.
app.get('/healthz', (req, res) => res.json({ ok: true, backend: config.backend }));

// --- Errors ----------------------------------------------------------------

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message =
    err.code === 'LIMIT_FILE_SIZE'
      ? 'That image is larger than the 25 MB limit.'
      : err.message || 'Something went wrong.';
  console.error(err);
  res.status(status).json({ error: message });
});

// --- Start -----------------------------------------------------------------

async function start() {
  if (local) {
    const moved = await local.migrateFoldersToTags();
    if (moved > 0) {
      console.log(`  Moved ${moved} image(s) out of folders and tagged them instead.`);
    }
    const merged = await local.migrateSocialToBranding();
    if (merged > 0) {
      console.log(`  Moved ${merged} image(s) from Social into Brand & Social.`);
    }
  }

  const server = app.listen(config.port, () => {
    console.log(`\n  Design Inspiration is running`);
    console.log(`  Open:    http://localhost:${config.port}`);
    console.log(
      config.backend === 'local'
        ? `  Images:  ${config.libraryDir}\n`
        : `  Images:  Supabase (${config.supabase.bucket})\n`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\n  Your inspiration library is ALREADY running in another window.`);
      console.log(`  This window did NOT start a second copy, so you can close it.\n`);
      console.log(`  To just use it:      open http://localhost:${config.port}`);
      console.log(`  To RESTART it:       close the OTHER window first, then run this again.\n`);
      // The older window keeps serving the old code while handing out the
      // updated page from disk, which makes the site look broken. Anyone
      // restarting on purpose is usually here for exactly that reason.
      console.log(`  If the site says "Restart needed" or nothing loads, the other`);
      console.log(`  window is an older version. Close it and start this one again.\n`);
      process.exit(0);
    }
    throw err;
  });
}

start().catch((err) => {
  console.error('Could not start:', err);
  process.exit(1);
});
