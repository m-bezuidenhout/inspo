const el = (id) => document.getElementById(id);

const folderList = el('folder-list');
const grid = el('grid');
const emptyState = el('empty-state');
const currentFolderTitle = el('current-folder');
const imageCount = el('image-count');
const uploadBtn = el('upload-btn');
const fileInput = el('file-input');
const dropOverlay = el('dropzone-overlay');
const newFolderBtn = el('new-folder-btn');
const newFolderForm = el('new-folder-form');
const newFolderInput = el('new-folder-input');
const cancelFolderBtn = el('cancel-folder-btn');
const libraryPath = el('library-path');
const lightbox = el('lightbox');
const lightboxImg = el('lightbox-img');
const lightboxName = el('lightbox-name');
const lightboxDelete = el('lightbox-delete');
const lightboxClose = el('lightbox-close');
const toastEl = el('toast');

let folders = [];
let activeFolder = null;
let images = [];
let lightboxImage = null;
let toastTimer = null;

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

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ folders

async function loadFolders() {
  const data = await api('/api/folders');
  folders = data.folders;
  libraryPath.textContent = data.libraryPath;
  libraryPath.title = data.libraryPath;
  renderFolders();

  if (activeFolder && !folders.some((f) => f.name === activeFolder)) {
    activeFolder = null;
  }
  if (!activeFolder && folders.length > 0) {
    selectFolder(folders[0].name);
  } else if (!activeFolder) {
    renderEmptyLibrary();
  }
}

function renderFolders() {
  folderList.innerHTML = '';
  folders.forEach((folder) => {
    const btn = document.createElement('button');
    btn.className = 'folder-item' + (folder.name === activeFolder ? ' active' : '');
    btn.onclick = () => selectFolder(folder.name);

    const thumb = document.createElement('img');
    thumb.className = 'folder-thumb';
    thumb.alt = '';
    if (folder.cover) thumb.src = folder.cover;

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;

    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = folder.count;

    btn.append(thumb, name, count);
    folderList.appendChild(btn);
  });
}

async function selectFolder(name) {
  activeFolder = name;
  currentFolderTitle.textContent = name;
  uploadBtn.disabled = false;
  renderFolders();
  await loadImages();
}

// ------------------------------------------------------------------- images

async function loadImages() {
  if (!activeFolder) return;
  const data = await api(`/api/folders/${encodeURIComponent(activeFolder)}/images`);
  images = data.images;
  renderImages();
}

function renderImages() {
  imageCount.textContent = plural(images.length, 'image');

  if (images.length === 0) {
    grid.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector('h3').textContent = 'This folder is empty';
    emptyState.querySelector('p').textContent =
      'Drag images anywhere on this page, paste from your clipboard, or use the Add images button.';
    return;
  }

  emptyState.hidden = true;
  grid.hidden = false;
  grid.innerHTML = '';

  images.forEach((image) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openLightbox(image);

    const img = document.createElement('img');
    img.src = image.url;
    img.alt = image.name;
    img.loading = 'lazy';

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const del = document.createElement('button');
    del.className = 'card-delete';
    del.title = 'Delete image';
    del.textContent = '×';
    del.onclick = (event) => {
      event.stopPropagation();
      deleteImage(image);
    };

    actions.appendChild(del);
    card.append(img, actions);
    grid.appendChild(card);
  });
}

function renderEmptyLibrary() {
  grid.hidden = true;
  emptyState.hidden = false;
  currentFolderTitle.textContent = 'Choose a folder';
  imageCount.textContent = '';
  uploadBtn.disabled = true;
  emptyState.querySelector('h3').textContent = 'Nothing here yet';
  emptyState.querySelector('p').textContent = 'Create a folder on the left to get started.';
}

async function uploadFiles(fileArray) {
  if (!activeFolder) {
    toast('Pick a folder first.', true);
    return;
  }
  const imageFiles = fileArray.filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    toast('Those were not image files.', true);
    return;
  }

  const body = new FormData();
  imageFiles.forEach((file) => body.append('images', file));

  try {
    const result = await api(`/api/folders/${encodeURIComponent(activeFolder)}/images`, {
      method: 'POST',
      body,
    });
    toast(`Added ${plural(result.added, 'image')} to ${activeFolder}`);
    await loadImages();
    await loadFolders();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteImage(image) {
  if (!confirm(`Delete this image from "${activeFolder}"? This removes the file from your PC.`)) return;
  try {
    await api(
      `/api/folders/${encodeURIComponent(activeFolder)}/images/${encodeURIComponent(image.name)}`,
      { method: 'DELETE' }
    );
    closeLightbox();
    toast('Image deleted.');
    await loadImages();
    await loadFolders();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- lightbox

function openLightbox(image) {
  lightboxImage = image;
  lightboxImg.src = image.url;
  lightboxImg.alt = image.name;
  lightboxName.textContent = image.name;
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImage = null;
  lightboxImg.src = '';
}

// ------------------------------------------------------------------ events

newFolderBtn.onclick = () => {
  newFolderForm.hidden = false;
  newFolderInput.focus();
};

cancelFolderBtn.onclick = () => {
  newFolderForm.hidden = true;
  newFolderInput.value = '';
};

newFolderForm.onsubmit = async (event) => {
  event.preventDefault();
  const name = newFolderInput.value.trim();
  if (!name) return;
  try {
    await api('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    newFolderInput.value = '';
    newFolderForm.hidden = true;
    await loadFolders();
    await selectFolder(name);
    toast(`Folder "${name}" created.`);
  } catch (err) {
    toast(err.message, true);
  }
};

uploadBtn.onclick = () => fileInput.click();

fileInput.onchange = async () => {
  await uploadFiles(Array.from(fileInput.files));
  fileInput.value = '';
};

// Drag and drop anywhere on the page.
let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  if (activeFolder) dropOverlay.hidden = false;
});

window.addEventListener('dragover', (event) => event.preventDefault());

window.addEventListener('dragleave', () => {
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});

window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  await uploadFiles(Array.from(event.dataTransfer.files));
});

// Paste an image straight from the clipboard.
window.addEventListener('paste', async (event) => {
  const files = Array.from(event.clipboardData.files);
  if (files.length > 0) await uploadFiles(files);
});

lightboxClose.onclick = closeLightbox;
lightboxDelete.onclick = () => lightboxImage && deleteImage(lightboxImage);
lightbox.onclick = (event) => {
  if (event.target === lightbox) closeLightbox();
};

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!lightbox.hidden) closeLightbox();
    else if (!newFolderForm.hidden) cancelFolderBtn.onclick();
  }
});

loadFolders().catch((err) => toast(err.message, true));
