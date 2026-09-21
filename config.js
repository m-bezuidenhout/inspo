/**
 * Which backend the library runs on.
 *
 * Nothing here is required. With no configuration at all the library behaves
 * exactly as it always has: images in a folder on your PC, tags in a JSON file
 * beside them, no account needed. Setting the Supabase variables switches it to
 * the hosted backend instead - same app, same detector, different shelf.
 */

require('dotenv').config();

const path = require('path');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

// The service role key bypasses row-level security, so it must never reach the
// browser. The anon key is safe to hand out - RLS is what protects the data.
const useSupabase = Boolean(supabaseUrl && serviceKey);

if (supabaseUrl && !serviceKey) {
  console.warn(
    '\n  SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not.\n' +
      '  Falling back to local files. See .env.example.\n'
  );
}

module.exports = {
  backend: useSupabase ? 'supabase' : 'local',
  port: Number(process.env.PORT) || 4300,

  // Local backend
  libraryDir: path.join(__dirname, 'library'),

  // Supabase backend
  supabase: {
    url: supabaseUrl,
    serviceKey,
    anonKey,
    bucket: (process.env.SUPABASE_BUCKET || 'inspiration').trim(),
  },

  // Auth is only meaningful on the hosted backend; running on your own PC there
  // is nobody to authenticate against.
  authRequired: useSupabase,
};
