/**
 * The original backend: images are ordinary files in one folder on your PC,
 * and their tags live in tags.json beside them.
 *
 * This is what runs when nothing is configured, and it needs no account, no
 * network and no database. The id of an image is simply its filename.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { TagStore, normaliseTag, normaliseTags } = require('../tagstore');
const { imageSize } = require('../imagesize');
const { classify } = require('../detect');
const { applyBatch, storageName } = require('./contract');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);

function isImage(file) {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

class LocalBackend {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.store = new TagStore(path.join(dir, 'tags.json')).load();
  }

  get name() {
    return 'local';
  }

  /** A filename nothing else is using, so two files never overwrite each other. */
  freeName(file) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    let candidate = file;
    let n = 2;
    while (fs.existsSync(path.join(this.dir, candidate))) {
      candidate = `${base} (${n})${ext}`;
      n += 1;
    }
    return candidate;
  }

  /** Header-only read, so scanning the library never loads whole images. */
  async detect(file) {
    const size = await imageSize(path.join(this.dir, file));
    const width = size ? size.width : 0;
    const height = size ? size.height : 0;
    const guess = classify(file, width, height);
    return {
      w: width,
      h: height,
      kind: guess.kind,
      auto: guess.kind,
      confidence: guess.confidence,
      why: guess.why,
      tags: [],
    };
  }

  toRecord(file, entry) {
    return {
      id: file.name,
      name: file.name,
      url: `/library/${encodeURIComponent(file.name)}`,
      // Running on your own PC there is only ever one person, so attributing
      // images to anybody would be noise.
      uploadedBy: null,
      uploadedByName: null,
      size: file.size,
      addedAt: file.addedAt,
      width: entry.w,
      height: entry.h,
      kind: entry.kind,
      auto: entry.auto,
      confidence: entry.confidence,
      why: entry.why,
      edited: entry.kind !== entry.auto,
      tags: entry.tags || [],
    };
  }

  async list() {
    const entries = await fsp.readdir(this.dir, { withFileTypes: true });
    const names = entries.filter((e) => e.isFile() && isImage(e.name)).map((e) => e.name);

    const files = await Promise.all(
      names.map(async (name) => {
        const s = await fsp.stat(path.join(this.dir, name));
        return { name, size: s.size, addedAt: s.mtimeMs };
      })
    );
    files.sort((a, b) => b.addedAt - a.addedAt);

    let changed = false;
    const records = [];
    for (const file of files) {
      let entry = this.store.get(file.name);
      if (!entry) {
        entry = this.store.set(file.name, await this.detect(file.name));
        changed = true;
      }
      records.push(this.toRecord(file, entry));
    }

    if (this.store.prune(new Set(files.map((f) => f.name))) > 0) changed = true;
    if (changed) this.store.save();

    return records;
  }

  async add(files, batch) {
    const added = [];
    for (const file of files) {
      const name = this.freeName(storageName(file.originalname));
      // Read one at a time: the whole batch never sits in memory together.
      await fsp.writeFile(path.join(this.dir, name), await file.read());

      // detect() already returns the stored shape (w/h), so the batch choices
      // are folded straight into it rather than through a second shape.
      const entry = this.store.set(name, applyBatch(await this.detect(name), batch));

      added.push({
        id: name,
        name,
        kind: entry.kind,
        confidence: entry.confidence,
        why: entry.why,
        // The browser measures anything we could not read (AVIF, mostly) and
        // sends it back, which is what this flag asks it to do.
        needsSize: entry.w === 0,
      });
    }
    await this.store.save();
    return added;
  }

  async update(id, changes) {
    const file = path.basename(id);
    if (!isImage(file)) throw Object.assign(new Error('Invalid request.'), { status: 400 });
    if (!fs.existsSync(path.join(this.dir, file))) {
      throw Object.assign(new Error('Image not found.'), { status: 404 });
    }

    const entry = this.store.get(file) || (await this.detect(file));

    if (changes.width > 0 && changes.height > 0 && !entry.w) {
      entry.w = Math.round(changes.width);
      entry.h = Math.round(changes.height);
      if (entry.kind === entry.auto) {
        const guess = classify(file, entry.w, entry.h);
        entry.kind = guess.kind;
        entry.auto = guess.kind;
        entry.confidence = guess.confidence;
        entry.why = guess.why;
      }
    }

    if (changes.kind !== undefined) {
      entry.kind = changes.kind;
      if (entry.kind !== entry.auto) {
        entry.confidence = 'high';
        entry.why = 'set by you';
      }
    }

    if (changes.tags !== undefined) entry.tags = normaliseTags(changes.tags);

    this.store.set(file, entry);
    await this.store.save();

    const s = await fsp.stat(path.join(this.dir, file));
    return this.toRecord({ name: file, size: s.size, addedAt: s.mtimeMs }, entry);
  }

  async remove(id) {
    const file = path.basename(id);
    if (!isImage(file)) throw Object.assign(new Error('Invalid request.'), { status: 400 });
    const target = path.join(this.dir, file);
    if (!fs.existsSync(target)) throw Object.assign(new Error('Image not found.'), { status: 404 });
    await fsp.unlink(target);
    this.store.remove(file);
    await this.store.save();
    return true;
  }

  /**
   * "Social" and "Branding" used to be separate types and are now one. Anything
   * still carrying the old id is moved across, including the `auto` field - the
   * detector will never say "social" again, so a stale auto would make every
   * such image look manually overridden forever.
   *
   * Safe to run on every boot; once nothing says "social" it does nothing.
   */
  async migrateSocialToBranding() {
    let moved = 0;
    for (const entry of Object.values(this.store.data.images)) {
      if (entry.kind === 'social') {
        entry.kind = 'branding';
        moved += 1;
      }
      if (entry.auto === 'social') entry.auto = 'branding';
    }
    if (moved > 0) await this.store.save();
    return moved;
  }

  /**
   * The library used to file images into folders on disk. Tags do that job now,
   * so anything still in a subfolder is moved up and gains its old folder name
   * as a tag - the grouping survives, the folder does not. Nothing is deleted:
   * only empty directories are tidied away afterwards.
   *
   * Safe to run on every boot; once the library is flat it does nothing.
   */
  async migrateFoldersToTags() {
    const entries = await fsp.readdir(this.dir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 0) return 0;

    let moved = 0;
    for (const dir of dirs) {
      const from = path.join(this.dir, dir.name);
      const tag = normaliseTag(dir.name);

      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        if (!entry.isFile() || !isImage(entry.name)) continue;

        const target = this.freeName(entry.name);
        await fsp.rename(path.join(from, entry.name), path.join(this.dir, target));

        const old = this.store.data.images[`${dir.name}/${entry.name}`];
        const record = old || (await this.detect(target));
        record.tags = normaliseTags([...(record.tags || []), tag]);
        this.store.set(target, record);
        delete this.store.data.images[`${dir.name}/${entry.name}`];
        moved += 1;
      }

      await fsp.rmdir(from).catch(() => {});
    }

    // Leftover folder-shaped keys belonged to files that are no longer there.
    for (const key of Object.keys(this.store.data.images)) {
      if (key.includes('/')) delete this.store.data.images[key];
    }

    if (moved > 0) await this.store.save();
    return moved;
  }
}

module.exports = { LocalBackend, isImage };
