// Upload queue: generates previews in the browser, then sends files with progress.
import { api } from './api.js';
import { h, fill, icon, toast, fmt } from './util.js';

const THUMB_SIZE = 640;
const CONCURRENCY = 3;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|mp4|m4v|mov|webm|mkv|avi|3gp)$/i;

const queue = [];
let active = 0;
let panel;
let list;
let summary;
let onBatchDone = () => {};
let stats = { done: 0, duplicates: 0, failed: 0, total: 0 };

export function setUploadListener(fn) {
  onBatchDone = fn;
}

export function isMediaFile(file) {
  return /^(image|video)\//.test(file.type) || MEDIA_EXT.test(file.name);
}

export function enqueue(files, { albumId } = {}) {
  const accepted = [...files].filter(isMediaFile);
  const rejected = files.length - accepted.length;
  if (rejected) toast(`Пропущено файлов, не являющихся фото или видео: ${rejected}`, 'warn');
  if (!accepted.length) return;
  ensurePanel();
  if (!active && !queue.length) stats = { done: 0, duplicates: 0, failed: 0, total: 0 };
  for (const file of accepted) {
    const row = renderRow(file);
    list.append(row.node);
    queue.push({ file, albumId, row });
    stats.total++;
  }
  panel.hidden = false;
  panel.classList.remove('collapsed');
  updateSummary();
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    run(job).finally(() => {
      active--;
      updateSummary();
      if (!active && !queue.length) finish();
      else pump();
    });
  }
}

async function run({ file, albumId, row }) {
  row.setStatus('Подготовка…');
  try {
    const meta = await makePreview(file).catch(() => ({}));
    if (meta.thumbUrl) row.setPreview(meta.thumbUrl);
    const form = new FormData();
    form.append('file', file, file.name);
    if (meta.thumb) form.append('thumb', meta.thumb, 'thumb.jpg');
    if (meta.width) form.append('width', meta.width);
    if (meta.height) form.append('height', meta.height);
    if (meta.duration) form.append('duration', meta.duration);
    form.append('takenAt', String(file.lastModified || Date.now()));
    if (albumId) form.append('albumId', albumId);
    const result = await api.upload(form, (p) => row.setProgress(p));
    if (result.duplicate) {
      stats.duplicates++;
      row.setDone('Уже есть в альбоме', 'dup');
    } else {
      stats.done++;
      row.setDone('Загружено', 'ok');
    }
  } catch (err) {
    stats.failed++;
    row.setDone(err.message || 'Ошибка', 'err');
  }
}

function finish() {
  const parts = [];
  if (stats.done) parts.push(`загружено ${fmt.items(stats.done)}`);
  if (stats.duplicates) parts.push(`дубликатов: ${stats.duplicates}`);
  if (stats.failed) parts.push(`ошибок: ${stats.failed}`);
  toast(parts.join(', ') || 'Готово', stats.failed ? 'warn' : 'ok');
  onBatchDone(stats);
  setTimeout(() => {
    if (!active && !queue.length) panel.classList.add('collapsed');
  }, 4000);
}

function ensurePanel() {
  if (panel) return;
  list = h('div', { class: 'upload-list' });
  summary = h('span', {});
  panel = h(
    'section',
    { class: 'upload-panel', 'aria-live': 'polite' },
    h(
      'header',
      { onclick: () => panel.classList.toggle('collapsed') },
      icon('upload', 18),
      summary,
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Закрыть',
          onclick: (e) => {
            e.stopPropagation();
            if (active || queue.length) return panel.classList.add('collapsed');
            panel.hidden = true;
            list.replaceChildren();
          },
        },
        icon('close', 16),
      ),
    ),
    list,
  );
  document.body.append(panel);
}

function updateSummary() {
  const finished = stats.done + stats.duplicates + stats.failed;
  summary.textContent = finished < stats.total ? `Загрузка ${finished} из ${stats.total}` : `Готово: ${finished} из ${stats.total}`;
}

function renderRow(file) {
  const preview = h('div', { class: 'upload-thumb' }, icon(file.type.startsWith('video') ? 'video' : 'photo', 18));
  const status = h('span', { class: 'upload-status' }, 'В очереди');
  const bar = h('div', { class: 'upload-bar' }, h('i'));
  const node = h('div', { class: 'upload-row' }, preview, h('div', { class: 'upload-info' }, h('b', { title: file.name }, file.name), status, bar));
  return {
    node,
    setStatus: (text) => (status.textContent = text),
    setPreview: (url) => fill(preview, h('img', { src: url, alt: '' })),
    setProgress(p) {
      status.textContent = `${Math.round(p * 100)}% · ${fmt.bytes(file.size)}`;
      bar.firstChild.style.width = `${p * 100}%`;
    },
    setDone(text, kind) {
      status.textContent = text;
      node.classList.add(`upload-${kind}`);
      bar.firstChild.style.width = '100%';
    },
  };
}

// --- Preview generation ---

async function makePreview(file) {
  if (file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(file.name)) {
    return videoPreview(file);
  }
  return imagePreview(file);
}

async function imagePreview(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const result = { width: bitmap.width, height: bitmap.height };
  result.thumb = await drawThumb(bitmap, bitmap.width, bitmap.height);
  bitmap.close?.();
  result.thumbUrl = URL.createObjectURL(result.thumb);
  return result;
}

function videoPreview(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    const timeout = setTimeout(() => done(new Error('timeout')), 15000);
    const done = (err, value) => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      err ? reject(err) : resolve(value);
    };
    video.onerror = () => done(new Error('Видео не поддерживается браузером'));
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 10);
    };
    video.onseeked = async () => {
      try {
        const thumb = await drawThumb(video, video.videoWidth, video.videoHeight);
        done(null, {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          thumb,
          thumbUrl: URL.createObjectURL(thumb),
        });
      } catch (err) {
        done(err);
      }
    };
    video.src = url;
  });
}

function drawThumb(source, width, height) {
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('thumb'))), 'image/jpeg', 0.82),
  );
}
