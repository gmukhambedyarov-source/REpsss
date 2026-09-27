// Small DOM and formatting helpers shared by all views.

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}

// Like replaceChildren, but accepts nested arrays and skips null/false.
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const ICONS = {
  timeline: '<path d="M4 5h16M4 12h16M4 19h10"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  album: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  heart: '<path d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  family: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  pause: '<path d="M7 5v14M17 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 11 7.6-3.8M8.2 13l7.6 3.8"/>',
  restore: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  slideshow: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m10 8 5 3-5 3z"/><path d="M8 21h8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  map: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

export const fmt = {
  date: (iso) => dateFmt.format(new Date(iso)),
  day: (iso) => capitalize(dayFmt.format(new Date(iso))),
  month: (iso) => capitalize(monthFmt.format(new Date(iso))),
  dateTime: (iso) => dateTimeFmt.format(new Date(iso)),
  bytes(n) {
    if (!n) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${units[i]}`;
  },
  duration(sec) {
    if (!sec) return '';
    const s = Math.round(sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  },
  plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
    return `${n.toLocaleString('ru-RU')} ${word}`;
  },
  items: (n) => fmt.plural(n, 'файл', 'файла', 'файлов'),
  yearsAgo: (iso) => {
    const years = new Date().getFullYear() - new Date(iso).getFullYear();
    return fmt.plural(years, 'год', 'года', 'лет') + ' назад';
  },
};

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Local date string (YYYY-MM-DDTHH:mm) for <input type="datetime-local">.
export function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toast(message, type = 'info') {
  const host = document.getElementById('toasts');
  const node = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  host.append(node);
  setTimeout(() => node.classList.add('hide'), 3500);
  setTimeout(() => node.remove(), 4000);
}

// Promise-based modal dialog. `body` is a node; `actions` are buttons whose
// click resolves the dialog with their `value` (after optional validation).
export function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const buttons = actions.map((a) =>
      h(
        'button',
        {
          class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
          type: a.primary ? 'submit' : 'button',
          onclick: async (e) => {
            e.preventDefault();
            if (a.validate && !(await a.validate())) return;
            close(typeof a.value === 'function' ? a.value() : a.value);
          },
        },
        a.label,
      ),
    );
    const dialog = h(
      'form',
      { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть', onclick: () => close(null) }, icon('close'))),
      h('div', { class: 'modal-body' }, body),
      buttons.length ? h('div', { class: 'modal-actions' }, buttons) : null,
    );
    backdrop.append(dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    dialog.querySelector('input, textarea, select')?.focus();
  });
}

export async function confirmDialog(title, text, label = 'Удалить', danger = true) {
  return modal({
    title,
    body: h('p', {}, text),
    actions: [
      { label: 'Отмена', value: false },
      { label, value: true, primary: !danger, danger },
    ],
  });
}

export async function promptDialog(title, { label = '', value = '', placeholder = '', textarea = false } = {}) {
  const input = textarea
    ? h('textarea', { rows: 4, placeholder })
    : h('input', { type: 'text', placeholder });
  input.value = value;
  return modal({
    title,
    body: h('label', { class: 'field' }, label ? h('span', {}, label) : null, input),
    actions: [
      { label: 'Отмена', value: null },
      { label: 'Сохранить', primary: true, value: () => input.value.trim() },
    ],
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
