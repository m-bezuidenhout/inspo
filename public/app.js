const el = (id) => document.getElementById(id);

const kindList = el('kind-list');
const allItem = el('all-item');
const allCount = el('all-count');
const grid = el('grid');
const emptyState = el('empty-state');
const viewTitle = el('view-title');
const imageCount = el('image-count');
const uploadBtn = el('upload-btn');
const fileInput = el('file-input');
const dropOverlay = el('dropzone-overlay');
const libraryPath = el('library-path');
const filters = el('filters');
const tagChips = el('tag-chips');
const tagFilterRow = el('tag-filter-row');
const peopleFilterRow = el('people-filter-row');
const peopleChips = el('people-chips');
const lightboxBy = el('lightbox-by');
const lightboxByDot = el('lightbox-by-dot');
const searchInput = el('search-input');
const clearFiltersBtn = el('clear-filters');
const lightbox = el('lightbox');
const lightboxImg = el('lightbox-img');
const lightboxStage = el('lightbox-stage');
const zoomIn = el('zoom-in');
const zoomOut = el('zoom-out');
const zoomLevel = el('zoom-level');
const zoomActual = el('zoom-actual');
const lightboxName = el('lightbox-name');
const lightboxDims = el('lightbox-dims');
const lightboxWhy = el('lightbox-why');
const lightboxDelete = el('lightbox-delete');
const lightboxClose = el('lightbox-close');
const lightboxTags = el('lightbox-tags');
const kindSelect = el('kind-select');
const tagInput = el('tag-input');
const tagSuggestions = el('tag-suggestions');
const uploadModal = el('upload-modal');
const uploadTitle = el('upload-title');
const uploadPreview = el('upload-preview');
const uploadKind = el('upload-kind');
const uploadKindNote = el('upload-kind-note');
const uploadKindHint = el('upload-kind-hint');
const uploadTagChips = el('upload-tag-chips');
const uploadTagInput = el('upload-tag-input');
const uploadCancel = el('upload-cancel');
const uploadConfirm = el('upload-confirm');
const toastEl = el('toast');
const signin = el('signin');
const signinForm = el('signin-form');
const signinEmail = el('signin-email');
const signinBtn = el('signin-btn');
const signinNote = el('signin-note');
const account = el('account');
const accountEmail = el('account-email');
const signoutBtn = el('signout-btn');
const pathLabel = el('path-label');
const peopleBtn = el('people-btn');
const peopleModal = el('people-modal');
const peopleList = el('people-list');
const peopleClose = el('people-close');
const inviteForm = el('invite-form');
const inviteEmail = el('invite-email');

let kinds = [];
let kindLabels = {};
let images = [];
let activeKind = null; // null is the "All images" view.
let lightboxImage = null;
let toastTimer = null;
let serverConfig = { backend: 'local', authRequired: false };
let auth = null; // The Supabase client, only on the hosted backend.
let accessToken = null;

// Files waiting on the add-images dialog, with what the detector suggests for
// each and the sizes we measured to get there.
let pending = { files: [], tags: [], previews: [], suggestions: [], sizes: [] };

// Marks the "suggested" row in the dialog's type dropdown. No kind id contains
// an asterisk, so it can never collide with a real one.
const AUTO_KIND = '*auto*';

const filter = { tags: new Set(), people: new Set(), search: '' };

// ---------------------------------------------------------------- utilities

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

async function api(url, options = {}) {
  // The server checks this against Supabase; row-level security does the rest.
  if (accessToken) {
    options = { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` } };
  }
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A failed request with no JSON body is usually Express's own 404 page,
    // which means the address exists but this server has never heard of it.
    const err = new Error(data.error || `The library returned ${res.status} for ${url}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function imagePath(image) {
  // The backend decides what an id is - a filename on disk, a row id in
  // Postgres - so the page only ever passes it back.
  return `/api/images/${encodeURIComponent(image.id)}`;
}

/** Strips the upload timestamp back off for display. */
function prettyName(name) {
  return name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+__/, '');
}

/** "matt@example.com" reads as "matt" on a chip, with the full address on hover. */
function shortName(email) {
  if (!email) return '';
  return email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
}

function labelFor(kind) {
  return kindLabels[kind] || kind;
}

function json(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ filters

/**
 * Whether an image survives the filters, optionally ignoring one of them.
 *
 * Skipping a filter is how each row counts itself: the tag chips show what you
 * would get by clicking them, which means counting as if no tag were chosen
 * yet. Counting with every filter applied would show zeroes everywhere.
 */
function matches(image, except) {
  if (except !== 'kind' && activeKind && image.kind !== activeKind) return false;

  // People are an OR - two selected means "either of them added it".
  if (except !== 'person' && filter.people.size > 0 && !filter.people.has(image.uploadedBy)) {
    return false;
  }

  // Tags are an AND - each one you add narrows the result further.
  if (except !== 'tag') {
    for (const tag of filter.tags) {
      if (!image.tags.includes(tag)) return false;
    }
  }

  if (except !== 'search' && filter.search) {
    const haystack = [prettyName(image.name), image.uploadedByName || '', ...image.tags]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filter.search)) return false;
  }
  return true;
}

function countBy(except, pick) {
  const counts = new Map();
  for (const image of images) {
    if (!matches(image, except)) continue;
    for (const value of pick(image)) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return counts;
}

function filterActive() {
  return filter.tags.size > 0 || filter.people.size > 0 || filter.search !== '';
}

function visibleImages() {
  return images.filter((image) => matches(image));
}

function clearFilters() {
  filter.tags.clear();
  filter.people.clear();
  filter.search = '';
  searchInput.value = '';
}

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

// ---------------------------------------------------------------- nav icons

/**
 * One glyph per type, so the sidebar can be read at a glance rather than by
 * matching colours to labels. Drawn as stroked paths on a 16x16 grid and
 * coloured by the same --kind variable everything else uses.
 */
const KIND_ICONS = {
  // A phone.
  mobile: ['<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/>', '<path d="M7 12.4h2"/>'],
  // A browser window.
  desktop: ['<rect x="1.5" y="2.5" width="13" height="9.5" rx="1.8"/>', '<path d="M1.5 5.5h13M5.5 14.5h5"/>'],
  // Tiles of data.
  dashboard: [
    '<rect x="1.8" y="1.8" width="5.2" height="5.2" rx="1.2"/>',
    '<rect x="9" y="1.8" width="5.2" height="5.2" rx="1.2"/>',
    '<rect x="1.8" y="9" width="5.2" height="5.2" rx="1.2"/>',
    '<rect x="9" y="9" width="5.2" height="5.2" rx="1.2"/>',
  ],
  // One piece lifted out of a screen.
  ui: ['<rect x="1.5" y="2.5" width="13" height="11" rx="1.8"/>', '<rect x="4" y="5.5" width="8" height="5" rx="1"/>'],
  // A megaphone: identity going out into the world.
  branding: ['<path d="M2.5 6.2v3.6a1 1 0 0 0 1 1h1.7l6.3 3.2V2L5.2 5.2H3.5a1 1 0 0 0-1 1Z"/>', '<path d="M13.6 5.4a3.4 3.4 0 0 1 0 5.2"/>'],
  // A printed page.
  print: ['<rect x="3" y="1.5" width="10" height="13" rx="1.5"/>', '<path d="M5.8 5.2h4.4M5.8 8h4.4M5.8 10.8h2.6"/>'],
  // A picture with a horizon.
  illustration: [
    '<rect x="1.5" y="2.5" width="13" height="11" rx="1.8"/>',
    '<path d="m3.2 11.5 3-3.2 2.4 2.4 2.2-2.4 2 2.4"/>',
    '<circle cx="5.9" cy="5.9" r="1.1"/>',
  ],
  // Anything the detector could not place.
  other: ['<circle cx="8" cy="8" r="5.2"/>', '<path d="M8 5.6v2.6"/>', '<path d="M8 10.5h.01"/>'],
};

// The all-images row: a stack of everything.
const ALL_ICON = [
  '<rect x="1.8" y="4.5" width="12.4" height="9.7" rx="1.8"/>',
  '<path d="M4.2 2.2h7.6"/>',
];

function iconFor(paths, kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'kind-icon');
  svg.setAttribute('aria-hidden', 'true');
  if (kind) svg.dataset.kind = kind;
  svg.innerHTML = paths.join('');
  return svg;
}
// --------------------------------------------------------------- sidebar nav

function renderNav() {
  // Drawn once, then left alone.
  if (!allItem.querySelector('svg')) {
    el('all-glyph').appendChild(iconFor(ALL_ICON));
  }

  const counts = countBy('kind', (image) => [image.kind]);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  allItem.classList.toggle('active', activeKind === null);
  allCount.textContent = total;

  kindList.innerHTML = '';
  kinds.forEach((kind) => {
    const count = counts.get(kind.id) || 0;
    // An empty type is noise unless you are standing in it.
    if (count === 0 && activeKind !== kind.id) return;

    const btn = document.createElement('button');
    btn.className = 'nav-item' + (activeKind === kind.id ? ' active' : '');
    btn.onclick = () => selectKind(activeKind === kind.id ? null : kind.id);

    const dot = iconFor(KIND_ICONS[kind.id] || KIND_ICONS.other, kind.id);

    const name = document.createElement('span');
    name.className = 'nav-name';
    name.textContent = kind.label;

    const num = document.createElement('span');
    num.className = 'nav-count';
    num.textContent = count;

    btn.append(dot, name, num);
    kindList.appendChild(btn);
  });
}

function selectKind(kind) {
  activeKind = kind;
  render();
}

// ------------------------------------------------------------- filter chips

function renderFilters() {
  filters.hidden = images.length === 0;
  if (filters.hidden) return;

  // Only worth showing once more than one person has added something.
  const peopleCounts = countBy('person', (image) => (image.uploadedBy ? [image.uploadedBy] : []));
  const names = new Map();
  images.forEach((i) => i.uploadedBy && names.set(i.uploadedBy, i.uploadedByName));

  peopleFilterRow.hidden = peopleCounts.size < 2;
  peopleChips.innerHTML = '';
  [...peopleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([id, count]) => {
      const chipEl = chip(shortName(names.get(id)), count, filter.people.has(id), null, () => {
        toggle(filter.people, id);
        render();
      });
      chipEl.title = names.get(id) || '';
      peopleChips.appendChild(chipEl);
    });

  // Someone removed from the library keeps their images but stops being a filter.
  [...filter.people].forEach((id) => !peopleCounts.has(id) && filter.people.delete(id));

  const tagCounts = countBy('tag', (image) => image.tags);
  const tagNames = [...tagCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );

  tagFilterRow.hidden = tagNames.length === 0;
  tagChips.innerHTML = '';
  tagNames.forEach(([name, count]) => {
    tagChips.appendChild(
      chip(name, count, filter.tags.has(name), null, () => {
        toggle(filter.tags, name);
        render();
      })
    );
  });

  // A tag that no longer exists must not stay selected, or the view would be
  // stuck showing nothing with no obvious way back.
  [...filter.tags].forEach((t) => !tagCounts.has(t) && filter.tags.delete(t));

  clearFiltersBtn.hidden = !filterActive();
  renderSuggestions(tagNames.map(([name]) => name));
}

function chip(label, count, on, kind, onClick) {
  const btn = document.createElement('button');
  btn.className = 'chip' + (on ? ' on' : '');
  if (kind) btn.dataset.kind = kind;
  btn.onclick = onClick;

  const text = document.createElement('span');
  text.textContent = label;

  const num = document.createElement('span');
  num.className = 'chip-count';
  num.textContent = count;

  btn.append(text, num);
  return btn;
}

// ------------------------------------------------------------------- images

async function loadImages() {
  const data = await api('/api/images');
  images = data.images;
  libraryPath.textContent = data.libraryPath;
  libraryPath.title = data.libraryPath;
  render();
}

function render() {
  viewTitle.textContent = activeKind ? labelFor(activeKind) : 'All images';
  uploadBtn.disabled = false;

  renderNav();
  renderFilters();

  const shown = visibleImages();

  if (shown.length === 0) {
    grid.hidden = true;
    emptyState.hidden = false;
    setEmptyText();
    imageCount.textContent = images.length === 0 ? '' : `0 of ${plural(images.length, 'image')}`;
    return;
  }

  imageCount.textContent =
    shown.length === images.length
      ? plural(images.length, 'image')
      : `${shown.length} of ${plural(images.length, 'image')}`;

  emptyState.hidden = true;
  grid.hidden = false;
  grid.innerHTML = '';
  shown.forEach((image) => grid.appendChild(card(image)));
}

function setEmptyText() {
  const h3 = emptyState.querySelector('h3');
  const p = emptyState.querySelector('p');

  if (images.length > 0) {
    h3.textContent = 'Nothing matches that';
    p.textContent = 'Try another type on the left, or clear the filters.';
  } else {
    h3.textContent = 'Nothing here yet';
    p.textContent =
      'Drag images anywhere on this page, paste from your clipboard, or use the Add images button.';
  }
}

function card(image) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.onclick = () => openLightbox(image);

  const img = document.createElement('img');
  img.src = image.url;
  img.alt = prettyName(image.name);
  img.loading = 'lazy';

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const del = document.createElement('button');
  del.className = 'card-delete';
  del.title = 'Delete image';
  del.setAttribute('aria-label', `Delete ${prettyName(image.name)}`);
  // A drawn cross rather than the "×" character: the glyph sits differently in
  // every font and never quite centres, which shows at this size.
  del.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 5.2 10.8 10.8M10.8 5.2 5.2 10.8"/></svg>';
  del.onclick = (event) => {
    event.stopPropagation();
    deleteImage(image);
  };
  actions.appendChild(del);

  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const badge = document.createElement('span');
  badge.className = 'badge' + (image.confidence === 'low' ? ' unsure' : '');
  badge.dataset.kind = image.kind;
  badge.textContent = labelFor(image.kind);
  badge.title = image.edited ? 'Set by you' : `Detected: ${image.why}`;
  footer.appendChild(badge);

  if (image.uploadedByName) {
    const by = document.createElement('span');
    by.className = 'card-by';
    by.textContent = shortName(image.uploadedByName);
    by.title = `Added by ${image.uploadedByName}`;
    footer.appendChild(by);
  }

  if (image.tags.length > 0) {
    const tags = document.createElement('span');
    tags.className = 'card-tags';
    tags.textContent = image.tags.join(' · ');
    footer.appendChild(tags);
  }

  wrap.append(img, actions, footer);
  return wrap;
}

// ------------------------------------------------------------------ uploads

/**
 * The way in for every upload. Dropping or pasting while tags are selected is
 * unambiguous - those tags are plainly what the new images belong to - so that
 * goes straight in. With nothing selected there is no grouping to inherit, so
 * the dialog asks; the Add images button always asks.
 */
function requestUpload(fileArray, { ask = false } = {}) {
  const imageFiles = fileArray.filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    toast('Those were not image files.', true);
    return;
  }
  if (filter.tags.size > 0 && !ask) {
    uploadFiles(imageFiles, [...filter.tags], null, []);
    return;
  }
  openUploadModal(imageFiles);
}

async function uploadFiles(imageFiles, tags, kind, sizes) {
  const body = new FormData();
  body.append('tags', JSON.stringify(tags || []));
  if (kind) body.append('kind', kind);
  imageFiles.forEach((file) => body.append('images', file));

  try {
    const result = await api('/api/images', { method: 'POST', body });

    await measureAnythingTheServerCouldNotRead(result.images, imageFiles, sizes);
    toast(summariseDetection(result.images, tags));

    // Land on what was just added, so it is not lost in the pile.
    if (tags && tags.length > 0) filter.tags = new Set(tags);
    await loadImages();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * The server reads image sizes straight from the file header, which covers
 * every common format but not AVIF. The browser can already display those, so
 * for anything the server came back blank on we send the dimensions over -
 * then the detector gets a second, better go at it.
 */
async function measureAnythingTheServerCouldNotRead(added, files, sizes) {
  const pendingSizes = added
    .map((item, index) => ({ item, file: files[index], size: sizes && sizes[index] }))
    .filter((p) => p.item.needsSize);
  if (pendingSizes.length === 0) return;

  await Promise.all(
    pendingSizes.map(async ({ item, file, size }) => {
      const dims = size || (file && (await measure(file).catch(() => null)));
      if (!dims) return;
      await api(imagePath(item), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dims),
      }).catch(() => {});
    })
  );
}

function measure(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not measure'));
    };
    probe.src = url;
  });
}

/** "Added 4 images - 3 Mobile, 1 Dashboard" reads better than a bare count. */
function summariseDetection(added, tags) {
  const counts = new Map();
  added.forEach((a) => counts.set(a.kind, (counts.get(a.kind) || 0) + 1));
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${labelFor(kind)}`);
  const tagged = tags && tags.length > 0 ? ` tagged ${tags.join(', ')}` : '';
  return `Added ${plural(added.length, 'image')}${tagged} — ${parts.join(', ')}`;
}

// ------------------------------------------------------- add-images dialog

async function openUploadModal(imageFiles) {
  releasePreviews();
  pending = { files: imageFiles, tags: [], previews: [], suggestions: [], sizes: [] };

  uploadTitle.textContent = `Add ${plural(imageFiles.length, 'image')}`;
  uploadConfirm.textContent = `Add ${plural(imageFiles.length, 'image')}`;

  renderUploadTags();
  uploadTagInput.value = '';
  uploadKindNote.textContent = 'Working out what these are…';
  uploadKind.innerHTML = '';
  uploadKind.appendChild(option(AUTO_KIND, 'Working out…'));
  uploadKind.disabled = true;

  renderPreview();
  uploadModal.hidden = false;
  uploadTagInput.focus();

  await suggestKinds(imageFiles);
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

/**
 * Measures each file in the browser and asks the server what the detector
 * would make of it, so the dialog can show its suggestion before you commit.
 * The server stays the only place the rules live.
 */
async function suggestKinds(imageFiles) {
  let results = [];
  try {
    const sizes = await Promise.all(
      imageFiles.map((file) => measure(file).catch(() => ({ width: 0, height: 0 })))
    );
    pending.sizes = sizes;
    const payload = imageFiles.map((file, i) => ({
      name: file.name,
      width: sizes[i].width,
      height: sizes[i].height,
    }));
    results = (await json('/api/detect', { files: payload })).results;
  } catch {
    results = [];
  }

  // The dialog may have been cancelled while that was in flight.
  if (uploadModal.hidden || pending.files !== imageFiles) return;

  pending.suggestions = results;
  renderPreview();

  const unique = [...new Set(results.map((r) => r.kind))];
  uploadKind.disabled = false;
  uploadKind.innerHTML = '';

  if (results.length === 0) {
    uploadKind.appendChild(option(AUTO_KIND, 'Work it out for me'));
    uploadKindNote.textContent = 'Each image gets its type worked out once it is added.';
  } else if (unique.length === 1) {
    uploadKind.appendChild(option(AUTO_KIND, `${labelFor(unique[0])} (suggested)`));
    const unsure = results.some((r) => r.confidence === 'low');
    uploadKindNote.textContent = unsure
      ? `Suggested from ${results[0].why} — not a confident guess, so change it if it looks wrong.`
      : `Suggested from ${results[0].why}. Change it if you disagree.`;
  } else {
    const summary = unique.map((k) => labelFor(k)).join(', ');
    uploadKind.appendChild(option(AUTO_KIND, `Keep each one's own (${summary})`));
    uploadKindNote.textContent =
      'These look like different types, so each keeps its own. Pick one below to give them all the same.';
  }

  kinds.forEach((kind) => uploadKind.appendChild(option(kind.id, kind.label)));
  uploadKind.value = AUTO_KIND;
}

function renderPreview() {
  uploadPreview.innerHTML = '';
  pending.files.slice(0, 12).forEach((file, index) => {
    const url = URL.createObjectURL(file);
    pending.previews.push(url);

    const item = document.createElement('span');
    item.className = 'preview-item';

    const thumb = document.createElement('img');
    thumb.src = url;
    thumb.alt = file.name;

    const guess = pending.suggestions[index];
    thumb.title = guess ? `${file.name} — looks like ${labelFor(guess.kind)}` : file.name;
    item.appendChild(thumb);

    if (guess) {
      const dot = document.createElement('span');
      dot.className = 'preview-kind';
      dot.dataset.kind = guess.kind;
      item.appendChild(dot);
    }
    uploadPreview.appendChild(item);
  });

  if (pending.files.length > 12) {
    const more = document.createElement('span');
    more.className = 'preview-more';
    more.textContent = `+${pending.files.length - 12}`;
    uploadPreview.appendChild(more);
  }
}

function renderUploadTags() {
  uploadTagChips.innerHTML = '';
  pending.tags.forEach((tag) => {
    uploadTagChips.appendChild(
      tagChip(tag, () => {
        pending.tags = pending.tags.filter((t) => t !== tag);
        renderUploadTags();
      })
    );
  });
}

/** Releases the object URLs behind the preview thumbnails. */
function releasePreviews() {
  pending.previews.forEach((url) => URL.revokeObjectURL(url));
  pending.previews = [];
}

function closeUploadModal() {
  releasePreviews();
  pending = { files: [], tags: [], previews: [], suggestions: [], sizes: [] };
  uploadModal.hidden = true;
}

async function confirmUpload() {
  if (pending.files.length === 0) return;
  const { files, tags, sizes } = pending;
  const kind = uploadKind.value === AUTO_KIND ? null : uploadKind.value;
  closeUploadModal();
  await uploadFiles(files, tags, kind, sizes);
}

// ------------------------------------------------------------------ editing

async function deleteImage(image) {
  if (!confirm('Delete this image? This removes the file from your PC.')) return;
  try {
    await api(imagePath(image), { method: 'DELETE' });
    closeLightbox();
    toast('Image deleted.');
    await loadImages();
  } catch (err) {
    toast(err.message, true);
  }
}

/** Sends a change for the open image and folds the reply back into the list. */
async function patchImage(changes) {
  if (!lightboxImage) return;
  try {
    const updated = await api(imagePath(lightboxImage), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });

    const row = images.find((i) => i.id === updated.id);
    Object.assign(lightboxImage, updated);
    if (row && row !== lightboxImage) Object.assign(row, updated);

    renderLightbox();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadConfig() {
  const data = await api('/api/config');
  serverConfig = data;
  kinds = data.kinds;
  kindLabels = Object.fromEntries(kinds.map((k) => [k.id, k.label]));

  kindSelect.innerHTML = '';
  kinds.forEach((kind) => kindSelect.appendChild(option(kind.id, kind.label)));
}

function renderSuggestions(tagNames) {
  tagSuggestions.innerHTML = '';
  tagNames.forEach((name) => {
    const o = document.createElement('option');
    o.value = name;
    tagSuggestions.appendChild(o);
  });
}


// ------------------------------------------------------------------- zoom

/**
 * Zooming the full-size view, so you can go and look at the detail that made
 * you save the thing in the first place.
 *
 * `zoom` is a multiplier on top of however the image was fitted to the stage,
 * not an absolute scale - the fitted size depends on the window. The percentage
 * shown is the real one though: fitted scale times zoom, so 100% genuinely
 * means one image pixel per screen pixel.
 */
const MAX_ZOOM = 8;
let zoom = 1;
let pan = { x: 0, y: 0 };
let dragging = null;

/**
 * How much the browser shrank the image to fit the stage.
 *
 * Not clientWidth/naturalWidth: with object-fit the element's box is whatever
 * the stage allows, and the picture is letterboxed inside it. The scale that
 * actually applies is the smaller of the two axes - the same one "contain"
 * picked.
 */
function fitScale() {
  const { naturalWidth: nw, naturalHeight: nh, clientWidth: cw, clientHeight: ch } = lightboxImg;
  if (!nw || !nh || !cw || !ch) return 0;
  return Math.min(cw / nw, ch / nh);
}

/** The painted size of the image inside its box, before zoom. */
function paintedSize() {
  const scale = fitScale();
  if (!scale) return { width: 0, height: 0 };
  return { width: lightboxImg.naturalWidth * scale, height: lightboxImg.naturalHeight * scale };
}

function applyZoom() {
  clampPan();
  lightboxImg.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  lightboxImg.classList.toggle('zoomed', zoom > 1);
  lightboxStage.classList.toggle('zoomed', zoom > 1);

  const real = Math.round(fitScale() * zoom * 100);
  // Before the image has laid out there is no honest number to show.
  zoomLevel.textContent = real > 0 ? `${real}%` : 'Fit';
  zoomOut.disabled = zoom <= 1;
  zoomIn.disabled = zoom >= MAX_ZOOM;
}

/** Keeps the image from being dragged off the edge of the stage. */
function clampPan() {
  if (zoom <= 1) {
    pan = { x: 0, y: 0 };
    return;
  }
  // How far past the stage the scaled picture reaches, in each direction. Uses
  // the painted size, not the element box, or the limits would be too generous
  // on whichever axis is letterboxed.
  const painted = paintedSize();
  const slackX = Math.max(0, (painted.width * zoom - lightboxImg.clientWidth) / 2);
  const slackY = Math.max(0, (painted.height * zoom - lightboxImg.clientHeight) / 2);
  pan.x = Math.max(-slackX, Math.min(slackX, pan.x));
  pan.y = Math.max(-slackY, Math.min(slackY, pan.y));
}

function resetZoom() {
  zoom = 1;
  pan = { x: 0, y: 0 };
  applyZoom();
}

/**
 * Zooms towards a point rather than the centre, so the thing under the cursor
 * stays under the cursor - the behaviour every map and image viewer has.
 */
function zoomTo(next, originX, originY) {
  const target = Math.max(1, Math.min(MAX_ZOOM, next));
  if (target === zoom) return;

  if (originX !== undefined) {
    const box = lightboxImg.getBoundingClientRect();
    // Where the cursor sits relative to the image's centre, before scaling.
    const dx = originX - (box.left + box.width / 2);
    const dy = originY - (box.top + box.height / 2);
    const ratio = target / zoom;
    pan.x = pan.x - dx * (ratio - 1);
    pan.y = pan.y - dy * (ratio - 1);
  }

  zoom = target;
  applyZoom();
}

/** Zoom that makes one image pixel one screen pixel. */
function actualSizeZoom() {
  const fit = fitScale();
  return fit > 0 ? Math.min(MAX_ZOOM, 1 / fit) : 1;
}

/** True once the image has laid out and 1:1 means something. */
function canZoom() {
  return fitScale() > 0;
}

zoomIn.onclick = () => zoomTo(zoom * 1.4);
zoomOut.onclick = () => zoomTo(zoom / 1.4);
zoomLevel.onclick = resetZoom;
zoomActual.onclick = () => {
  const actual = actualSizeZoom();
  // Pressing it again when already there puts you back to fit.
  if (Math.abs(zoom - actual) < 0.01) resetZoom();
  else zoomTo(actual);
};

lightboxStage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // Trackpads send small deltas and mice send large ones; scaling by the
    // delta rather than stepping keeps both feeling the same.
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomTo(zoom * factor, event.clientX, event.clientY);
  },
  { passive: false }
);

lightboxImg.addEventListener('pointerdown', (event) => {
  if (zoom <= 1) return;
  dragging = { x: event.clientX, y: event.clientY, moved: false };
  lightboxImg.setPointerCapture(event.pointerId);
});

lightboxImg.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  pan.x += event.clientX - dragging.x;
  pan.y += event.clientY - dragging.y;
  dragging = { x: event.clientX, y: event.clientY, moved: true };
  applyZoom();
});

lightboxImg.addEventListener('pointerup', (event) => {
  const wasDrag = dragging && dragging.moved;
  dragging = null;
  if (lightboxImg.hasPointerCapture(event.pointerId)) {
    lightboxImg.releasePointerCapture(event.pointerId);
  }
  // A click that panned is not a click.
  if (wasDrag) return;
  const actual = actualSizeZoom();
  if (zoom > 1) resetZoom();
  else zoomTo(actual, event.clientX, event.clientY);
});

// Clicking the space around the image still closes, as it always did.
lightboxStage.onclick = (event) => {
  if (event.target === lightboxStage) closeLightbox();
};

// Refitting on resize changes the fitted scale, so the percentage would lie.
window.addEventListener('resize', () => {
  if (!lightbox.hidden) applyZoom();
});

// ---------------------------------------------------------------- lightbox

function openLightbox(image) {
  lightboxImage = image;
  lightboxImg.src = image.url;
  lightboxImg.alt = prettyName(image.name);
  lightbox.hidden = false;
  resetZoom();
  // The fitted scale is only knowable once the image has laid out, and the
  // percentage is wrong until then.
  lightboxImg.decode().then(applyZoom).catch(() => applyZoom());
  renderLightbox();
  tagInput.value = '';
}

function renderLightbox() {
  const image = lightboxImage;
  if (!image) return;

  lightboxName.textContent = prettyName(image.name);
  lightboxDims.textContent = image.width ? `${image.width} × ${image.height}` : 'size unknown';

  const by = image.uploadedByName;
  lightboxBy.hidden = !by;
  lightboxByDot.hidden = !by;
  if (by) {
    lightboxBy.textContent = `added by ${by}`;
    lightboxBy.title = by;
  }
  kindSelect.value = image.kind;

  lightboxWhy.textContent = image.edited
    ? 'Type set by you.'
    : `Detected as ${labelFor(image.kind)} — ${image.why}.` +
      (image.confidence === 'low' ? ' Not a confident guess, so change it if it looks wrong.' : '');
  lightboxWhy.classList.toggle('unsure', !image.edited && image.confidence === 'low');

  lightboxTags.innerHTML = '';
  image.tags.forEach((tag) => {
    lightboxTags.appendChild(
      tagChip(tag, () => patchImage({ tags: image.tags.filter((t) => t !== tag) }))
    );
  });
}

/** A removable tag pill, shared by the full-size view and the add dialog. */
function tagChip(tag, onRemove) {
  const chipEl = document.createElement('span');
  chipEl.className = 'tag-chip';

  const label = document.createElement('span');
  label.textContent = tag;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tag-remove';
  remove.textContent = '×';
  remove.title = `Remove "${tag}"`;
  remove.onclick = onRemove;

  chipEl.append(label, remove);
  return chipEl;
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImage = null;
  lightboxImg.src = '';
  resetZoom();
}

function addTagFromInput() {
  const value = tagInput.value.trim();
  if (!value || !lightboxImage) return;
  tagInput.value = '';
  if (lightboxImage.tags.includes(value.toLowerCase())) return;
  patchImage({ tags: [...lightboxImage.tags, value] });
}

// ------------------------------------------------------------------ events

allItem.onclick = () => selectKind(null);

uploadBtn.onclick = () => fileInput.click();

fileInput.onchange = () => {
  // The button is the deliberate route, so always offer type and tags.
  requestUpload(Array.from(fileInput.files), { ask: true });
  fileInput.value = '';
};

searchInput.oninput = () => {
  filter.search = searchInput.value.trim().toLowerCase();
  render();
};

clearFiltersBtn.onclick = () => {
  clearFilters();
  render();
};

kindSelect.onchange = () => patchImage({ kind: kindSelect.value });

uploadCancel.onclick = closeUploadModal;
uploadConfirm.onclick = confirmUpload;

uploadKindHint.title =
  'This is only a suggestion, worked out from the image size and its filename. ' +
  'Pick anything you like here, or change it later on any image.';

uploadModal.onclick = (event) => {
  if (event.target === uploadModal) closeUploadModal();
};

uploadTagInput.onkeydown = (event) => {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    const value = uploadTagInput.value.trim().toLowerCase();
    uploadTagInput.value = '';
    if (value && !pending.tags.includes(value)) {
      pending.tags.push(value);
      renderUploadTags();
    }
  } else if (event.key === 'Backspace' && uploadTagInput.value === '' && pending.tags.length > 0) {
    pending.tags.pop();
    renderUploadTags();
  }
};

// Enter anywhere else in the dialog means "yes, add them".
uploadModal.onkeydown = (event) => {
  if (event.key === 'Enter' && event.target !== uploadTagInput) {
    event.preventDefault();
    confirmUpload();
  }
};

tagInput.onkeydown = (event) => {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    addTagFromInput();
  } else if (event.key === 'Backspace' && tagInput.value === '' && lightboxImage) {
    // Backspace on an empty box takes the last tag off, as tag fields do.
    if (lightboxImage.tags.length > 0) {
      patchImage({ tags: lightboxImage.tags.slice(0, -1) });
    }
  }
};

tagInput.onblur = addTagFromInput;

// Drag and drop anywhere on the page.
let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  // Not while the dialog is open - a second drop would throw away the type and
  // tags already chosen for the first one.
  if (uploadModal.hidden) dropOverlay.hidden = false;
});

window.addEventListener('dragover', (event) => event.preventDefault());

window.addEventListener('dragleave', () => {
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (!uploadModal.hidden) return;
  requestUpload(Array.from(event.dataTransfer.files));
});

// Paste an image straight from the clipboard.
window.addEventListener('paste', (event) => {
  // Not while someone is typing a tag.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  const files = Array.from(event.clipboardData.files);
  if (files.length > 0) requestUpload(files);
});

lightboxClose.onclick = closeLightbox;
lightboxDelete.onclick = () => lightboxImage && deleteImage(lightboxImage);
lightbox.onclick = (event) => {
  if (event.target === lightbox) closeLightbox();
};

window.addEventListener('keydown', (event) => {
  // Zoom keys only make sense while an image is open, and not mid-typing.
  if (!lightbox.hidden && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    if (event.key === '+' || event.key === '=') return zoomTo(zoom * 1.4);
    if (event.key === '-' || event.key === '_') return zoomTo(zoom / 1.4);
    if (event.key === '0') return resetZoom();
  }

  if (event.key !== 'Escape') return;
  if (!peopleModal.hidden) peopleModal.hidden = true;
  else if (!uploadModal.hidden) closeUploadModal();
  else if (!lightbox.hidden) {
    // Step out of zoom before closing, so Esc never loses your place by surprise.
    if (zoom > 1) resetZoom();
    else closeLightbox();
  }
  else if (filterActive()) {
    clearFilters();
    render();
  } else if (activeKind) {
    selectKind(null);
  }
});

/**
 * The page is served off disk, but the API lives in the running process. Update
 * the project while the black window is still open and you get the new page
 * talking to the old server, which answers 404 to everything it has not been
 * restarted to know about. That looks like the whole site is broken, so say
 * plainly what it actually is.
 */
// --------------------------------------------------------------- signing in

/**
 * Sets up Supabase auth, but only on the hosted backend. Running on your own PC
 * there is nobody to sign in as, so the library never loads this at all and
 * keeps its promise of talking to nothing on the internet.
 *
 * Sign-in is a emailed link rather than a password: nothing to remember, and
 * no password for this app to handle or get wrong.
 *
 * Returns true once there is a session to work with.
 */
async function startAuth() {
  const { createClient } = await import(
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
  );
  auth = createClient(serverConfig.supabaseUrl, serverConfig.supabaseAnonKey);

  const { data } = await auth.auth.getSession();
  if (data.session) {
    adoptSession(data.session);
    return true;
  }

  // Keep the token fresh, and pick up the session the emailed link creates.
  auth.auth.onAuthStateChange((_event, session) => {
    if (session) {
      adoptSession(session);
      signin.hidden = true;
      boot().catch((err) => toast(err.message, true));
    }
  });

  signin.hidden = false;
  signinEmail.focus();
  return false;
}

function adoptSession(session) {
  accessToken = session.access_token;
  account.hidden = false;
  accountEmail.textContent = session.user.email || '';
}

// ------------------------------------------------------------------- people

async function openPeople() {
  peopleModal.hidden = false;
  peopleList.innerHTML = '<li class="people-empty">Loading…</li>';
  try {
    const { people } = await api('/api/people');
    renderPeople(people);
  } catch (err) {
    peopleList.innerHTML = '';
    toast(err.message, true);
  }
}

function renderPeople(people) {
  peopleList.innerHTML = '';
  people.forEach((person) => {
    const row = document.createElement('li');
    row.className = 'people-row';

    const who = document.createElement('span');
    who.className = 'people-email';
    who.textContent = person.email;

    const role = document.createElement('span');
    role.className = 'people-role';
    // Someone invited who has not signed in yet is not a member yet either.
    role.textContent = person.joined ? person.role : 'invited';

    row.append(who, role);

    // The only owner has no remove button - the server refuses it anyway, but
    // there is no reason to offer a button that cannot work.
    const removable = !(person.joined && person.role === 'owner');
    if (removable) {
      const remove = document.createElement('button');
      remove.className = 'people-remove';
      remove.textContent = '×';
      remove.title = person.joined ? `Remove ${person.email}` : 'Withdraw this invite';
      remove.onclick = async () => {
        if (!confirm(`Remove ${person.email} from this library?`)) return;
        try {
          await api(`/api/people/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
          await openPeople();
        } catch (err) {
          toast(err.message, true);
        }
      };
      row.appendChild(remove);
    }
    peopleList.appendChild(row);
  });
}

inviteForm.onsubmit = async (event) => {
  event.preventDefault();
  const email = inviteEmail.value.trim();
  if (!email) return;
  try {
    await json('/api/people', { email });
    inviteEmail.value = '';
    toast(`${email} can now join this library.`);
    await openPeople();
  } catch (err) {
    toast(err.message, true);
  }
};

peopleBtn.onclick = openPeople;
peopleClose.onclick = () => (peopleModal.hidden = true);
peopleModal.onclick = (event) => {
  if (event.target === peopleModal) peopleModal.hidden = true;
};

signinForm.onsubmit = async (event) => {
  event.preventDefault();
  const email = signinEmail.value.trim();
  if (!email || !auth) return;

  signinBtn.disabled = true;
  signinBtn.textContent = 'Sending…';
  try {
    const { error } = await auth.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) throw new Error(error.message);
    signinNote.textContent = `Check ${email} for a sign-in link. You can close this tab.`;
    signinNote.classList.add('sent');
  } catch (err) {
    signinNote.textContent = err.message;
    signinNote.classList.add('error');
  } finally {
    signinBtn.disabled = false;
    signinBtn.textContent = 'Email me a link';
  }
};

signoutBtn.onclick = async () => {
  if (auth) await auth.auth.signOut();
  accessToken = null;
  window.location.reload();
};

async function boot() {
  try {
    await loadConfig();
  } catch (err) {
    if (err.status === 404) return showRestartNotice();
    throw err;
  }

  if (serverConfig.authRequired && !accessToken) {
    const ready = await startAuth();
    if (!ready) return; // The sign-in screen is up; boot resumes after sign-in.

    // That first config call went out before we had a token, so it could not
    // say who we are. Now it can - and the People button depends on knowing.
    await loadConfig();
  }

  if (serverConfig.backend !== 'local') {
    pathLabel.textContent = 'Saved in';
    // Only an owner can see or change who else is here.
    peopleBtn.hidden = serverConfig.role !== 'owner';
  }
  await loadImages();
}

function showRestartNotice() {
  filters.hidden = true;
  grid.hidden = true;
  emptyState.hidden = false;
  uploadBtn.disabled = true;
  viewTitle.textContent = 'Restart needed';
  imageCount.textContent = '';
  emptyState.querySelector('h3').textContent = 'The library window is running older code';
  emptyState.querySelector('p').textContent =
    'This page has been updated but the black window behind it has not. Close that window, ' +
    'double-click "Start Inspiration.cmd" again, then reload this page. Your images are untouched.';
}

boot().catch((err) => toast(err.message, true));
