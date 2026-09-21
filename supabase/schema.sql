-- Design Inspiration - Supabase schema
--
-- Run this once against your project: Supabase dashboard -> SQL Editor -> New
-- query -> paste -> Run. It is safe to run again; everything is idempotent.
--
-- The model: ONE shared library that several people work in together. Everyone
-- who is a member sees the same images, tags and types, and can add to them.
-- Membership is what grants access - not ownership of individual rows.
--
--   libraries     the shared pool itself
--   memberships   who is in it, and whether they can invite others
--   invites       emails allowed to join but who have not signed in yet
--   images        everything the detector worked out, one row per image

-- ------------------------------------------------------------------ tables

create table if not exists public.libraries (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'Design Inspiration',
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  library_id uuid not null references public.libraries (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- 'owner' can invite and remove people; 'member' can only use the library.
  role       text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (library_id, user_id)
);

-- Someone invited before they have ever signed in has no user id yet, so the
-- claim is held against their email until they arrive.
create table if not exists public.invites (
  email      text not null,
  library_id uuid not null references public.libraries (id) on delete cascade,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (email, library_id)
);

create table if not exists public.images (
  id           uuid primary key default gen_random_uuid(),
  library_id   uuid not null references public.libraries (id) on delete cascade,
  -- Kept for interest and attribution; it grants nothing on its own.
  uploaded_by  uuid references auth.users (id) on delete set null,

  name         text not null,
  storage_path text not null unique,
  size_bytes   bigint not null default 0,

  -- 0 means we could not measure it; the browser fills these in afterwards.
  width        integer not null default 0,
  height       integer not null default 0,

  -- `kind` is what the image is now; `auto_kind` is what the detector first
  -- said. Keeping both is how a manual change survives re-detection.
  kind         text not null,
  auto_kind    text not null,
  confidence   text not null default 'low',
  why          text not null default '',

  tags         text[] not null default '{}',

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists images_library_created_idx
  on public.images (library_id, created_at desc);

create index if not exists images_tags_idx
  on public.images using gin (tags);

create index if not exists memberships_user_idx
  on public.memberships (user_id);

-- Keep updated_at honest without the application having to remember.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists images_touch_updated_at on public.images;
create trigger images_touch_updated_at
  before update on public.images
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------- membership tests
--
-- These are SECURITY DEFINER on purpose. A policy on `images` needs to read
-- `memberships`, and if that read were itself subject to row-level security the
-- two policies would call each other forever. Running as the definer breaks the
-- loop. Both are STABLE and read nothing the caller can influence.

create or replace function public.is_member(lib uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $fn$
  select exists (
    select 1 from public.memberships m
    where m.library_id = lib and m.user_id = auth.uid()
  );
$fn$;

create or replace function public.is_owner(lib uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $fn$
  select exists (
    select 1 from public.memberships m
    where m.library_id = lib and m.user_id = auth.uid() and m.role = 'owner'
  );
$fn$;

-- --------------------------------------------------------- row-level security

alter table public.libraries   enable row level security;
alter table public.memberships enable row level security;
alter table public.invites     enable row level security;
alter table public.images      enable row level security;

drop policy if exists "see libraries you are in" on public.libraries;
create policy "see libraries you are in" on public.libraries
  for select using (public.is_member(id));

drop policy if exists "see the roster"        on public.memberships;
drop policy if exists "owners add people"     on public.memberships;
drop policy if exists "owners remove people"  on public.memberships;

create policy "see the roster" on public.memberships
  for select using (user_id = auth.uid() or public.is_owner(library_id));
create policy "owners add people" on public.memberships
  for insert with check (public.is_owner(library_id));
create policy "owners remove people" on public.memberships
  for delete using (public.is_owner(library_id));

drop policy if exists "owners manage invites" on public.invites;
create policy "owners manage invites" on public.invites
  for all using (public.is_owner(library_id)) with check (public.is_owner(library_id));

-- Any member may read, add, retag and delete. A shared library where only the
-- owner can tidy up is not really shared.
drop policy if exists "members read images"   on public.images;
drop policy if exists "members add images"    on public.images;
drop policy if exists "members edit images"   on public.images;
drop policy if exists "members delete images" on public.images;

create policy "members read images"   on public.images for select using (public.is_member(library_id));
create policy "members add images"    on public.images for insert with check (public.is_member(library_id));
create policy "members edit images"   on public.images for update using (public.is_member(library_id));
create policy "members delete images" on public.images for delete using (public.is_member(library_id));

-- -------------------------------------------------------------- the bucket

-- Private: image URLs are handed out by the server, not guessable from the web.
insert into storage.buckets (id, name, public)
values ('inspiration', 'inspiration', false)
on conflict (id) do nothing;

-- Files are stored under "<library id>/<filename>", so the first path segment
-- is what decides who may touch them - the same test as the table.
drop policy if exists "members read files"   on storage.objects;
drop policy if exists "members upload files" on storage.objects;
drop policy if exists "members delete files" on storage.objects;

create policy "members read files" on storage.objects for select
  using (bucket_id = 'inspiration'
         and public.is_member(((storage.foldername(name))[1])::uuid));

create policy "members upload files" on storage.objects for insert
  with check (bucket_id = 'inspiration'
              and public.is_member(((storage.foldername(name))[1])::uuid));

create policy "members delete files" on storage.objects for delete
  using (bucket_id = 'inspiration'
         and public.is_member(((storage.foldername(name))[1])::uuid));

-- ---------------------------------------------------------------- realtime
--
-- Lets the app receive changes as they happen, so an image somebody else adds
-- appears in everyone's grid without anyone reloading. Row-level security still
-- applies to the stream: you are only sent changes to rows you could read
-- anyway, which is your own library's.

alter publication supabase_realtime add table public.images;

-- ------------------------------------------------------------- housekeeping

-- "Social" and "Branding" used to be separate types and are now one. This moves
-- anything left on the old id, including auto_kind - the detector will never say
-- 'social' again, so a stale auto_kind would make those images look permanently
-- overridden. Does nothing once there is nothing left to move.
update public.images set kind      = 'branding' where kind      = 'social';
update public.images set auto_kind = 'branding' where auto_kind = 'social';

-- --------------------------------------------------------------------- notes
--
-- The first person to sign in creates the library and becomes its owner.
-- After that, joining needs an invite: the app has an Invite box for owners.
-- Inviting someone here only lets them into the library - they still need an
-- account, so also invite them under Authentication -> Users.
--
-- Turn OFF public sign-ups under Authentication -> Providers. Without it anyone
-- who finds the URL can create an account. They would land in no library and
-- see nothing, but there is no reason to allow it.
