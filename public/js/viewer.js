// Full-screen viewer: navigation, slideshow, details, tags, people and comments.
import { api } from './api.js';
import { h, fill, icon, fmt, toast, toLocalInput, confirmDialog } from './util.js';

const SLIDE_MS = 4000;

export function openViewer(items, index, options = {}) {
  const { readOnly = false, onChange = () => {}, onRemove = () => {}, slideshow = false } = options;
  let current = index;
  let details = null;
  let infoOpen = !readOnly && localStorage.getItem('viewer-info') === '1';
  let slideTimer = null;

  const stage = h('div', { class: 'viewer-stage' });
  const counter = h('span', { class: 'viewer-counter' });
  const favBtn = h('button', { class: 'icon-btn', title: 'В избранное (F)', onclick: () => toggleFavorite() }, icon('heart'));
  const playBtn = h('button', { class: 'icon-btn', title: 'Слайд-шоу (пробел)', onclick: () => toggleSlideshow() }, icon('slideshow'));
  const infoBtn = h('button', { class: 'icon-btn', title: 'Информация (I)', onclick: () => toggleInfo() }, icon('info'));
  const downloadBtn = h('a', { class: 'icon-btn', title: 'Скачать оригинал', download: '' }, icon('download'));
  const deleteBtn = h('button', { class: 'icon-btn', title: 'В корзину (Delete)', onclick: () => trash() }, icon('trash'));
  const panel = h('aside', { class: 'viewer-info' });
  const caption = h('div', { class: 'viewer-caption' });

  const root = h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'viewer-bar' },
      h('button', { class: 'icon-btn', title: 'Закрыть (Esc)', onclick: () => close() }, icon('close')),
      counter,
      h('div', { class: 'spacer' }),
      readOnly ? null : favBtn,
      playBtn,
      downloadBtn,
      readOnly ? null : infoBtn,
      readOnly ? null : deleteBtn,
    ),
    h('button', { class: 'viewer-nav prev', 'aria-label': 'Предыдущее', onclick: () => go(-1) }, icon('left', 32)),
    stage,
    h('button', { class: 'viewer-nav next', 'aria-label': 'Следующее', onclick: () => go(1) }, icon('right', 32)),
    panel,
  );

  const onKey = (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === ' ') {
      e.preventDefault();
      toggleSlideshow();
    } else if (!readOnly && (e.key === 'f' || e.key === 'а')) toggleFavorite();
    else if (!readOnly && (e.key === 'i' || e.key === 'ш')) toggleInfo();
    else if (!readOnly && e.key === 'Delete') trash();
  };

  // Swipe navigation on touch screens.
  let touchX = null;
  stage.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
    touchX = null;
  });

  document.addEventListener('keydown', onKey);
  document.body.append(root);
  document.body.classList.add('no-scroll');
  root.classList.toggle('info-open', infoOpen);
  show();
  if (slideshow) toggleSlideshow();

  function close() {
    stopSlideshow();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('no-scroll');
    root.remove();
  }

  function go(delta) {
    if (!items.length) return close();
    current = (current + delta + items.length) % items.length;
    show();
  }

  function show() {
    const item = items[current];
    counter.textContent = `${current + 1} / ${items.length}`;
    favBtn.classList.toggle('active', item.favorite);
    downloadBtn.href = `${item.fileUrl}?download=1`;

    let media;
    if (item.kind === 'video') {
      media = h('video', { src: item.fileUrl, controls: true, autoplay: true, playsinline: true, poster: item.hasThumb ? item.thumbUrl : null });
      if (slideTimer) media.addEventListener('ended', () => go(1));
    } else {
      // Show the preview instantly, then swap in the full image when loaded.
      media = h('img', { src: item.hasThumb ? item.thumbUrl : item.fileUrl, alt: item.title || item.name, class: 'loading' });
      const full = new Image();
      full.onload = () => {
        if (items[current] === item) {
          media.src = full.src;
          media.classList.remove('loading');
        }
      };
      full.src = item.fileUrl;
    }
    caption.textContent = item.title || '';
    caption.hidden = !item.title;
    fill(stage, media, caption);

    // Warm the cache for the neighbours.
    for (const d of [1, -1]) {
      const next = items[(current + d + items.length) % items.length];
      if (next && next.kind === 'photo') new Image().src = next.fileUrl;
    }
    if (infoOpen) loadDetails();
  }

  function toggleSlideshow() {
    if (slideTimer) return stopSlideshow();
    root.classList.add('slideshow');
    fill(playBtn, icon('pause'));
    root.requestFullscreen?.().catch(() => {});
    const tick = () => {
      slideTimer = setTimeout(() => {
        // Let videos play to the end; the 'ended' listener advances them.
        if (items[current].kind !== 'video') go(1);
        tick();
      }, SLIDE_MS);
    };
    tick();
  }

  function stopSlideshow() {
    if (!slideTimer) return;
    clearTimeout(slideTimer);
    slideTimer = null;
    root.classList.remove('slideshow');
    fill(playBtn, icon('slideshow'));
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async function toggleFavorite() {
    const item = items[current];
    const favorite = !item.favorite;
    await (favorite ? api.put(`/api/media/${item.id}/favorite`) : api.del(`/api/media/${item.id}/favorite`));
    item.favorite = favorite;
    favBtn.classList.toggle('active', favorite);
    onChange(item);
  }

  async function trash() {
    const item = items[current];
    if (!(await confirmDialog('Удалить в корзину?', 'Файл можно будет восстановить из корзины в течение 30 дней.'))) return;
    try {
      await api.del(`/api/media/${item.id}`);
      items.splice(current, 1);
      onRemove(item);
      toast('Перемещено в корзину');
      if (!items.length) return close();
      current = current % items.length;
      show();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function toggleInfo() {
    infoOpen = !infoOpen;
    localStorage.setItem('viewer-info', infoOpen ? '1' : '0');
    root.classList.toggle('info-open', infoOpen);
    if (infoOpen) loadDetails();
  }

  async function loadDetails() {
    const item = items[current];
    fill(panel, h('div', { class: 'spinner' }));
    try {
      const [info, comments] = await Promise.all([
        api.get(`/api/media/${item.id}`),
        api.get(`/api/media/${item.id}/comments`),
      ]);
      if (items[current] !== item) return;
      details = info;
      renderInfo(info, comments);
    } catch (err) {
      fill(panel, h('p', { class: 'muted' }, err.message));
    }
  }

  async function save(patch) {
    // Capture the item now: the user may move on before the request finishes.
    const item = items[current];
    try {
      const updated = await api.patch(`/api/media/${item.id}`, patch);
      Object.assign(item, updated);
      if (details?.id === item.id) details = { ...details, ...updated };
      onChange(item);
      if ('title' in patch && items[current] === item) {
        caption.textContent = updated.title;
        caption.hidden = !updated.title;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderInfo(info, comments) {
    const edit = info.canEdit;
    const title = h('input', { class: 'inline-input title', placeholder: edit ? 'Добавить название' : '', value: info.title, readonly: !edit });
    title.addEventListener('change', () => save({ title: title.value }));
    const desc = h('textarea', { class: 'inline-input', rows: 2, placeholder: edit ? 'Добавить описание' : '', readonly: !edit });
    desc.value = info.description;
    desc.addEventListener('change', () => save({ description: desc.value }));

    const date = edit
      ? h('input', { type: 'datetime-local', class: 'inline-input', value: toLocalInput(info.takenAt) })
      : h('span', {}, fmt.dateTime(info.takenAt));
    if (edit) date.addEventListener('change', () => date.value && save({ takenAt: new Date(date.value).toISOString() }));

    const facts = [
      [icon('clock', 16), date],
      [icon(info.kind === 'video' ? 'video' : 'photo', 16), h('span', {}, info.name, h('br'), h('small', {},
        [info.width && `${info.width}×${info.height}`, fmt.bytes(info.size), info.duration && fmt.duration(info.duration)].filter(Boolean).join(' · ')))],
      info.camera ? [icon('photo', 16), h('span', {}, info.camera)] : null,
      info.latitude != null
        ? [icon('map', 16), h('a', { href: `https://www.openstreetmap.org/?mlat=${info.latitude}&mlon=${info.longitude}#map=15/${info.latitude}/${info.longitude}`, target: '_blank', rel: 'noopener' }, 'Показать на карте')]
        : null,
      [icon('upload', 16), h('span', {}, `${info.ownerName || 'Неизвестно'}, ${fmt.date(info.uploadedAt)}`)],
    ].filter(Boolean);

    const commentList = h('div', { class: 'comments' }, comments.map(renderComment));
    const commentInput = h('input', { type: 'text', placeholder: 'Написать комментарий…', maxlength: 2000 });
    const commentForm = h('form', {
      class: 'comment-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = commentInput.value.trim();
        if (!text) return;
        try {
          const c = await api.post(`/api/media/${info.id}/comments`, { text });
          commentList.append(renderComment(c));
          commentInput.value = '';
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, commentInput, h('button', { class: 'btn btn-primary btn-sm' }, 'Отправить'));

    fill(panel,
      title,
      desc,
      h('ul', { class: 'facts' }, facts.map(([ic, content]) => h('li', {}, ic, content))),
      h('h4', {}, 'Люди'),
      chipEditor(info.people, edit, 'Кто на фото?', (names) => save({ people: names }), (label) => `#/label/${label.id}`),
      h('h4', {}, 'Теги'),
      chipEditor(info.tags, edit, 'Добавить тег', (names) => save({ tags: names }), (label) => `#/label/${label.id}`),
      info.albums.length ? h('h4', {}, 'В альбомах') : null,
      info.albums.length ? h('div', { class: 'chips' }, info.albums.map((a) => h('a', { class: 'chip', href: `#/album/${a.id}`, onclick: close }, a.title))) : null,
      h('h4', {}, `Комментарии${comments.length ? ` (${comments.length})` : ''}`),
      commentList,
      commentForm,
    );
  }

  function renderComment(c) {
    return h('div', { class: 'comment' }, h('b', {}, c.userName || 'Гость'), h('small', {}, fmt.dateTime(c.createdAt)), h('p', {}, c.text));
  }

  function chipEditor(labels, editable, placeholder, onSave, link) {
    const wrap = h('div', { class: 'chips' });
    const render = () => {
      fill(wrap,
        ...labels.map((l) =>
          h('span', { class: 'chip' },
            l.id ? h('a', { href: link(l), onclick: close }, l.name) : l.name,
            editable ? h('button', {
              class: 'chip-x',
              'aria-label': `Убрать ${l.name}`,
              onclick: () => {
                labels = labels.filter((x) => x !== l);
                onSave(labels.map((x) => x.name));
                render();
              },
            }, '×') : null),
        ),
      );
      if (editable) {
        const input = h('input', { class: 'chip-input', placeholder });
        input.addEventListener('keydown', (e) => {
          if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
            e.preventDefault();
            const name = input.value.trim().replace(/,$/, '');
            if (!labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
              labels = [...labels, { name }];
              onSave(labels.map((x) => x.name));
            }
            render();
            wrap.querySelector('.chip-input').focus();
          }
        });
        wrap.append(input);
      } else if (!labels.length) {
        wrap.append(h('span', { class: 'muted' }, '—'));
      }
    };
    render();
    return wrap;
  }

  return { close };
}
