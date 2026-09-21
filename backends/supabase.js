/**
 * The hosted backend: image bytes live in a Supabase Storage bucket, and
 * everything the detector worked out lives in a Postgres row beside them.
 *
 * Why a table rather than the tags.json this app started with: a hosted app has
 * no disk it can rely on between deploys, and two browser tabs saving at the
 * same moment would race to rewrite one file. Postgres solves both, and lets
 * several people share one library without standing on each other.
 *
 * Run `supabase/schema.sql` once against your project to create everything.
 */

const { createClient } = require('@supabase/supabase-js');

const { normaliseTags } = require('../tagstore');
const { classify } = require('../detect');
const { describe, applyBatch, storageName } = require('./contract');

const TABLE = 'images';

// The bucket is private, so every image is served through a time-limited signed
// URL rather than a guessable public one. An hour is comfortably longer than a
// browsing session; reloading the page mints fresh ones.
const URL_TTL_SECONDS = 60 * 60;

/**
 * Who is in each library, so images can say who added them.
 *
 * Emails live in Supabase's auth schema, which cannot be joined against from a
 * normal query - it takes one admin call per person. That is fine for a handful
 * of members but not per image, so the roster is fetched once and held briefly.
 */
const rosterCache = new Map();
const ROSTER_TTL_MS = 60 * 1000;

async function roster(db, libraryId) {
  const cached = rosterCache.get(libraryId);
  if (cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.people;

  const people = new Map();
  const members = await db.from('memberships').select('user_id').eq('library_id', libraryId);
  if (!members.error) {
    await Promise.all(
      members.data.map(async (m) => {
        const { data } = await db.auth.admin.getUserById(m.user_id);
        if (data && data.user) people.set(m.user_id, data.user.email || 'someone');
      })
    );
  }

  rosterCache.set(libraryId, { at: Date.now(), people });
  return people;
}

/** Forgets the cached roster, after someone joins or leaves. */
function forgetRoster(libraryId) {
  rosterCache.delete(libraryId);
}

class SupabaseBackend {
  /**
   * Scoped to a library, not a person: everyone in it works on the same pile.
   * The server holds the service role key, which bypasses row-level security,
   * so this scoping has to be explicit here as well as enforced by the policies
   * in schema.sql - belt and braces, since a bug here would cross libraries.
   */
  constructor({ url, serviceKey, bucket }, { libraryId, userId }) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false } });
    this.bucket = bucket;
    this.libraryId = libraryId;
    this.userId = userId;
  }

  get name() {
    return 'supabase';
  }

  /** Turns a database row into the record shape the rest of the app expects. */
  toRecord(row, url, people) {
    const email = row.uploaded_by && people ? people.get(row.uploaded_by) : null;
    return {
      id: row.id,
      name: row.name,
      url,
      uploadedBy: row.uploaded_by || null,
      // The person may have left the library since, so this can be unknown.
      uploadedByName: email || (row.uploaded_by ? 'former member' : null),
      size: row.size_bytes,
      addedAt: new Date(row.created_at).getTime(),
      width: row.width,
      height: row.height,
      kind: row.kind,
      auto: row.auto_kind,
      confidence: row.confidence,
      why: row.why,
      edited: row.kind !== row.auto_kind,
      tags: row.tags || [],
    };
  }

  async list() {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('library_id', this.libraryId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Could not read your library: ${error.message}`);
    if (data.length === 0) return [];

    // One round trip for every URL rather than one per image.
    const paths = data.map((row) => row.storage_path);
    const signed = await this.db.storage.from(this.bucket).createSignedUrls(paths, URL_TTL_SECONDS);
    if (signed.error) throw new Error(`Could not link your images: ${signed.error.message}`);

    const urls = new Map(signed.data.map((s) => [s.path, s.signedUrl]));
    const people = await roster(this.db, this.libraryId);
    return data.map((row) => this.toRecord(row, urls.get(row.storage_path) || '', people));
  }

  /** A fresh signed URL for one image. */
  async signOne(storagePath) {
    const { data, error } = await this.db.storage
      .from(this.bucket)
      .createSignedUrl(storagePath, URL_TTL_SECONDS);
    if (error) throw new Error(error.message);
    return data.signedUrl;
  }

  async add(files, batch) {
    const added = [];

    for (const file of files) {
      const name = storageName(file.originalname);
      // Each library's files sit under its own prefix, so a storage policy can
      // be written against the path with the same test as the table.
      const storagePath = `${this.libraryId}/${Date.now()}-${name}`;

      // Read one at a time: the whole batch never sits in memory together.
      const bytes = await file.read();

      const upload = await this.db.storage
        .from(this.bucket)
        .upload(storagePath, bytes, { contentType: file.mimetype, upsert: false });
      if (upload.error) throw new Error(`Could not store ${name}: ${upload.error.message}`);

      const entry = applyBatch(describe(name, bytes), batch);

      const { data, error } = await this.db
        .from(TABLE)
        .insert({
          library_id: this.libraryId,
          uploaded_by: this.userId,
          name,
          storage_path: storagePath,
          size_bytes: bytes.length,
          width: entry.width,
          height: entry.height,
          kind: entry.kind,
          auto_kind: entry.auto,
          confidence: entry.confidence,
          why: entry.why,
          tags: entry.tags,
        })
        .select()
        .single();

      if (error) {
        // Don't leave bytes behind that nothing points at.
        await this.db.storage.from(this.bucket).remove([storagePath]);
        throw new Error(`Could not save ${name}: ${error.message}`);
      }

      added.push({
        id: data.id,
        name: data.name,
        kind: data.kind,
        confidence: data.confidence,
        why: data.why,
        needsSize: data.width === 0,
      });
    }

    return added;
  }

  async update(id, changes) {
    const existing = await this.db
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('library_id', this.libraryId)
      .maybeSingle();

    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) throw Object.assign(new Error('Image not found.'), { status: 404 });

    const row = existing.data;
    const patch = {};

    if (changes.width > 0 && changes.height > 0 && !row.width) {
      patch.width = Math.round(changes.width);
      patch.height = Math.round(changes.height);
      if (row.kind === row.auto_kind) {
        const guess = classify(row.name, patch.width, patch.height);
        patch.kind = guess.kind;
        patch.auto_kind = guess.kind;
        patch.confidence = guess.confidence;
        patch.why = guess.why;
      }
    }

    if (changes.kind !== undefined) {
      patch.kind = changes.kind;
      if (patch.kind !== (patch.auto_kind || row.auto_kind)) {
        patch.confidence = 'high';
        patch.why = 'set by you';
      }
    }

    if (changes.tags !== undefined) patch.tags = normaliseTags(changes.tags);

    const { data, error } = await this.db
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('library_id', this.libraryId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return this.toRecord(data, await this.signOne(data.storage_path), await roster(this.db, this.libraryId));
  }

  async remove(id) {
    const { data, error } = await this.db
      .from(TABLE)
      .select('storage_path')
      .eq('id', id)
      .eq('library_id', this.libraryId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw Object.assign(new Error('Image not found.'), { status: 404 });

    // Row first: an orphaned file wastes space, but an orphaned row shows the
    // user an image that will not load.
    const del = await this.db.from(TABLE).delete().eq('id', id).eq('library_id', this.libraryId);
    if (del.error) throw new Error(del.error.message);

    await this.db.storage.from(this.bucket).remove([data.storage_path]);
    return true;
  }
}

/**
 * Checks the access token a browser sends and returns who it belongs to.
 * Returns null for anything it cannot verify, which the routes treat as
 * "not signed in" rather than as an error.
 */
async function userFromToken({ url, serviceKey }, token) {
  if (!token) return null;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

function admin({ url, serviceKey }) {
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

// A page load fires several requests at once, and on a brand-new project every
// one of them would find no library and set about creating one. Sharing a
// single in-flight resolution per person stops that at the source.
const resolving = new Map();

/**
 * Works out which shared library this person is in.
 *
 * Three cases, in order:
 *   1. They are already a member  -> that library.
 *   2. Someone invited their email -> join it, and spend the invite.
 *   3. No library exists at all    -> they are first; create it, they own it.
 *
 * Anyone else gets null, which the page turns into "ask to be invited". That
 * matters: with sign-ups accidentally left on, a stranger must land nowhere
 * rather than in somebody's library.
 */
function resolveMembership(config, user) {
  const inFlight = resolving.get(user.id);
  if (inFlight) return inFlight;

  const work = resolveMembershipOnce(config, user).finally(() => resolving.delete(user.id));
  resolving.set(user.id, work);
  return work;
}

async function resolveMembershipOnce(config, user) {
  const db = admin(config);

  const mine = await db
    .from('memberships')
    .select('library_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (mine.error) throw new Error(mine.error.message);
  if (mine.data) return { libraryId: mine.data.library_id, role: mine.data.role };

  const email = (user.email || '').toLowerCase();
  if (email) {
    const invite = await db
      .from('invites')
      .select('library_id')
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (invite.error) throw new Error(invite.error.message);

    if (invite.data) {
      const join = await db
        .from('memberships')
        .insert({ library_id: invite.data.library_id, user_id: user.id, role: 'member' });
      if (join.error) throw new Error(join.error.message);
      await db.from('invites').delete().eq('email', email).eq('library_id', invite.data.library_id);
      forgetRoster(invite.data.library_id);
      return { libraryId: invite.data.library_id, role: 'member' };
    }
  }

  const any = await db.from('libraries').select('id').limit(1).maybeSingle();
  if (any.error) throw new Error(any.error.message);
  if (any.data) return null; // A library exists, but not for them.

  const created = await db.from('libraries').insert({}).select().single();
  if (created.error) throw new Error(created.error.message);

  // Two server processes have no shared lock, so settle it in the database:
  // whichever library is oldest wins, and a loser tidies up after itself. An
  // empty library that nobody joined is safe to remove.
  const all = await db.from('libraries').select('id').order('created_at', { ascending: true }).limit(1);
  const winner = !all.error && all.data[0] ? all.data[0].id : created.data.id;

  if (winner !== created.data.id) {
    await db.from('libraries').delete().eq('id', created.data.id);
  }

  const owner = await db
    .from('memberships')
    .upsert(
      { library_id: winner, user_id: user.id, role: 'owner' },
      { onConflict: 'library_id,user_id' }
    );
  if (owner.error) throw new Error(owner.error.message);

  return { libraryId: winner, role: 'owner' };
}

/** Everyone in the library, plus anyone invited who has not arrived yet. */
async function listPeople(config, libraryId) {
  const db = admin(config);

  const members = await db
    .from('memberships')
    .select('user_id, role, created_at')
    .eq('library_id', libraryId);
  if (members.error) throw new Error(members.error.message);

  // Emails live in auth, which has no foreign key we can join against.
  const people = await Promise.all(
    members.data.map(async (m) => {
      const { data } = await db.auth.admin.getUserById(m.user_id);
      return {
        id: m.user_id,
        email: data && data.user ? data.user.email : '(unknown)',
        role: m.role,
        joined: true,
      };
    })
  );

  const invited = await db.from('invites').select('email, created_at').eq('library_id', libraryId);
  if (invited.error) throw new Error(invited.error.message);

  return [
    ...people,
    ...invited.data.map((i) => ({ id: i.email, email: i.email, role: 'member', joined: false })),
  ];
}

async function invitePerson(config, libraryId, invitedBy, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Object.assign(new Error('That does not look like an email address.'), { status: 400 });
  }

  const db = admin(config);
  const { error } = await db
    .from('invites')
    .upsert({ email, library_id: libraryId, invited_by: invitedBy }, { onConflict: 'email,library_id' });
  if (error) throw new Error(error.message);
  return { email };
}

/** Removes a member, or withdraws an invite that was never taken up. */
async function removePerson(config, libraryId, id) {
  const db = admin(config);
  if (id.includes('@')) {
    const { error } = await db.from('invites').delete().eq('email', id).eq('library_id', libraryId);
    if (error) throw new Error(error.message);
    return true;
  }

  // Never leave a library with nobody who can invite.
  const owners = await db
    .from('memberships')
    .select('user_id')
    .eq('library_id', libraryId)
    .eq('role', 'owner');
  if (owners.error) throw new Error(owners.error.message);
  if (owners.data.length === 1 && owners.data[0].user_id === id) {
    throw Object.assign(new Error('That is the only owner, so they cannot be removed.'), {
      status: 400,
    });
  }

  const { error } = await db
    .from('memberships')
    .delete()
    .eq('library_id', libraryId)
    .eq('user_id', id);
  if (error) throw new Error(error.message);
  forgetRoster(libraryId);
  return true;
}

module.exports = {
  SupabaseBackend,
  forgetRoster,
  userFromToken,
  resolveMembership,
  listPeople,
  invitePerson,
  removePerson,
};
