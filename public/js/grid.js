// Media grid with day grouping, infinite scroll and multi-select.
import { h, fill, icon, fmt } from './util.js';

const PAGE = 120;

export class MediaGrid {
  constructor({ fetchPage, groupBy = 'day', onOpen, onSelectionChange, emptyText = 'Здесь пока пусто' }) {
    this.fetchPage = fetchPage;
    this.groupBy = groupBy;
    this.onOpen = onOpen;
    this.onSelectionChange = onSelectionChange || (() => {});
    this.emptyText = emptyText;
    this.items = [];
    this.total = 0;
    this.selected = new Set();
    this.lastClicked = null;
    this.loading = false;
    this.done = false;
    this.started = false;
    this.generation = 0;
    this.groups = new Map();
    this.el = h('div', { class: 'grid-host' });
    this.body = h('div', { class: 'grid-body' });
    this.sentinel = h('div', { class: 'grid-sentinel' });
    this.el.append(this.body, this.sentinel);
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadMore();
    }, { rootMargin: '800px' });
    this.observer.observe(this.sentinel);
  }

  destroy() {
    this.observer.disconnect();
  }

  get selectionMode() {
    return this.selected.size > 0;
  }

  async reload() {
    this.started = true;
    this.generation++;
    this.loading = false;
    this.items = [];
    this.total = 0;
    this.done = false;
    this.body.replaceChildren();
    this.groups = new Map();
    this.clearSelection();
    await this.loadMore();
  }

  async loadMore() {
    if (!this.started || this.loading || this.done) return;
    const generation = this.generation;
    this.loading = true;
    this.sentinel.classList.add('loading');
    try {
      const page = await this.fetchPage(this.items.length, PAGE);
      if (generation !== this.generation) return; // a reload happened meanwhile
      this.total = page.total ?? page.items.length;
      const start = this.items.length;
      this.items.push(...page.items);
      this.done = page.items.length < PAGE || this.items.length >= this.total;
      this.renderItems(page.items, start);
      if (!this.items.length) fill(this.body, h('div', { class: 'empty' }, icon('photo', 48), h('p', {}, this.emptyText)));
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.sentinel.classList.remove('loading');
      }
    }
    if (generation !== this.generation) return;
    // Keep loading while the sentinel is still on screen.
    if (!this.done && this.sentinel.getBoundingClientRect().top < window.innerHeight + 800) this.loadMore();
  }

  groupKey(item) {
    if (this.groupBy === 'day') return item.takenAt.slice(0, 10);
    if (this.groupBy === 'month') return item.takenAt.slice(0, 7);
    return 'all';
  }

  renderItems(items, startIndex) {
    items.forEach((item, i) => {
      const key = this.groupKey(item);
      let group = this.groups.get(key);
      if (!group) {
        group = this.createGroup(key, item);
        this.groups.set(key, group);
        this.body.append(group.node);
      }
      group.ids.push(item.id);
      group.grid.append(this.renderTile(item, startIndex + i));
    });
  }

  createGroup(key, item) {
    const grid = h('div', { class: 'grid' });
    const group = { ids: [], grid };
    if (this.groupBy === 'none') {
      group.node = grid;
      return group;
    }
    const label = this.groupBy === 'day' ? fmt.day(item.takenAt) : fmt.month(item.takenAt);
    const selectAll = h('button', {
      class: 'group-select',
      title: 'Выбрать все за этот день',
      onclick: () => {
        const allSelected = group.ids.every((id) => this.selected.has(id));
        group.ids.forEach((id) => this.setSelected(id, !allSelected));
        this.emitSelection();
      },
    }, icon('select', 16));
    group.node = h('section', { class: 'group' }, h('h3', { class: 'group-title' }, selectAll, label), grid);
    return group;
  }

  renderTile(item) {
    const img = h('img', { src: item.thumbUrl, alt: item.title || item.name, loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.onerror = () => img.replaceWith(h('div', { class: 'tile-placeholder' }, icon(item.kind === 'video' ? 'video' : 'photo', 32)));
    const tile = h(
      'button',
      { class: 'tile', dataset: { id: item.id }, type: 'button', 'aria-label': item.title || item.name },
      img,
      item.kind === 'video' ? h('span', { class: 'badge-video' }, icon('play', 12), fmt.duration(item.duration)) : null,
      item.favorite ? h('span', { class: 'badge-fav' }, icon('heart', 16)) : null,
      h('span', {
        class: 'tile-check',
        onclick: (e) => {
          e.stopPropagation();
          this.toggle(item.id, e.shiftKey);
        },
      }, icon('check', 14)),
    );
    tile.addEventListener('click', (e) => {
      if (this.selectionMode || e.ctrlKey || e.metaKey || e.shiftKey) this.toggle(item.id, e.shiftKey);
      else this.onOpen?.(this.items.findIndex((x) => x.id === item.id), this.items);
    });
    // Long press starts selection on touch screens.
    let pressTimer;
    tile.addEventListener('touchstart', () => {
      pressTimer = setTimeout(() => {
        pressTimer = 'fired';
        this.toggle(item.id);
      }, 500);
    }, { passive: true });
    tile.addEventListener('touchend', (e) => {
      if (pressTimer === 'fired') e.preventDefault();
      clearTimeout(pressTimer);
    });
    tile.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
    return tile;
  }

  toggle(id, range = false) {
    if (range && this.lastClicked !== null) {
      const a = this.items.findIndex((x) => x.id === this.lastClicked);
      const b = this.items.findIndex((x) => x.id === id);
      const [from, to] = a < b ? [a, b] : [b, a];
      for (let i = from; i <= to; i++) this.setSelected(this.items[i].id, true);
    } else {
      this.setSelected(id, !this.selected.has(id));
    }
    this.lastClicked = id;
    this.emitSelection();
  }

  setSelected(id, on) {
    if (on) this.selected.add(id);
    else this.selected.delete(id);
    this.body.querySelector(`.tile[data-id="${id}"]`)?.classList.toggle('selected', on);
  }

  selectAll() {
    this.items.forEach((item) => this.setSelected(item.id, true));
    this.emitSelection();
  }

  clearSelection() {
    for (const id of [...this.selected]) this.setSelected(id, false);
    this.emitSelection();
  }

  emitSelection() {
    this.el.classList.toggle('selecting', this.selectionMode);
    this.onSelectionChange([...this.selected]);
  }

  selectedItems() {
    return this.items.filter((x) => this.selected.has(x.id));
  }

  // Reflect an edit made elsewhere (e.g. favorite toggled in the viewer).
  updateItem(item) {
    const index = this.items.findIndex((x) => x.id === item.id);
    if (index < 0) return;
    this.items[index] = { ...this.items[index], ...item };
    const old = this.body.querySelector(`.tile[data-id="${item.id}"]`);
    if (old) {
      const tile = this.renderTile(this.items[index]);
      tile.classList.toggle('selected', this.selected.has(item.id));
      old.replaceWith(tile);
    }
  }

  removeItems(ids) {
    const set = new Set(ids);
    this.items = this.items.filter((x) => !set.has(x.id));
    this.total -= set.size;
    for (const id of set) {
      this.selected.delete(id);
      this.body.querySelector(`.tile[data-id="${id}"]`)?.remove();
    }
    for (const [key, group] of this.groups) {
      group.ids = group.ids.filter((id) => !set.has(id));
      if (!group.ids.length) {
        group.node.remove();
        this.groups.delete(key);
      }
    }
    if (!this.items.length) fill(this.body, h('div', { class: 'empty' }, icon('photo', 48), h('p', {}, this.emptyText)));
    this.emitSelection();
  }
}
