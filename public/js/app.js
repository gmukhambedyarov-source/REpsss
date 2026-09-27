// Application shell: authentication, routing and all top-level views.
import { api } from './api.js';
import { h, fill, icon, fmt, toast, modal, confirmDialog, promptDialog, debounce } from './util.js';
import { MediaGrid } from './grid.js';
import { openViewer } from './viewer.js';
import { enqueue, setUploadListener } from './upload.js';

const root = document.getElementById('root');
const state = { user: null, view: null };

const NAV = [
  ['#/', 'Лента', 'timeline'],
  ['#/albums', 'Альбомы', 'album'],
  ['#/favorites', 'Избранное', 'heart'],
  ['#/people', 'Люди', 'people'],
  ['#/tags', 'Теги', 'tag'],
  ['#/videos', 'Видео', 'video'],
  ['#/trash', 'Корзина', 'trash'],
  ['#/family', 'Семья', 'family'],
];

const canUpload = () => state.user && state.user.role !== 'viewer';
const isAdmin = () => state.user?.role === 'admin';

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(localStorage.getItem('theme'));

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

// ---------------------------------------------------------------- boot

api.onUnauthorized = () => {
  if (state.user) {
    state.user = null;
    route();
  }
};

async function boot() {
  const status = await api.get('/api/auth/status');
  state.user = status.user;
  state.needsSetup = status.needsSetup;
  window.addEventListener('hashchange', route);
  setUploadListener(() => state.view?.reload?.());
  setupDragAndDrop();
  route();
}

function route() {
  const hash = location.hash || '#/';
  const [path, queryString] = hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(queryString || '');

  if (parts[0] === 's' && parts[1]) return mount(sharedView(parts[1]), { bare: true });
  if (!state.user) {
    const invite = parts[0] === 'join' ? parts[1] : '';
    return mount(authView(invite), { bare: true });
  }
  if (parts[0] === 'join') return (location.hash = '#/');

  const views = {
    '': () => timelineView(),
    albums: () => albumsView(),
    album: () => albumView(Number(parts[1])),
    favorites: () => gridPage({
      title: 'Избранное',
      params: { favorite: true },
      emptyText: 'Нажмите ♥ в просмотре, чтобы добавить снимок в избранное',
    }),
    people: () => labelsView('person'),
    tags: () => labelsView('tag'),
    label: () => labelView(Number(parts[1])),
    videos: () => gridPage({ title: 'Видео', params: { kind: 'video' }, emptyText: 'Видео пока нет' }),
    search: () => gridPage({
      title: `Поиск: «${params.get('q') || ''}»`,
      params: { q: params.get('q') || '' },
      emptyText: 'Ничего не найдено',
    }),
    trash: () => trashView(),
    family: () => familyView(),
  };
  const factory = views[parts[0] || ''] || views[''];
  mount(factory(), { active: `#/${parts[0] === 'album' ? 'albums' : parts[0] === 'label' ? 'people' : parts[0] || ''}` });
}

// A view is { node, reload?, destroy?, albumId? }.
function mount(view, { bare = false, active } = {}) {
  state.view?.destroy?.();
  state.view = view;
  closeSelectionBar();
  if (bare) {
    fill(root, view.node);
    return;
  }
  if (!root.querySelector('.layout')) fill(root, layout());
  root.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === active));
  root.querySelector('.layout').classList.remove('nav-open');
  fill(root.querySelector('.content'), view.node);
  const search = root.querySelector('.search input');
  if (!location.hash.startsWith('#/search')) search.value = '';
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- layout

function layout() {
  const fileInput = h('input', {
    type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true,
    onchange: () => {
      enqueue(fileInput.files, { albumId: state.view?.albumId });
      fileInput.value = '';
    },
  });
  const search = h('input', { type: 'search', placeholder: 'Поиск по названиям, людям, тегам, альбомам…', 'aria-label': 'Поиск' });
  const doSearch = debounce(() => {
    const q = search.value.trim();
    if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
  }, 400);
  search.addEventListener('input', doSearch);

  const layoutNode = h(
    'div',
    { class: 'layout' },
    h(
      'nav',
      { class: 'sidebar' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('heart', 18)), 'Семейный альбом'),
      h('div', { class: 'nav' }, NAV.map(([href, label, ic]) => h('a', { href }, icon(ic), label))),
      h('div', { class: 'sidebar-foot' },
        h('div', { class: 'me' }, h('span', { class: 'avatar' }, state.user.name.slice(0, 1).toUpperCase()),
          h('div', {}, h('b', {}, state.user.name), h('small', {}, roleName(state.user.role)))),
        h('button', { class: 'icon-btn', title: 'Выйти', onclick: logout }, icon('logout'))),
    ),
    h('div', { class: 'nav-scrim', onclick: () => layoutNode.classList.remove('nav-open') }),
    h(
      'main',
      { class: 'main' },
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Меню', onclick: () => layoutNode.classList.toggle('nav-open') }, icon('menu')),
        h('label', { class: 'search' }, icon('search', 18), search),
        h('button', { class: 'icon-btn', title: 'Сменить тему', onclick: toggleTheme }, icon('moon')),
        canUpload()
          ? h('button', { class: 'btn btn-primary', onclick: () => fileInput.click() }, icon('upload', 18), h('span', { class: 'hide-sm' }, 'Загрузить'))
          : null,
        fileInput,
      ),
      h('div', { class: 'content' }),
    ),
  );
  return layoutNode;
}

function roleName(role) {
  return { admin: 'Администратор', member: 'Участник', viewer: 'Только просмотр' }[role] || role;
}

async function logout() {
  await api.post('/api/auth/logout');
  state.user = null;
  location.hash = '#/';
  root.replaceChildren();
  route();
}

function setupDragAndDrop() {
  const overlay = h('div', { class: 'drop-overlay' }, h('div', {}, icon('upload', 48), h('p', {}, 'Отпустите файлы, чтобы загрузить')));
  document.body.append(overlay);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !canUpload() || !root.querySelector('.layout')) return;
    depth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
    if (canUpload() && root.querySelector('.layout')) enqueue(e.dataTransfer.files, { albumId: state.view?.albumId });
  });
}

// ---------------------------------------------------------------- auth

function authView(invite) {
  let mode = state.needsSetup ? 'setup' : invite ? 'register' : 'login';
  const node = h('div', { class: 'auth' });

  const render = () => {
    const fields = {
      name: h('input', { name: 'name', required: true, autocomplete: 'name' }),
      email: h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' }),
      password: h('input', { name: 'password', type: 'password', required: true, minlength: 6, autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
      invite: h('input', { name: 'invite', required: true, value: invite }),
    };
    const error = h('p', { class: 'form-error' });
    const titles = {
      setup: ['Добро пожаловать!', 'Создайте первую учётную запись — она станет администратором семейного альбома.'],
      register: ['Присоединиться к семье', 'Введите код приглашения, который вам прислали родные.'],
      login: ['Вход', 'Семейный архив фотографий и видео'],
    };
    const form = h(
      'form',
      {
        class: 'auth-card',
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          const body = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value]));
          try {
            const res = await api.post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', body);
            state.user = res.user;
            state.needsSetup = false;
            if (location.hash.startsWith('#/join')) location.hash = '#/';
            route();
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      h('div', { class: 'brand-mark big' }, icon('heart', 28)),
      h('h1', {}, titles[mode][0]),
      h('p', { class: 'muted' }, titles[mode][1]),
      mode !== 'login' ? h('label', { class: 'field' }, h('span', {}, 'Имя'), fields.name) : null,
      h('label', { class: 'field' }, h('span', {}, 'E-mail'), fields.email),
      h('label', { class: 'field' }, h('span', {}, 'Пароль'), fields.password),
      mode === 'register' ? h('label', { class: 'field' }, h('span', {}, 'Код приглашения'), fields.invite) : null,
      error,
      h('button', { class: 'btn btn-primary btn-block' }, mode === 'login' ? 'Войти' : 'Создать аккаунт'),
      mode === 'setup' ? null : h('button', {
        type: 'button',
        class: 'link',
        onclick: () => {
          mode = mode === 'login' ? 'register' : 'login';
          render();
        },
      }, mode === 'login' ? 'У меня есть приглашение' : 'Уже есть аккаунт? Войти'),
    );
    fill(node, form);
  };
  render();
  return { node };
}

// ---------------------------------------------------------------- selection bar

let selectionBar = null;

function closeSelectionBar() {
  selectionBar?.remove();
  selectionBar = null;
}

// Shows a contextual toolbar while items are selected in a grid.
function bindSelection(grid, actions) {
  grid.onSelectionChange = (ids) => {
    if (!ids.length) return closeSelectionBar();
    if (!selectionBar) {
      selectionBar = h('div', { class: 'selection-bar' });
      document.body.append(selectionBar);
    }
    fill(selectionBar,
      h('button', { class: 'icon-btn', title: 'Снять выделение', onclick: () => grid.clearSelection() }, icon('close')),
      h('b', {}, `Выбрано: ${ids.length}`),
      h('button', { class: 'btn btn-ghost btn-sm hide-sm', onclick: () => grid.selectAll() }, 'Выбрать все'),
      h('div', { class: 'spacer' }),
      actions
        .filter((a) => !a.when || a.when())
        .map((a) =>
          h('button', {
            class: `btn btn-ghost btn-sm ${a.danger ? 'danger' : ''}`,
            title: a.label,
            onclick: async () => {
              try {
                await a.run(grid.selectedItems(), grid);
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, icon(a.icon, 18), h('span', { class: 'hide-sm' }, a.label)),
        ),
    );
  };
}

const bulk = (ids, action, extra = {}) => api.post('/api/media/bulk', { ids, action, ...extra });

async function pickAlbum() {
  const albums = await api.get('/api/albums');
  const select = h('select', {}, h('option', { value: '' }, '+ Новый альбом…'), albums.map((a) => h('option', { value: a.id }, a.title)));
  const name = h('input', { placeholder: 'Название нового альбома' });
  select.addEventListener('change', () => (name.hidden = Boolean(select.value)));
  if (albums.length) select.value = albums[0].id;
  name.hidden = Boolean(select.value);
  const result = await modal({
    title: 'Добавить в альбом',
    body: h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Альбом'), select), name),
    actions: [
      { label: 'Отмена', value: null },
      { label: 'Добавить', primary: true, value: () => ({ id: select.value, title: name.value.trim() }) },
    ],
  });
  if (!result) return null;
  if (result.id) return Number(result.id);
  if (!result.title) return null;
  return (await api.post('/api/albums', { title: result.title })).id;
}

function downloadItems(items) {
  // Browsers throttle bursts of downloads, so space them out a little.
  items.forEach((item, i) =>
    setTimeout(() => h('a', { href: `${item.fileUrl}?download=1`, download: '' }).click(), i * 400),
  );
}

// Actions available for any regular (non-trash) selection.
function commonActions(extra = []) {
  return [
    ...extra,
    {
      label: 'В альбом', icon: 'album', when: canUpload,
      async run(items, grid) {
        const albumId = await pickAlbum();
        if (!albumId) return;
        await bulk(items.map((i) => i.id), 'addToAlbum', { albumId });
        toast(`Добавлено в альбом: ${fmt.items(items.length)}`, 'ok');
        grid.clearSelection();
      },
    },
    {
      label: 'Отметить человека', icon: 'people', when: canUpload,
      async run(items, grid) {
        const name = await promptDialog('Кто на этих фото?', { label: 'Имя', placeholder: 'Например, Бабушка Валя' });
        if (!name) return;
        const res = await bulk(items.map((i) => i.id), 'addPerson', { name });
        toast(`Отмечено: ${fmt.items(res.affected)}${res.skipped ? `, без прав: ${res.skipped}` : ''}`, 'ok');
        grid.clearSelection();
      },
    },
    {
      label: 'Тег', icon: 'tag', when: canUpload,
      async run(items, grid) {
        const name = await promptDialog('Добавить тег', { label: 'Тег', placeholder: 'Например, Новый год' });
        if (!name) return;
        const res = await bulk(items.map((i) => i.id), 'addTag', { name });
        toast(`Тег добавлен: ${fmt.items(res.affected)}${res.skipped ? `, без прав: ${res.skipped}` : ''}`, 'ok');
        grid.clearSelection();
      },
    },
    {
      label: 'В избранное', icon: 'heart',
      async run(items, grid) {
        const allFav = items.every((i) => i.favorite);
        await bulk(items.map((i) => i.id), allFav ? 'unfavorite' : 'favorite');
        items.forEach((i) => grid.updateItem({ id: i.id, favorite: !allFav }));
        grid.clearSelection();
      },
    },
    {
      label: 'Скачать', icon: 'download',
      run(items) {
        downloadItems(items);
      },
    },
    {
      label: 'Удалить', icon: 'trash', danger: true, when: canUpload,
      async run(items, grid) {
        if (!(await confirmDialog('Переместить в корзину?', `${fmt.items(items.length)} будут в корзине 30 дней.`))) return;
        const res = await bulk(items.map((i) => i.id), 'trash');
        const removed = res.skipped ? items.filter((i) => canEditLocally(i)).map((i) => i.id) : items.map((i) => i.id);
        grid.removeItems(removed);
        toast(res.skipped ? `Можно удалять только свои файлы. Пропущено: ${res.skipped}` : 'Перемещено в корзину', res.skipped ? 'warn' : 'ok');
      },
    },
  ];
}

function canEditLocally(item) {
  return isAdmin() || item.ownerId === state.user.id;
}

// ---------------------------------------------------------------- grid pages

function createGrid({ params = {}, groupBy = 'day', emptyText, readOnly = false }) {
  const grid = new MediaGrid({
    groupBy,
    emptyText,
    fetchPage: (offset, limit) => api.get(`/api/media${api.query({ ...params, offset, limit })}`),
    onOpen: (index, items) =>
      openViewer(items.slice(), index, {
        readOnly,
        onChange: (item) => grid.updateItem(item),
        onRemove: (item) => grid.removeItems([item.id]),
      }),
  });
  return grid;
}

function pageHeader(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    h('div', { class: 'page-actions' }, actions));
}

function gridPage({ title, params, emptyText, groupBy = 'day', extraActions = [], head }) {
  const grid = createGrid({ params, emptyText, groupBy });
  bindSelection(grid, commonActions(extraActions));
  const subtitle = h('p', { class: 'muted' });
  const node = h('div', {}, head || pageHeader(title, null), head ? null : subtitle, grid.el);
  const reload = async () => {
    await grid.reload();
    subtitle.textContent = grid.total ? fmt.items(grid.total) : '';
  };
  reload();
  return { node, reload, destroy: () => grid.destroy(), grid };
}

// ---------------------------------------------------------------- timeline

function timelineView() {
  const filters = { kind: '', sort: 'taken_desc', from: '', to: '' };
  const memories = h('div');
  const summary = h('p', { class: 'muted' });
  let grid = createGrid({ params: filters, emptyText: 'Загрузите первые фотографии — перетащите их в окно или нажмите «Загрузить»' });
  bindSelection(grid, commonActions());
  const gridHost = h('div', {}, grid.el);

  const chip = (label, kind) =>
    h('button', {
      class: `chip-btn ${filters.kind === kind ? 'active' : ''}`,
      onclick: (e) => {
        filters.kind = kind;
        e.target.parentNode.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('active', b === e.target));
        refresh();
      },
    }, label);

  const sort = h('select', { 'aria-label': 'Сортировка', onchange: () => ((filters.sort = sort.value), refresh()) },
    h('option', { value: 'taken_desc' }, 'Сначала новые'),
    h('option', { value: 'taken_asc' }, 'Сначала старые'),
    h('option', { value: 'uploaded_desc' }, 'Недавно загруженные'));
  const from = h('input', { type: 'date', 'aria-label': 'С даты', onchange: () => ((filters.from = from.value), refresh()) });
  const to = h('input', { type: 'date', 'aria-label': 'По дату', onchange: () => ((filters.to = to.value), refresh()) });

  function refresh() {
    grid.destroy();
    grid = createGrid({
      params: filters,
      groupBy: filters.sort === 'uploaded_desc' ? 'none' : 'day',
      emptyText: 'По выбранным условиям ничего нет',
    });
    bindSelection(grid, commonActions());
    fill(gridHost, grid.el);
    load();
  }

  async function load() {
    await grid.reload();
    const stats = await api.get('/api/stats');
    summary.textContent = `${fmt.plural(stats.photos, 'фото', 'фото', 'фото')} · ${fmt.plural(stats.videos, 'видео', 'видео', 'видео')} · ${fmt.bytes(stats.bytes)}`;
  }

  async function loadMemories() {
    const { items } = await api.get('/api/media/memories');
    if (!items.length) return memories.replaceChildren();
    const byYear = new Map();
    for (const item of items) {
      const year = item.takenAt.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(item);
    }
    fill(memories,
      h('section', { class: 'memories' },
        h('h2', {}, 'В этот день'),
        h('div', { class: 'memories-row' },
          [...byYear.values()].map((group) =>
            h('button', {
              class: 'memory',
              onclick: () => openViewer(group, 0, { slideshow: true, onChange: (i) => grid.updateItem(i) }),
            },
            h('img', { src: group[0].thumbUrl, alt: '', loading: 'lazy' }),
            h('span', {}, fmt.yearsAgo(group[0].takenAt), h('small', {}, fmt.items(group.length))))))),
    );
  }

  const node = h('div', {},
    memories,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Лента'), summary),
      h('div', { class: 'filters' },
        h('div', { class: 'chip-group' }, chip('Все', ''), chip('Фото', 'photo'), chip('Видео', 'video')),
        sort,
        h('span', { class: 'date-range' }, from, '—', to))),
    gridHost);

  load();
  loadMemories();
  return {
    node,
    reload: () => {
      load();
      loadMemories();
    },
    destroy: () => grid.destroy(),
  };
}

// ---------------------------------------------------------------- albums

function albumsView() {
  const list = h('div', { class: 'cards' });
  const node = h('div', {},
    pageHeader('Альбомы', 'Путешествия, праздники, дни рождения — собирайте события вместе',
      canUpload() ? h('button', { class: 'btn btn-primary', onclick: createAlbum }, icon('plus', 18), 'Новый альбом') : null),
    list);

  async function createAlbum() {
    const title = h('input', { required: true, placeholder: 'Например, Лето в деревне 2024' });
    const description = h('textarea', { rows: 3, placeholder: 'Пара слов об этом событии (необязательно)' });
    const result = await modal({
      title: 'Новый альбом',
      body: h('div', {},
        h('label', { class: 'field' }, h('span', {}, 'Название'), title),
        h('label', { class: 'field' }, h('span', {}, 'Описание'), description)),
      actions: [
        { label: 'Отмена', value: null },
        { label: 'Создать', primary: true, validate: () => Boolean(title.value.trim()), value: () => ({ title: title.value, description: description.value }) },
      ],
    });
    if (!result) return;
    const album = await api.post('/api/albums', result);
    location.hash = `#/album/${album.id}`;
  }

  async function load() {
    const albums = await api.get('/api/albums');
    if (!albums.length) {
      fill(list, h('div', { class: 'empty' }, icon('album', 48), h('p', {}, 'Альбомов пока нет')));
      return;
    }
    fill(list, ...albums.map((a) =>
      h('a', { class: 'card', href: `#/album/${a.id}` },
        h('div', { class: 'card-cover' },
          a.coverId ? h('img', { src: `/api/media/${a.coverId}/thumb`, alt: '', loading: 'lazy' }) : icon('album', 40),
          a.shareToken ? h('span', { class: 'card-badge', title: 'Доступен по ссылке' }, icon('share', 14)) : null),
        h('div', { class: 'card-body' },
          h('b', {}, a.title),
          h('small', { class: 'muted' }, [fmt.items(a.count), a.startDate && dateSpan(a.startDate, a.endDate)].filter(Boolean).join(' · '))))));
  }
  load();
  return { node, reload: load };
}

function dateSpan(start, end) {
  const s = fmt.date(start);
  const e = fmt.date(end);
  return s === e ? s : `${s} — ${e}`;
}

function albumView(id) {
  const view = gridPage({
    params: { album: id, sort: 'taken_asc' },
    emptyText: 'Альбом пуст. Загрузите файлы прямо сюда или добавьте их из ленты через выделение.',
    head: h('div'),
    extraActions: [
      {
        label: 'Убрать из альбома', icon: 'close', when: canUpload,
        async run(items, grid) {
          await api.del(`/api/albums/${id}/media`, { ids: items.map((i) => i.id) });
          grid.removeItems(items.map((i) => i.id));
          loadHead();
        },
      },
      {
        label: 'Сделать обложкой', icon: 'photo', when: canUpload,
        async run(items, grid) {
          await api.patch(`/api/albums/${id}`, { coverId: items[0].id });
          toast('Обложка обновлена', 'ok');
          grid.clearSelection();
        },
      },
    ],
  });
  view.albumId = id;
  const head = view.node.firstChild;

  async function loadHead() {
    let album;
    try {
      album = await api.get(`/api/albums/${id}`);
    } catch (err) {
      fill(head, pageHeader('Альбом не найден', err.message));
      return;
    }
    const actions = [
      h('button', { class: 'btn', onclick: () => view.grid.items.length && openViewer(view.grid.items.slice(), 0, { slideshow: true }) }, icon('slideshow', 18), 'Слайд-шоу'),
      canUpload() ? h('button', { class: 'btn', onclick: () => root.querySelector('.topbar input[type=file]').click() }, icon('upload', 18), 'Добавить') : null,
      album.canEdit ? h('button', { class: 'btn', onclick: () => shareAlbum(album) }, icon('share', 18), album.shareToken ? 'Ссылка' : 'Поделиться') : null,
      album.canEdit ? h('button', { class: 'icon-btn', title: 'Редактировать', onclick: () => editAlbum(album) }, icon('edit')) : null,
      album.canEdit ? h('button', { class: 'icon-btn', title: 'Удалить альбом', onclick: () => deleteAlbum(album) }, icon('trash')) : null,
    ];
    const subtitle = [fmt.items(album.count), album.startDate && dateSpan(album.startDate, album.endDate), album.ownerName && `создал(а) ${album.ownerName}`]
      .filter(Boolean).join(' · ');
    fill(head,
      h('a', { class: 'back', href: '#/albums' }, icon('left', 16), 'Все альбомы'),
      pageHeader(album.title, subtitle, ...actions),
      album.description ? h('p', { class: 'album-desc' }, album.description) : null,
    );
  }

  async function editAlbum(album) {
    const title = h('input', { value: album.title });
    const description = h('textarea', { rows: 4 });
    description.value = album.description;
    const result = await modal({
      title: 'Редактировать альбом',
      body: h('div', {},
        h('label', { class: 'field' }, h('span', {}, 'Название'), title),
        h('label', { class: 'field' }, h('span', {}, 'Описание'), description)),
      actions: [
        { label: 'Отмена', value: null },
        { label: 'Сохранить', primary: true, value: () => ({ title: title.value, description: description.value }) },
      ],
    });
    if (!result) return;
    await api.patch(`/api/albums/${id}`, result);
    loadHead();
  }

  async function deleteAlbum(album) {
    if (!(await confirmDialog('Удалить альбом?', `Альбом «${album.title}» будет удалён. Сами фотографии и видео останутся в ленте.`))) return;
    await api.del(`/api/albums/${id}`);
    location.hash = '#/albums';
  }

  async function shareAlbum(album) {
    let token = album.shareToken;
    if (!token) token = (await api.post(`/api/albums/${id}/share`)).shareToken;
    const url = `${location.origin}${location.pathname}#/s/${token}`;
    const input = h('input', { value: url, readonly: true, onfocus: (e) => e.target.select() });
    const result = await modal({
      title: 'Ссылка на альбом',
      body: h('div', {},
        h('p', {}, 'Любой, у кого есть эта ссылка, сможет смотреть и скачивать файлы альбома без регистрации.'),
        input),
      actions: [
        { label: 'Закрыть доступ', danger: true, value: 'revoke' },
        { label: 'Копировать', primary: true, value: 'copy' },
      ],
    });
    if (result === 'copy') {
      await navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована', 'ok'), () => toast(url));
    } else if (result === 'revoke') {
      await api.del(`/api/albums/${id}/share`);
      toast('Доступ по ссылке закрыт', 'ok');
    }
    loadHead();
  }

  loadHead();
  const reload = view.reload;
  view.reload = async () => {
    await reload();
    loadHead();
  };
  return view;
}

// ---------------------------------------------------------------- people & tags

function labelsView(kind) {
  const isPeople = kind === 'person';
  const list = h('div', { class: isPeople ? 'people' : 'cards' });
  const node = h('div', {},
    pageHeader(isPeople ? 'Люди' : 'Теги',
      isPeople ? 'Отмечайте родных на фото в режиме просмотра или через выделение нескольких снимков' : 'Теги помогают быстро находить события и темы'),
    list);
  api.get(`/api/labels?kind=${kind}`).then((labels) => {
    if (!labels.length) {
      fill(list, h('div', { class: 'empty' }, icon(isPeople ? 'people' : 'tag', 48), h('p', {}, isPeople ? 'Пока никто не отмечен' : 'Тегов пока нет')));
      return;
    }
    fill(list, ...labels.map((l) =>
      isPeople
        ? h('a', { class: 'person', href: `#/label/${l.id}` },
          h('span', { class: 'person-photo' }, l.coverId ? h('img', { src: `/api/media/${l.coverId}/thumb`, alt: '', loading: 'lazy' }) : icon('people', 32)),
          h('b', {}, l.name), h('small', { class: 'muted' }, fmt.items(l.count)))
        : h('a', { class: 'card', href: `#/label/${l.id}` },
          h('div', { class: 'card-cover' }, l.coverId ? h('img', { src: `/api/media/${l.coverId}/thumb`, alt: '', loading: 'lazy' }) : icon('tag', 40)),
          h('div', { class: 'card-body' }, h('b', {}, `#${l.name}`), h('small', { class: 'muted' }, fmt.items(l.count))))));
  });
  return { node };
}

function labelView(id) {
  const head = h('div');
  const view = gridPage({ params: { label: id }, head, emptyText: 'Нет файлов' });
  api.get('/api/labels').then((labels) => {
    const label = labels.find((l) => l.id === id);
    if (!label) return fill(head, pageHeader('Не найдено', null));
    const isPeople = label.kind === 'person';
    fill(head,
      h('a', { class: 'back', href: isPeople ? '#/people' : '#/tags' }, icon('left', 16), isPeople ? 'Люди' : 'Теги'),
      pageHeader(isPeople ? label.name : `#${label.name}`, fmt.items(label.count),
        h('button', { class: 'btn', onclick: () => openViewer(view.grid.items.slice(), 0, { slideshow: true }) }, icon('slideshow', 18), 'Слайд-шоу'),
        canUpload() ? h('button', {
          class: 'icon-btn', title: 'Переименовать',
          async onclick() {
            const name = await promptDialog('Переименовать', { value: label.name });
            if (!name) return;
            const res = await api.patch(`/api/labels/${id}`, { name });
            if (res.merged) toast('Объединено с существующей записью', 'ok');
            location.hash = `#/label/${res.id}`;
            if (res.id === id) route();
          },
        }, icon('edit')) : null,
        canUpload() ? h('button', {
          class: 'icon-btn', title: 'Удалить',
          async onclick() {
            if (!(await confirmDialog('Удалить отметку?', `«${label.name}» будет снято со всех файлов. Сами файлы останутся.`))) return;
            await api.del(`/api/labels/${id}`);
            location.hash = isPeople ? '#/people' : '#/tags';
          },
        }, icon('trash')) : null),
    );
  });
  return view;
}

// ---------------------------------------------------------------- trash

function trashView() {
  const grid = createGrid({ params: { trash: true, sort: 'uploaded_desc' }, groupBy: 'none', emptyText: 'Корзина пуста', readOnly: true });
  const permanentDelete = async (items) => {
    if (!(await confirmDialog('Удалить навсегда?', `${fmt.items(items.length)} будут удалены без возможности восстановления.`))) return;
    const res = await bulk(items.map((i) => i.id), 'delete');
    await grid.reload();
    toast(res.skipped ? `Удалено: ${res.affected}, без прав: ${res.skipped}` : 'Удалено навсегда', 'ok');
  };
  bindSelection(grid, [
    {
      label: 'Восстановить', icon: 'restore', when: canUpload,
      async run(items) {
        const res = await bulk(items.map((i) => i.id), 'restore');
        await grid.reload();
        toast(`Восстановлено: ${fmt.items(res.affected)}`, 'ok');
      },
    },
    { label: 'Удалить навсегда', icon: 'trash', danger: true, when: canUpload, run: permanentDelete },
  ]);
  const node = h('div', {},
    pageHeader('Корзина', 'Файлы удаляются автоматически через 30 дней. Выделите файлы, чтобы восстановить их.',
      canUpload() ? h('button', { class: 'btn btn-danger', onclick: () => grid.items.length && permanentDelete(grid.items) }, 'Очистить корзину') : null),
    grid.el);
  grid.reload();
  return { node, reload: () => grid.reload(), destroy: () => grid.destroy() };
}

// ---------------------------------------------------------------- family

function familyView() {
  const node = h('div', {}, pageHeader('Семья', 'Участники, приглашения и статистика архива'));
  const statsBox = h('div');
  const membersBox = h('div');
  const invitesBox = h('div');
  node.append(statsBox, membersBox, isAdmin() ? invitesBox : null, accountBox());

  async function loadStats() {
    const s = await api.get('/api/stats');
    const maxYear = Math.max(1, ...s.byYear.map((y) => y.count));
    fill(statsBox,
      h('div', { class: 'stat-row' },
        stat(s.photos.toLocaleString('ru-RU'), 'фото'),
        stat(s.videos.toLocaleString('ru-RU'), 'видео'),
        stat(s.albums.toLocaleString('ru-RU'), 'альбомов'),
        stat(s.people.toLocaleString('ru-RU'), 'человек отмечено'),
        stat(fmt.bytes(s.bytes), 'занято')),
      s.byYear.length
        ? h('section', { class: 'panel' }, h('h2', {}, 'По годам'),
          h('div', { class: 'bars' }, s.byYear.map((y) =>
            h('a', { class: 'bar-row', href: `#/search?q=`, onclick: (e) => { e.preventDefault(); openYear(y.year); } },
              h('span', {}, y.year),
              h('span', { class: 'bar' }, h('i', { style: { width: `${(y.count / maxYear) * 100}%` } })),
              h('b', {}, y.count.toLocaleString('ru-RU'))))))
        : null,
    );
  }

  function openYear(year) {
    mount(gridPage({ title: `${year} год`, params: { from: `${year}-01-01`, to: `${year}-12-31` }, groupBy: 'month' }), { active: '#/family' });
  }

  async function loadMembers() {
    const users = await api.get('/api/auth/users');
    fill(membersBox, h('section', { class: 'panel' }, h('h2', {}, 'Участники'),
      h('div', { class: 'members' }, users.map((u) =>
        h('div', { class: 'member' },
          h('span', { class: 'avatar' }, u.name.slice(0, 1).toUpperCase()),
          h('div', { class: 'member-info' }, h('b', {}, u.name), h('small', { class: 'muted' }, `${u.email} · ${fmt.items(u.media_count)}`)),
          isAdmin() && u.id !== state.user.id
            ? h('select', {
              'aria-label': 'Роль',
              async onchange(e) {
                await api.patch(`/api/auth/users/${u.id}`, { role: e.target.value });
                toast('Роль изменена', 'ok');
              },
            }, ['admin', 'member', 'viewer'].map((r) => h('option', { value: r, selected: r === u.role }, roleName(r))))
            : h('span', { class: 'role' }, roleName(u.role)),
          isAdmin() && u.id !== state.user.id
            ? h('button', {
              class: 'icon-btn', title: 'Удалить участника',
              async onclick() {
                if (!(await confirmDialog('Удалить участника?', `${u.name} потеряет доступ. Загруженные файлы останутся в альбоме.`))) return;
                await api.del(`/api/auth/users/${u.id}`);
                loadMembers();
              },
            }, icon('trash', 18))
            : null)))));
  }

  async function loadInvites() {
    const invites = await api.get('/api/auth/invites');
    const role = h('select', {}, h('option', { value: 'member' }, 'Участник (может загружать)'), h('option', { value: 'viewer' }, 'Только просмотр'), h('option', { value: 'admin' }, 'Администратор'));
    const inviteUrl = (code) => `${location.origin}${location.pathname}#/join/${code}`;
    fill(invitesBox, h('section', { class: 'panel' }, h('h2', {}, 'Приглашения'),
      h('p', { class: 'muted' }, 'Создайте приглашение и отправьте ссылку родственнику — по ней он сможет зарегистрироваться.'),
      h('div', { class: 'inline-form' }, role, h('button', {
        class: 'btn btn-primary',
        async onclick() {
          const inv = await api.post('/api/auth/invites', { role: role.value });
          await navigator.clipboard?.writeText(inviteUrl(inv.code)).then(() => toast('Ссылка-приглашение скопирована', 'ok'), () => {});
          loadInvites();
        },
      }, icon('plus', 18), 'Создать приглашение')),
      invites.length ? h('div', { class: 'invites' }, invites.map((i) =>
        h('div', { class: `invite ${i.used_by_name ? 'used' : ''}` },
          h('code', {}, i.code),
          h('small', { class: 'muted' }, `${roleName(i.role)} · ${i.used_by_name ? `использовано: ${i.used_by_name}` : 'ожидает'}`),
          h('div', { class: 'spacer' }),
          i.used_by_name ? null : h('button', { class: 'btn btn-sm', onclick: () => navigator.clipboard?.writeText(inviteUrl(i.code)).then(() => toast('Скопировано', 'ok')) }, 'Копировать ссылку'),
          h('button', { class: 'icon-btn', title: 'Удалить', onclick: async () => { await api.del(`/api/auth/invites/${i.code}`); loadInvites(); } }, icon('close', 16))))) : null));
  }

  function accountBox() {
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6 });
    return h('section', { class: 'panel' }, h('h2', {}, 'Мой аккаунт'),
      h('p', { class: 'muted' }, `${state.user.name} · ${state.user.email} · ${roleName(state.user.role)}`),
      h('form', {
        class: 'inline-form',
        async onsubmit(e) {
          e.preventDefault();
          try {
            await api.post('/api/auth/password', { currentPassword: current.value, newPassword: next.value });
            current.value = next.value = '';
            toast('Пароль изменён', 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      h('label', { class: 'field' }, h('span', {}, 'Текущий пароль'), current),
      h('label', { class: 'field' }, h('span', {}, 'Новый пароль'), next),
      h('button', { class: 'btn' }, 'Сменить пароль')));
  }

  loadStats();
  loadMembers();
  if (isAdmin()) loadInvites();
  return { node, reload: loadStats };
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
}

// ---------------------------------------------------------------- shared album (public)

function sharedView(token) {
  const node = h('div', { class: 'shared' }, h('div', { class: 'spinner' }));
  api.get(`/api/shared/${encodeURIComponent(token)}`).then(({ album, items }) => {
    const grid = new MediaGrid({
      groupBy: 'none',
      fetchPage: async () => ({ items, total: items.length }),
      onOpen: (index) => openViewer(items, index, { readOnly: true }),
    });
    grid.reload();
    fill(node,
      h('header', { class: 'shared-head' },
        h('span', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('heart', 18)), 'Семейный альбом'),
        h('button', { class: 'icon-btn', title: 'Сменить тему', onclick: toggleTheme }, icon('moon'))),
      h('div', { class: 'shared-body' },
        pageHeader(album.title, [fmt.items(items.length), items.length && dateSpan(items[0].takenAt, items[items.length - 1].takenAt)].filter(Boolean).join(' · '),
          items.length ? h('button', { class: 'btn btn-primary', onclick: () => openViewer(items, 0, { readOnly: true, slideshow: true }) }, icon('slideshow', 18), 'Слайд-шоу') : null),
        album.description ? h('p', { class: 'album-desc' }, album.description) : null,
        grid.el),
    );
  }).catch(() => {
    fill(node, h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
      h('div', { class: 'brand-mark big' }, icon('album', 28)),
      h('h1', {}, 'Ссылка недействительна'),
      h('p', { class: 'muted' }, 'Возможно, владелец альбома закрыл к нему доступ.'))));
  });
  return { node };
}

boot().catch((err) => {
  fill(root, h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, h('h1', {}, 'Не удалось загрузить приложение'), h('p', {}, err.message))));
});
