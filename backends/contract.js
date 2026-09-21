/**
 * What every backend has to provide.
 *
 * The library can keep its images in a folder on your PC or in Supabase, and
 * the rest of the app must not be able to tell which. Everything above this
 * line - the detector, the routes, the page - works in terms of the record
 * shape below and nothing else.
 *
 * A backend implements:
 *
 *   list()                        -> [record]      newest first
 *   add(files, { tags, kind })    -> [addedRecord] files: [{ originalname, buffer }]
 *   update(id, changes)           -> record        changes: { kind?, tags?, width?, height? }
 *   remove(id)                    -> true
 *
 * `id` is whatever the backend uses to find an image again - a filename on
 * disk, a row id in Postgres. Nothing outside the backend may assume which.
 *
 * A record is:
 *
 *   {
 *     id, name,          // name is for display; id is for addressing
 *     url,               // something an <img src> can load
 *     uploadedBy,        // who added it, or null where there are no accounts
 *     uploadedByName,    // their email, for showing and filtering
 *     size, addedAt,     // bytes, epoch ms
 *     width, height,     // 0 when we could not measure it
 *     kind, auto,        // current type, and what the detector originally said
 *     confidence, why,   // 'high' | 'low', and a short human reason
 *     edited,            // kind !== auto, i.e. a person overruled the detector
 *     tags,              // string[]
 *   }
 */

const { classify } = require('../detect');
const { imageSizeFromBuffer } = require('../imagesize');

/**
 * Runs the detector over a file's bytes. Shared by every backend so the rules
 * live in exactly one place no matter where the image is stored.
 */
function describe(filename, buffer) {
  const size = imageSizeFromBuffer(buffer);
  const width = size ? size.width : 0;
  const height = size ? size.height : 0;
  const guess = classify(filename, width, height);
  return {
    width,
    height,
    kind: guess.kind,
    auto: guess.kind, // Remembered so a manual change is never silently undone.
    confidence: guess.confidence,
    why: guess.why,
  };
}

/**
 * Applies the dialog's batch choices to a freshly detected record. A type the
 * user picked is certain by definition, so it is marked as theirs.
 */
function applyBatch(detected, { tags = [], kind = null } = {}) {
  const record = { ...detected, tags };
  if (kind) {
    record.kind = kind;
    if (record.kind !== record.auto) {
      record.confidence = 'high';
      record.why = 'set by you';
    }
  }
  return record;
}

/** The filename an upload is stored under: sortable, unique-ish, readable. */
function storageName(originalname) {
  const path = require('path');
  const ext = path.extname(originalname).toLowerCase() || '.png';
  const base =
    path
      .basename(originalname, path.extname(originalname))
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .slice(0, 40) || 'inspiration';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}__${base}${ext}`;
}

module.exports = { describe, applyBatch, storageName };
