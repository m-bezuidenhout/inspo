/**
 * Checks that your .env is wired up correctly, without ever printing a key.
 *
 *     npm run check
 *
 * It tells you which of the four things are wrong - a missing value, a URL
 * that isn't a Supabase project, keys that are the wrong way round, a schema
 * that hasn't been run yet - and says what to do about each.
 */

const config = require('./config');

/** Never print a key. This is enough to tell two keys apart, and no more. */
function fingerprint(key) {
  if (!key) return '(not set)';
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function bad(msg, fix) {
  console.log(`  ✗ ${msg}`);
  if (fix) console.log(`      ${fix}`);
}

async function main() {
  console.log('\n  Checking your Supabase setup\n');

  const { url, anonKey, serviceKey, bucket } = config.supabase;

  // --- 1. Are the values even there? ---------------------------------------

  if (!url) {
    bad('SUPABASE_URL is not set.', 'Copy .env.example to .env and fill it in.');
    return;
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
    bad(`SUPABASE_URL does not look like a project URL: ${url}`, 'It should look like https://abcdefgh.supabase.co');
    return;
  }
  ok(`URL looks right: ${url}`);

  if (!anonKey) bad('SUPABASE_ANON_KEY is not set.');
  else ok(`Anon key present: ${fingerprint(anonKey)}`);

  if (!serviceKey) {
    bad('SUPABASE_SERVICE_ROLE_KEY is not set.', 'Project Settings -> API -> service_role (press Reveal).');
    return;
  }
  ok(`Service key present: ${fingerprint(serviceKey)}`);

  if (anonKey && anonKey === serviceKey) {
    bad('Both keys are the same value.', 'You have pasted one key twice - they are different keys.');
    return;
  }

  // --- 2. Do they actually work? -------------------------------------------

  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const images = await db.from('images').select('id', { count: 'exact', head: true });
  if (images.error) {
    const missing = /does not exist|schema cache/i.test(images.error.message);
    bad(
      `Could not read the images table: ${images.error.message}`,
      missing
        ? 'Run supabase/schema.sql in the SQL Editor, then try again.'
        : 'If this says "Invalid API key", the service_role key is wrong.'
    );
    return;
  }
  ok(`Schema is in place (${images.count || 0} image${images.count === 1 ? '' : 's'} stored).`);

  const buckets = await db.storage.listBuckets();
  if (buckets.error) {
    bad(`Could not list storage buckets: ${buckets.error.message}`);
    return;
  }
  if (!buckets.data.some((b) => b.id === bucket)) {
    bad(
      `No storage bucket called "${bucket}".`,
      'The schema creates it - re-run supabase/schema.sql, or fix SUPABASE_BUCKET in .env.'
    );
    return;
  }
  ok(`Storage bucket "${bucket}" exists.`);

  // The service role key must be able to reach auth, or nobody can sign in.
  const users = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (users.error) {
    bad(
      `The service_role key cannot reach auth: ${users.error.message}`,
      'This usually means the anon key was pasted into SUPABASE_SERVICE_ROLE_KEY.'
    );
    return;
  }
  const count = users.data.users.length;
  ok(`Auth reachable (${count === 0 ? 'no users yet' : 'at least one user'}).`);

  console.log('\n  All good. Start the app and it will use Supabase.');
  if (count === 0) {
    console.log('  Sign in with your own email first - whoever signs in first owns the library.\n');
  } else {
    console.log('');
  }
}

main().catch((err) => {
  console.log(`\n  Something went wrong: ${err.message}\n`);
  process.exit(1);
});
