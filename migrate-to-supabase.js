/**
 * Copies the images sitting in your local library up into Supabase, keeping
 * their types and tags.
 *
 *     npm run migrate
 *
 * Copies, never moves: the files on your PC are not touched, so if anything
 * goes wrong the local library is still exactly as it was. Running it twice is
 * safe - anything already up there by the same name is skipped.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const config = require('./config');
const { TagStore } = require('./tagstore');
const { imageSizeFromBuffer } = require('./imagesize');
const { classify } = require('./detect');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);

const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

async function main() {
  if (config.backend !== 'supabase') {
    console.log('\n  No Supabase settings found in .env, so there is nowhere to copy to.\n');
    process.exit(1);
  }

  const dir = config.libraryDir;
  const db = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  });

  // Which library, and who to credit the images to.
  const lib = await db.from('libraries').select('id').order('created_at').limit(1).maybeSingle();
  if (lib.error) throw new Error(lib.error.message);
  if (!lib.data) {
    console.log('\n  No library exists yet. Sign in to the app once, then run this again.\n');
    process.exit(1);
  }
  const libraryId = lib.data.id;

  const owner = await db
    .from('memberships')
    .select('user_id')
    .eq('library_id', libraryId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();
  const uploadedBy = owner.data ? owner.data.user_id : null;

  const files = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);

  if (files.length === 0) {
    console.log('\n  Nothing in the local library to copy.\n');
    return;
  }

  const store = new TagStore(path.join(dir, 'tags.json')).load();

  const already = await db.from('images').select('name').eq('library_id', libraryId);
  if (already.error) throw new Error(already.error.message);
  const have = new Set(already.data.map((r) => r.name));

  console.log(`\n  Copying ${files.length} image(s) into Supabase\n`);

  let copied = 0;
  let skipped = 0;

  for (const name of files) {
    if (have.has(name)) {
      console.log(`  - ${name}  (already there, skipped)`);
      skipped += 1;
      continue;
    }

    const buffer = await fsp.readFile(path.join(dir, name));
    const entry = store.get(name);

    // Fall back to detecting it fresh if tags.json has no record of it.
    const size = imageSizeFromBuffer(buffer);
    const guess = classify(name, size ? size.width : 0, size ? size.height : 0);
    const record = entry || {
      w: size ? size.width : 0,
      h: size ? size.height : 0,
      kind: guess.kind,
      auto: guess.kind,
      confidence: guess.confidence,
      why: guess.why,
      tags: [],
    };

    const storagePath = `${libraryId}/${Date.now()}-${name}`;
    const up = await db.storage
      .from(config.supabase.bucket)
      .upload(storagePath, buffer, {
        contentType: TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
        upsert: false,
      });
    if (up.error) {
      console.log(`  ! ${name}  (could not upload: ${up.error.message})`);
      continue;
    }

    const row = await db.from('images').insert({
      library_id: libraryId,
      uploaded_by: uploadedBy,
      name,
      storage_path: storagePath,
      size_bytes: buffer.length,
      width: record.w,
      height: record.h,
      kind: record.kind,
      auto_kind: record.auto,
      confidence: record.confidence,
      why: record.why,
      tags: record.tags || [],
    });

    if (row.error) {
      // Don't leave bytes behind that nothing points at.
      await db.storage.from(config.supabase.bucket).remove([storagePath]);
      console.log(`  ! ${name}  (could not save: ${row.error.message})`);
      continue;
    }

    const shown = name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+__/, '');
    const tags = (record.tags || []).length ? `  [${record.tags.join(', ')}]` : '';
    console.log(`  + ${shown}  ${record.kind}${tags}`);
    copied += 1;
  }

  console.log(`\n  Copied ${copied}, skipped ${skipped}. Your local files are untouched.\n`);
}

main().catch((err) => {
  console.error(`\n  Migration failed: ${err.message}\n`);
  process.exit(1);
});
