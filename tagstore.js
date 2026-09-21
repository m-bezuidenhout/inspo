/**
 * Where the kinds and tags live.
 *
 * Your images stay ordinary files you can drag around in File Explorer - all in
 * one folder, grouped by tag rather than by directory - so the extra
 * information about them goes in one plain JSON file next to them:
 *
 *     library/tags.json
 *
 * It is readable, editable and git-friendly. If it ever goes missing, nothing
 * breaks - the detector simply works everything out again the next time the
 * library is listed.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 24;

class TagStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, images: {} };
    // Saves are chained onto this promise so two uploads finishing at the same
    // moment can never interleave and write half a file each.
    this.writing = Promise.resolve();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed.images === 'object' && parsed.images) {
        this.data = { version: 1, images: parsed.images };
      }
    } catch {
      // No file yet, or someone hand-edited it into invalid JSON. Either way we
      // start clean rather than refusing to boot.
    }
    return this;
  }

  save() {
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fsp.rename(tmp, this.file); // Atomic, so a crash cannot truncate it.
    });
    return this.writing;
  }

  get(file) {
    return this.data.images[file] || null;
  }

  set(file, entry) {
    this.data.images[file] = entry;
    return entry;
  }

  remove(file) {
    delete this.data.images[file];
  }

  /** Drops entries for files that are no longer on disk. */
  prune(existingKeys) {
    let removed = 0;
    for (const key of Object.keys(this.data.images)) {
      if (!existingKeys.has(key)) {
        delete this.data.images[key];
        removed += 1;
      }
    }
    return removed;
  }

}

/**
 * Tags are meant to be typed quickly and matched reliably, so they are
 * lowercased and stripped of anything that would make two near-identical tags
 * look like different ones.
 */
function normaliseTag(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9 &+#./_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH);
  return clean || null;
}

function normaliseTags(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = normaliseTag(raw);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

module.exports = { TagStore, normaliseTag, normaliseTags, MAX_TAGS, MAX_TAG_LENGTH };
