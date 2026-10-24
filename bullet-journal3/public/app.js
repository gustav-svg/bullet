/* Bullet Journal: browser app. Talks to server.js, which keeps everything as files in your journal folder. */
'use strict';

/* ================================================================== */
/* Helpers                                                            */
/* ================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder. Text is always inserted as text, never as HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'open') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayId = () => fmtDate(new Date());
const monthId = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const LOCALE = 'en-GB';
const fmt = (d, o) => d.toLocaleDateString(LOCALE, o);

/** ISO week (Monday first). */
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3); // Thursday of this week
  const year = t.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { year, week };
}
const weekId = (d) => { const { year, week } = isoWeek(d); return `${year}-W${pad(week)}`; };
function weekStart(id) {
  const [y, w] = id.split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  return addDays(addDays(jan4, -((jan4.getDay() + 6) % 7)), (w - 1) * 7);
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(1) + ' GB';
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'X-Bujo': '1' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch('/api/' + path, opts);
  } catch {
    throw new Error('Cannot reach the journal server. Is it still running?');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || 'Something went wrong.');
    e.status = r.status;
    throw e;
  }
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body });

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}

/* Sets that survive a reload (which subtask lists are folded away). */
function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-500))); } catch { /* ignore */ }
}

/* A log id is a path: "Groceries" is a log, "Groceries/Costco" is a sub log of it. */
const logTitle = (id) => String(id).split('/').pop();
const logLabel = (id) => String(id).split('/').join(' / ');
const logParent = (id) => (String(id).includes('/') ? String(id).slice(0, String(id).lastIndexOf('/')) : '');
const normTitle = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();

/* ================================================================== */
/* State and routing                                                  */
/* ================================================================== */

const state = {
  view: null, logs: [], data: null, sig: null, info: null,
  drafts: {}, refocus: null, subOpen: null, collapsed: loadSet('bujo.collapsed'),
  type: (() => { try { return localStorage.getItem('bujo.type') || 'task'; } catch { return 'task'; } })(),
};

const href = (kind, id) => `#/${kind}/${encodeURIComponent(id)}`;
const go = (kind, id) => { location.hash = href(kind, id); };

function parseHash() {
  const def = { kind: 'daily', id: todayId() };
  const m = /^#\/(daily|weekly|monthly|custom)\/(.*)$/.exec(location.hash);
  if (!m) return def;
  let id;
  try { id = decodeURIComponent(m[2]); } catch { id = m[2]; }
  const kind = m[1];
  const now = new Date();
  if (kind === 'daily') return { kind, id: /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : todayId() };
  if (kind === 'weekly') return { kind, id: /^\d{4}-W\d{2}$/.test(id) ? id : weekId(now) };
  if (kind === 'monthly') return { kind, id: /^\d{4}-\d{2}$/.test(id) ? id : monthId(now) };
  return id ? { kind, id } : def;
}

/* ================================================================== */
/* Loading                                                            */
/* ================================================================== */

let loadSeq = 0;
let shownDay = todayId(); // the day the screen was last drawn for

async function fetchViewData(kind, id) {
  if (kind === 'daily') {
    const [page, carry] = await Promise.all([
      api(`page?kind=daily&id=${id}`),
      id >= todayId() ? api(`carry?date=${id}`) : Promise.resolve({ items: [] }),
    ]);
    return { page, carry: carry.items };
  }
  if (kind === 'weekly') {
    const s = weekStart(id);
    const [page, days] = await Promise.all([
      api(`page?kind=weekly&id=${id}`),
      api(`pages?from=${fmtDate(s)}&to=${fmtDate(addDays(s, 6))}`),
    ]);
    return { page, days: days.pages };
  }
  if (kind === 'monthly') {
    const [y, m] = id.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const [page, days] = await Promise.all([
      api(`page?kind=monthly&id=${id}`),
      api(`pages?from=${id}-01&to=${id}-${pad(last)}`),
    ]);
    return { page, days: days.pages };
  }
  return { page: await api(`page?kind=custom&id=${encodeURIComponent(id)}`) };
}

async function load() {
  const seq = ++loadSeq;
  const { kind, id } = state.view;
  try {
    const sig = (await api('sig')).sig; // read first, so a change during loading is noticed next poll
    const [logsRes, data] = await Promise.all([api('logs'), fetchViewData(kind, id)]);
    if (seq !== loadSeq) return;
    Object.assign(state, { sig, logs: logsRes.logs, data });
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    if (kind === 'custom' && e.status === 404) {
      toast('That log is gone. Showing today instead.', true);
      go('daily', todayId());
      return;
    }
    state.data = null;
    renderSidebar();
    $('#main').replaceChildren(h('div', { class: 'sheet page-error' },
      h('p', null, e.message),
      h('button', { class: 'btn', type: 'button', onclick: load }, 'Try again')));
  }
}

/** Run a change on the server, then reload what is on screen. */
async function act(path, body, okMsg) {
  try {
    const r = await post(path, body);
    await load();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    await load();
    return null;
  }
}

/* ================================================================== */
/* Rendering                                                          */
/* ================================================================== */

function render() {
  shownDay = todayId();
  renderSidebar();
  const main = $('#main');
  const v = state.view;
  const view = { daily: viewDaily, weekly: viewWeekly, monthly: viewMonthly, custom: viewCustom }[v.kind]();
  main.replaceChildren(view);
  document.title = pageTitle() + ' | Bullet Journal';
  if (state.refocus) {
    const el = document.querySelector(`[data-cid="${CSS.escape(state.refocus)}"]`);
    if (el) el.focus();
    state.refocus = null;
  }
}

function pageTitle() {
  const { kind, id } = state.view;
  if (kind === 'daily') return fmt(parseDate(id), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (kind === 'weekly') return 'Week ' + Number(id.slice(6)) + ', ' + id.slice(0, 4);
  if (kind === 'monthly') { const [y, m] = id.split('-').map(Number); return fmt(new Date(y, m - 1, 1), { month: 'long', year: 'numeric' }); }
  return id;
}

function renderSidebar() {
  const v = state.view;
  const now = new Date();
  const link = (kind, id, label, hint, count, depth = 0) => h('a', {
    class: 'nav' + (depth ? ' sub' : '') + (v.kind === kind && (kind !== 'custom' || v.id === id) ? ' active' : ''),
    style: depth ? `--depth:${depth}` : null,
    href: href(kind, id),
    title: kind === 'custom' ? logLabel(id) : null,
    onclick: () => document.body.classList.remove('nav-open'),
  }, h('span', null, label), count ? h('span', { class: 'count', title: count + ' open' }, count) : hint ? h('span', { class: 'hint' }, hint) : null);

  $('#side').replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), 'Bullet Journal'),
    h('nav', { class: 'nav-group', 'aria-label': 'Logs by date' },
      link('daily', todayId(), 'Daily log', fmt(now, { day: 'numeric', month: 'short' })),
      link('weekly', weekId(now), 'Weekly log', 'Week ' + isoWeek(now).week),
      link('monthly', monthId(now), 'Monthly log', fmt(now, { month: 'long' }))),
    h('nav', { class: 'nav-group', 'aria-label': 'Custom logs' },
      h('div', { class: 'nav-title' }, 'Custom logs', h('button', { class: 'btn small quiet', type: 'button', onclick: () => newLogSheet() }, 'New log')),
      state.logs.length
        ? state.logs.map((l) => link('custom', l.name, l.title, filmHint(l), l.open, l.depth))
        : h('div', { class: 'nav-empty' }, 'No custom logs yet.')),
    h('div', { class: 'side-foot' },
      h('div', { class: 'path', title: 'Your journal folder' }, state.info ? state.info.root : ''),
      h('button', { class: 'btn small', type: 'button', onclick: () => reveal() }, 'Open journal folder')),
  );
}

function folio({ num, numClass = '', day, badge, sub, path, nav, crumbs }) {
  return h('header', { class: 'folio' },
    crumbs && crumbs.length
      ? h('nav', { class: 'crumbs', 'aria-label': 'Parent logs' }, crumbs.map((c, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }) : null, c]))
      : null,
    h('h1', { class: 'folio-num ' + numClass }, num),
    h('div', { class: 'folio-text' },
      day || badge ? h('div', { class: 'folio-day' }, day, badge ? h('span', { class: 'badge' }, badge) : null) : null,
      sub ? h('div', { class: 'folio-sub' }, sub) : null,
      path ? h('div', { class: 'folio-path' }, path) : null),
    nav ? h('div', { class: 'folio-nav' }, nav) : null);
}

function stepper(kind, prevId, nextId, todayLabel, nowId, currentId, unit) {
  return [
    h('a', { class: 'btn icon', href: href(kind, prevId), 'aria-label': 'Previous ' + unit, title: 'Previous ' + unit }, '‹'),
    h('a', { class: 'btn' + (currentId === nowId ? ' on' : ''), href: href(kind, nowId) }, todayLabel),
    h('a', { class: 'btn icon', href: href(kind, nextId), 'aria-label': 'Next ' + unit, title: 'Next ' + unit }, '›'),
  ];
}

/* ---------- Daily ---------- */

function viewDaily() {
  const { id } = state.view;
  const d = parseDate(id);
  const ref = { kind: 'daily', id };
  const jump = h('input', {
    type: 'date', class: 'field', value: id, 'aria-label': 'Jump to a date',
    onchange: (e) => { if (e.target.value) go('daily', e.target.value); },
  });
  return h('div', { class: 'sheet' },
    folio({
      num: String(d.getDate()),
      day: fmt(d, { weekday: 'long' }),
      badge: id === todayId() ? 'Today' : null,
      sub: fmt(d, { month: 'long', year: 'numeric' }),
      nav: [...stepper('daily', fmtDate(addDays(d, -1)), fmtDate(addDays(d, 1)), 'Today', todayId(), id, 'day'), jump],
    }),
    carrySection(state.data.carry, id),
    bulletList(ref, state.data.page.bullets, { cards: true, empty: 'Nothing logged for this day yet. Add a task, an event or a note below.' }),
    composer(ref, { placeholder: 'New bullet. #log files it in a custom log too' }));
}

function carrySection(items, targetId) {
  if (!items || !items.length) return null;
  const bring = (it) => act('bullet/migrate', { ...it.from, target: { kind: 'daily', id: targetId } }, 'Migrated here.');
  const bringAll = async () => {
    try {
      for (const it of items) await post('bullet/migrate', { ...it.from, target: { kind: 'daily', id: targetId } });
      toast(`Migrated ${items.length} ${items.length === 1 ? 'task' : 'tasks'} here.`);
    } catch (e) { toast(e.message, true); }
    load();
  };
  return h('section', { class: 'carry' },
    h('div', { class: 'carry-head' },
      h('b', null, 'Unfinished from earlier days'),
      h('span', { class: 'grow' }, items.length + ' open'),
      h('button', { class: 'btn small', type: 'button', onclick: bringAll }, 'Migrate all here')),
    h('ul', { class: 'carry-list' }, items.map((it) => h('li', null,
      h('span', { class: 'sig' }, h('span', { class: 'mk mk-open' })),
      h('span', { class: 'title' }, it.title),
      h('span', { class: 'from' }, fmt(parseDate(it.from.id), { weekday: 'short', day: 'numeric', month: 'short' })),
      h('button', { class: 'btn small', type: 'button', onclick: () => bring(it) }, 'Migrate here')))));
}

/* ---------- Weekly ---------- */

function viewWeekly() {
  const { id } = state.view;
  const s = weekStart(id);
  const e = addDays(s, 6);
  const ref = { kind: 'weekly', id };
  const nowId = weekId(new Date());
  const dayCard = (page) => {
    const d = parseDate(page.id);
    const dref = { kind: 'daily', id: page.id };
    return h('section', { class: 'day' + (page.id === todayId() ? ' today' : '') },
      h('a', { class: 'day-head', href: href('daily', page.id) }, h('b', null, fmt(d, { weekday: 'long' })), h('span', null, fmt(d, { day: 'numeric', month: 'short' }))),
      bulletList(dref, page.bullets, { compact: true }),
      composer(dref, { placeholder: 'Add…', compact: true }));
  };
  return h('div', { class: 'sheet wide' },
    folio({
      num: String(Number(id.slice(6))),
      day: 'Week',
      badge: id === nowId ? 'This week' : null,
      sub: `${fmt(s, { day: 'numeric', month: 'short' })} to ${fmt(e, { day: 'numeric', month: 'short', year: 'numeric' })}`,
      nav: stepper('weekly', weekId(addDays(s, -7)), weekId(addDays(s, 7)), 'This week', nowId, id, 'week'),
    }),
    h('section', { class: 'week-top' },
      h('h2', { class: 'block-title' }, 'Week tasks and notes'),
      h('p', { class: 'block-sub' }, 'Things for the whole week. Each day has its own space below.'),
      bulletList(ref, state.data.page.bullets, { cards: true, empty: 'Nothing planned for this week yet.' }),
      composer(ref, { placeholder: 'New bullet for this week. #log files it in a custom log too', dock: false })),
    h('h2', { class: 'block-title' }, 'Days'),
    h('div', { class: 'daygrid' }, state.data.days.map(dayCard)));
}

/* ---------- Monthly ---------- */

function viewMonthly() {
  const { id } = state.view;
  const [y, m] = id.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const nDays = new Date(y, m, 0).getDate();
  const ref = { kind: 'monthly', id };
  const nowId = monthId(new Date());
  const byDay = new Map(state.data.days.map((p) => [p.id, p.bullets]));

  const cal = h('div', { class: 'cal', role: 'grid', 'aria-label': 'Calendar for ' + pageTitle() },
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => h('div', { class: 'dow', role: 'columnheader' }, n)));
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) cal.append(h('div', { class: 'cell blank', 'aria-hidden': 'true' }));
  for (let day = 1; day <= nDays; day++) {
    const did = `${id}-${pad(day)}`;
    const items = (byDay.get(did) || []).filter((b) => b.depth === 0 && (b.type === 'event' || (b.type === 'task' && b.status === 'open')));
    items.sort((a, b) => (a.type === 'event' ? 0 : 1) - (b.type === 'event' ? 0 : 1));
    cal.append(h('a', { class: 'cell' + (did === todayId() ? ' today' : ''), href: href('daily', did), role: 'gridcell', 'aria-label': fmt(parseDate(did), { weekday: 'long', day: 'numeric', month: 'long' }) + (items.length ? ', ' + items.length + ' items' : '') },
      h('span', { class: 'n' }, day),
      items.slice(0, 3).map((b) => h('div', { class: 'it' }, h('span', { class: 'mk mk-' + (b.type === 'event' ? 'event' : 'open') }), h('span', null, b.title))),
      items.length > 3 ? h('div', { class: 'more-n' }, `+${items.length - 3} more`) : null));
  }

  return h('div', { class: 'sheet wide' },
    folio({
      num: fmt(first, { month: 'long' }),
      numClass: 'text',
      badge: id === nowId ? 'This month' : null,
      sub: String(y),
      nav: stepper('monthly', monthId(new Date(y, m - 2, 1)), monthId(new Date(y, m, 1)), 'This month', nowId, id, 'month'),
    }),
    h('div', { class: 'month-layout' },
      h('section', null, h('h2', { class: 'block-title' }, 'Calendar'), h('p', { class: 'block-sub' }, 'Events and open tasks from your daily logs. Select a day to open it.'), cal),
      h('section', null,
        h('h2', { class: 'block-title' }, 'Month tasks and notes'),
        h('p', { class: 'block-sub' }, 'Things for the whole month.'),
        bulletList(ref, state.data.page.bullets, { cards: true, empty: 'Nothing planned for this month yet.' }),
        composer(ref, { placeholder: 'New bullet', dock: false }))));
}

/* ---------- Custom log ---------- */

function viewCustom() {
  const { id } = state.view;
  const page = state.data.page;
  const ref = { kind: 'custom', id };
  const parts = id.split('/');
  const crumbs = parts.slice(0, -1).map((p, i) => h('a', { href: href('custom', parts.slice(0, i + 1).join('/')) }, p));
  const canNest = parts.length < 3;
  const film = page.film;
  const fsub = film && film.sublogs.find((s) => s.name === id);
  if (fsub) return viewFilmSub(film, fsub);
  return h('div', { class: 'sheet' },
    folio({
      crumbs,
      num: parts[parts.length - 1],
      numClass: 'text',
      sub: `${page.files.length} ${page.files.length === 1 ? 'file' : 'files'} in this folder`,
      path: page.folder,
      nav: [canNest ? btn('New sub log', () => newLogSheet(id)) : null, btn('Rename', renameLogSheet, 'quiet'), btn('Open folder', () => reveal(id), 'quiet'), btn('Delete log', deleteLogSheet, 'quiet danger')],
    }),
    sublogs(id, canNest),
    film && parts.length === 1 ? filmHome(film) : null,
    bulletList(ref, page.bullets, { cards: true, empty: 'No bullets yet. Add a task, an event or a note below.' }),
    composer(ref, { placeholder: `New bullet for ${parts[parts.length - 1]}. Same-name tasks stay in sync` }),
    filesPanel(id, page.files));
}

/** Sub logs of a log, drawn as little stacks. */
function sublogs(id, canNest) {
  const subs = state.logs.filter((l) => l.parent === id);
  if (!subs.length) return null;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return h('section', { class: 'sublogs', 'aria-label': 'Sub logs' },
    h('div', { class: 'spaces' },
      subs.map((l) => {
        const deeper = state.logs.filter((x) => x.parent === l.name).length;
        return h('a', { class: 'space', href: href('custom', l.name) },
          h('b', null, l.title),
          h('span', null, l.kind ? filmKindLabel(l.kind) : l.open ? count(l.open, 'open task', 'open tasks') : count(l.total, 'bullet', 'bullets')),
          deeper ? h('span', null, count(deeper, 'sub log', 'sub logs')) : null);
      }),
      canNest ? h('button', { class: 'space ghost', type: 'button', onclick: () => newLogSheet(id) }, 'New sub log') : null));
}

/* ================================================================== */
/* Bullets                                                            */
/* ================================================================== */

function keyOf(ref, title) { return `${ref.kind}:${ref.id}:${normTitle(title)}`; }

/**
 * Bullets come from the server as a flat list that knows each bullet's parent.
 * With `cards`, plain bullets share one card and a bullet with subtasks gets a card of its own.
 */
function bulletList(ref, bullets, { compact = false, cards = false, empty } = {}) {
  const kids = bullets.map(() => []);
  const roots = [];
  bullets.forEach((b, n) => (b.parent >= 0 ? kids[b.parent].push(n) : roots.push(n)));
  const item = (n) => bulletItem(ref, bullets, n, kids, compact);

  if (!cards) {
    const ul = h('ul', { class: 'bullets' + (compact ? ' compact' : '') }, roots.map(item));
    if (!roots.length && empty) ul.append(h('li', { class: 'empty-row' }, empty));
    return ul;
  }
  if (!roots.length) return h('div', { class: 'card empty' }, empty || 'Nothing here yet.');
  const stack = h('div', { class: 'stack' });
  let run = null;
  for (const n of roots) {
    if (kids[n].length || state.subOpen === keyOf(ref, bullets[n].title)) {
      run = null;
      stack.append(h('section', { class: 'card rich' }, h('ul', { class: 'bullets' }, item(n))));
    } else {
      if (!run) { run = h('ul', { class: 'bullets' }); stack.append(h('section', { class: 'card' }, run)); }
      run.append(item(n));
    }
  }
  return stack;
}

function bulletItem(ref, bullets, n, kids, compact) {
  const b = bullets[n];
  const key = keyOf(ref, b.title);
  const adding = state.subOpen === key;
  const folded = state.collapsed.has(key) && !adding;
  const li = h('li', { class: 'item' }, bulletRow(ref, b, key, folded, compact));
  if ((kids[n].length && !folded) || adding) {
    const ul = h('ul', { class: 'kids' }, folded ? null : kids[n].map((m) => bulletItem(ref, bullets, m, kids, compact)));
    if (adding) ul.append(h('li', { class: 'sub-add' }, subComposer(ref, b, key)));
    li.append(ul);
  }
  return li;
}

function openSub(key) {
  state.subOpen = key;
  state.collapsed.delete(key);
  saveSet('bujo.collapsed', state.collapsed);
  state.refocus = 'sub:' + key;
  render();
}

function toggleFold(key) {
  if (state.subOpen === key) state.subOpen = null;
  if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
  saveSet('bujo.collapsed', state.collapsed);
  render();
}

/** "2/5" with a small ring. Select it to fold the subtasks away. */
function progressChip(b, key, folded) {
  const { done, total } = b.subs;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h('button', {
    class: 'prog' + (total && done === total ? ' full' : ''), type: 'button',
    'aria-expanded': String(!folded),
    'aria-label': (total ? `${done} of ${total} subtasks done. ` : `${b.kids} sub-bullets. `) + (folded ? 'Show them.' : 'Hide them.'),
    title: folded ? 'Show subtasks' : 'Hide subtasks',
    onclick: () => toggleFold(key),
  },
  total ? h('span', { class: 'ring', style: `--p:${pct}` }) : null,
  h('span', { class: 'num' }, total ? `${done}/${total}` : String(b.kids)),
  h('span', { class: 'caret' + (folded ? ' shut' : '') }));
}

/** Inline field under a bullet. Enter adds and stays open for the next one; Escape closes. */
function subComposer(ref, b, key) {
  const cid = 'sub:' + key;
  const input = h('input', { class: 'sub-input', type: 'text', placeholder: 'Add a subtask', maxlength: 400, autocomplete: 'off', 'data-cid': cid, 'aria-label': 'New subtask under ' + b.title });
  input.value = state.drafts[cid] || '';
  const close = () => { state.subOpen = null; state.drafts[cid] = ''; render(); };
  input.addEventListener('input', () => { state.drafts[cid] = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  const submit = async (e) => {
    e.preventDefault();
    let text = input.value.trim();
    if (!text) return close();
    let type = 'task';
    const sc = /^(-|o|\.)\s+(\S.*)$/.exec(text);
    if (sc) { type = sc[1] === '-' ? 'note' : sc[1] === 'o' ? 'event' : 'task'; text = sc[2]; }
    state.drafts[cid] = '';
    input.value = '';
    state.refocus = cid;
    const r = await act('bullet/child', { ...ref, idx: b.idx, raw: b.raw, text, type });
    if (r && !r.added) toast('That subtask is already there.');
  };
  return h('form', { class: 'sub-form', onsubmit: submit }, input,
    h('button', { class: 'btn small quiet', type: 'button', onclick: close }, 'Done'));
}

function placeLabel(p) {
  if (p.kind === 'custom') return logTitle(p.id);
  if (p.kind === 'daily') return fmt(parseDate(p.id), { weekday: 'short', day: 'numeric', month: 'short' });
  if (p.kind === 'weekly') return 'Week ' + Number(p.id.slice(6));
  const [y, m] = p.id.split('-').map(Number);
  return fmt(new Date(y, m - 1, 1), { month: 'long', year: 'numeric' });
}

function bulletRow(ref, b, key, folded, compact) {
  const mark = b.type === 'task' ? b.status : b.type;
  const names = { open: 'Open task', done: 'Done task', migrated: 'Migrated task', scheduled: 'Scheduled task', cancelled: 'Cancelled task', event: 'Event', note: 'Note' };
  const sig = h('button', {
    class: 'sig', type: 'button',
    'aria-label': names[mark] + (b.type === 'task' ? (b.status === 'open' ? '. Mark as done.' : '. Mark as open.') : ''),
    title: b.type === 'task' ? (b.status === 'open' ? 'Mark as done' : b.status === 'done' ? 'Mark as open' : 'Bring back as open') : names[mark],
    onclick: () => { if (b.type === 'task') act('bullet/update', { ...ref, idx: b.idx, raw: b.raw, status: b.status === 'open' ? 'done' : 'open' }); },
  }, h('span', { class: 'mk mk-' + mark }));
  const title = h('span', { class: 'title', title: 'Select to edit' }, b.title);
  title.addEventListener('click', () => startEdit(ref, b, title));

  const chips = b.also && b.also.length
    ? h('span', { class: 'chips', title: 'The same task also lives here' },
      b.also.map((p) => h('a', { class: 'chip ' + p.kind, href: href(p.kind, p.id), title: 'Same task in: ' + (p.kind === 'custom' ? logLabel(p.id) : placeLabel(p)) }, placeLabel(p))))
    : null;

  return h('div', { class: `b ${b.type} ${b.type === 'task' ? b.status : ''}` },
    sig, title, chips,
    b.kids ? progressChip(b, key, folded) : null,
    !compact && b.depth < 2
      ? h('button', { class: 'add', type: 'button', 'aria-label': 'Add a subtask', title: 'Add a subtask', onclick: () => openSub(key) }, h('span', { class: 'plus' }))
      : null,
    !compact ? h('button', { class: 'more', type: 'button', 'aria-label': 'More actions', title: 'More actions', onclick: () => bulletSheet(ref, b) }, '⋯') : null);
}

function startEdit(ref, b, span) {
  const input = h('input', { class: 'edit', type: 'text', value: b.title, maxlength: 500, 'aria-label': 'Edit bullet' });
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (save && v && v !== b.title) act('bullet/update', { ...ref, idx: b.idx, raw: b.raw, title: v });
    else input.replaceWith(span);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  span.replaceWith(input);
  input.focus();
  input.select();
}

/* ---------- Composer (quick add) ---------- */

function extractTags(text) {
  const targets = [];
  const kept = [];
  for (const tok of text.split(/\s+/)) {
    if (tok.length > 1 && tok[0] === '#') {
      const log = state.logs.find((l) => slug(l.name) === slug(tok.slice(1)));
      if (log) {
        if (!targets.some((t) => t.id === log.name)) targets.push({ kind: 'custom', id: log.name });
        continue;
      }
    }
    kept.push(tok);
  }
  return { text: kept.join(' '), targets };
}

function composer(ref, { placeholder, compact = false, dock = true }) {
  const cid = `${ref.kind}:${ref.id}`;
  let type = state.type;
  const input = h('input', { type: 'text', class: 'composer-input', placeholder, autocomplete: 'off', maxlength: 400, 'data-cid': cid, 'aria-label': 'New bullet' });
  input.value = state.drafts[cid] || '';
  const sugg = h('div', { class: 'suggest' });

  const types = [['task', 'Task'], ['event', 'Event'], ['note', 'Note']];
  const seg = compact ? null : h('div', { class: 'seg', role: 'group', 'aria-label': 'Bullet type' },
    types.map(([t, label]) => h('button', {
      type: 'button', class: 'segbtn' + (t === type ? ' on' : ''), title: label, 'aria-label': label, 'aria-pressed': String(t === type),
      onclick: () => {
        type = t;
        state.type = t;
        try { localStorage.setItem('bujo.type', t); } catch { /* ignore */ }
        seg.querySelectorAll('.segbtn').forEach((el, i) => {
          el.classList.toggle('on', types[i][0] === t);
          el.setAttribute('aria-pressed', String(types[i][0] === t));
        });
        input.focus();
      },
    }, h('span', { class: 'mk mk-' + (t === 'task' ? 'open' : t) }))));

  function updateSuggest() {
    sugg.replaceChildren();
    const m = /(?:^|\s)#([^\s#]*)$/.exec(input.value);
    if (!m) return;
    const q = slug(m[1]);
    for (const l of state.logs.filter((x) => !q || slug(x.name).startsWith(q)).slice(0, 8)) {
      sugg.append(h('button', {
        type: 'button', class: 'btn small', title: logLabel(l.name),
        onclick: () => {
          input.value = input.value.replace(/#[^\s#]*$/, '#' + slug(l.name) + ' ');
          state.drafts[cid] = input.value;
          sugg.replaceChildren();
          input.focus();
        },
      }, logLabel(l.name)));
    }
  }
  input.addEventListener('input', () => { state.drafts[cid] = input.value; updateSuggest(); });
  updateSuggest();

  async function submit(e) {
    e.preventDefault();
    let text = input.value.trim();
    if (!text) return;
    let t = type;
    // Shortcuts: "- " note, "o " event, ". " task
    const sc = /^(-|o|\.)\s+(\S.*)$/.exec(text);
    if (sc) { t = sc[1] === '-' ? 'note' : sc[1] === 'o' ? 'event' : 'task'; text = sc[2]; }
    const tags = extractTags(text);
    if (!tags.text) return;
    const targets = [{ kind: ref.kind, id: ref.id }, ...tags.targets.filter((x) => !(x.kind === ref.kind && x.id === ref.id))];
    state.drafts[cid] = '';
    input.value = '';
    state.refocus = cid;
    const r = await act('bullet/add', { targets, text: tags.text, type: t });
    if (!r) return;
    const added = r.results.filter((x) => x.added).length;
    if (!added) toast('That bullet is already there.');
    else if (r.results.length > 1) toast(`Added to ${added} ${added === 1 ? 'place' : 'places'}.`);
  }

  return h('div', { class: compact ? 'composer-wrap' : dock ? 'dock' : 'composer-wrap' },
    h('form', { class: 'composer' + (compact ? ' compact' : ''), onsubmit: submit },
      seg, input,
      compact ? null : h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
    sugg);
}

/* ---------- Bullet actions sheet ---------- */

function refDate(ref) {
  if (ref.kind === 'daily') return parseDate(ref.id);
  if (ref.kind === 'weekly') return weekStart(ref.id);
  if (ref.kind === 'monthly') { const [y, m] = ref.id.split('-').map(Number); return new Date(y, m - 1, 1); }
  return new Date();
}

const sec = (title, ...kids) => h('section', { class: 'sec' }, title ? h('h3', null, title) : null, ...kids);
const row = (...kids) => h('div', { class: 'row' }, ...kids);
const btn = (label, onclick, cls = '') => h('button', { type: 'button', class: 'btn ' + cls, onclick }, label);

function openSheet(title, ...nodes) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(...nodes);
  if (!$('#sheet').open) $('#sheet').showModal();
}
const closeSheet = () => { if ($('#sheet').open) $('#sheet').close(); };

function bulletSheet(ref, b) {
  const base = { ...ref, idx: b.idx, raw: b.raw };
  const run = (path, extra, msg) => { closeSheet(); return act(path, { ...base, ...extra }, msg); };
  const d = refDate(ref);
  const nodes = [];

  // Edit text
  const text = h('input', { class: 'field grow', type: 'text', value: b.title, maxlength: 500, 'aria-label': 'Bullet text' });
  const save = () => { const v = text.value.trim(); if (v && v !== b.title) run('bullet/update', { title: v }); else closeSheet(); };
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  nodes.push(sec('Text', row(text, btn('Save', save, 'primary'))));

  // Type and status
  const typeRow = row(...[['task', 'Task'], ['event', 'Event'], ['note', 'Note']].map(([t, label]) =>
    h('button', { type: 'button', class: 'btn' + (b.type === t ? ' on' : ''), disabled: b.type === t, onclick: () => run('bullet/update', { type: t }, `Changed to ${label.toLowerCase()}.`) }, label)));
  if (b.type === 'task') {
    typeRow.append(b.status === 'cancelled'
      ? btn('Restore task', () => run('bullet/update', { status: 'open' }))
      : btn('Cancel task', () => run('bullet/update', { status: 'cancelled' }), 'quiet'));
  }
  nodes.push(sec('Type', typeRow));

  // Subtasks
  const subRows = [];
  if (b.depth < 2) {
    const input = h('input', { class: 'field grow', type: 'text', placeholder: 'New subtask', maxlength: 400, 'aria-label': 'New subtask' });
    const add = () => { const v = input.value.trim(); if (v) run('bullet/child', { text: v, type: 'task' }, 'Subtask added.'); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    subRows.push(row(input, btn('Add subtask', add, 'primary')));
  }
  subRows.push(row(
    btn('Nest under the bullet above', () => run('bullet/indent', { dir: 'in' }, 'Nested.')),
    b.depth > 0 ? btn('Move out of its parent', () => run('bullet/indent', { dir: 'out' }, 'Moved out.')) : null));
  nodes.push(sec('Subtasks',
    h('p', { class: 'note' }, 'Subtasks stay with their task when you migrate it or show it in another log.'),
    ...subRows));

  // Migrate
  if (b.type === 'task' && b.status === 'open' && ref.kind !== 'custom') {
    const targets = [];
    if (ref.kind === 'daily') targets.push(['Tomorrow', { kind: 'daily', id: fmtDate(addDays(d, 1)) }]);
    if (ref.kind !== 'monthly') targets.push(['Next week', { kind: 'weekly', id: weekId(addDays(d, 7)) }]);
    targets.push(['Next month', { kind: 'monthly', id: monthId(new Date(d.getFullYear(), d.getMonth() + 1, 1)) }]);
    const pick = h('input', { class: 'field', type: 'date', value: fmtDate(addDays(d, 1)), 'aria-label': 'Migrate to date' });
    nodes.push(sec('Migrate',
      h('p', { class: 'note' }, b.nested ? 'Marks it as migrated here and carries it, with its subtasks, to a new page.' : 'Marks it as migrated here and carries it to a new page.'),
      row(...targets.map(([label, target]) => btn(label, () => run('bullet/migrate', { target }, `Migrated to ${label.toLowerCase()}.`))),
        pick, btn('Migrate to date', () => { if (pick.value) run('bullet/migrate', { target: { kind: 'daily', id: pick.value } }, 'Migrated.'); }))));
  }

  // Also show in
  const links = [];
  if (ref.kind !== 'weekly') links.push([`Week ${isoWeek(d).week}`, { kind: 'weekly', id: weekId(d) }]);
  if (ref.kind !== 'monthly') links.push([fmt(d, { month: 'long' }), { kind: 'monthly', id: monthId(d) }]);
  for (const l of state.logs) if (!(ref.kind === 'custom' && ref.id === l.name)) links.push([logLabel(l.name), { kind: 'custom', id: l.name }]);
  const dayPick = h('input', { class: 'field', type: 'date', value: fmtDate(ref.kind === 'daily' ? addDays(d, 1) : new Date()), 'aria-label': 'Add to date' });
  const link = async (label, target) => {
    closeSheet();
    const r = await act('bullet/link', { ...base, target });
    if (!r) return;
    if (r.added) toast(`Also added to ${label}.`);
    else if (r.merged) toast(`Added ${r.merged} ${r.merged === 1 ? 'subtask' : 'subtasks'} to ${label}.`);
    else toast(`Already in ${label}.`);
  };
  nodes.push(sec('Also show in',
    h('p', { class: 'note' }, b.type === 'task' ? 'Same name, same task. Marking it done anywhere marks it done everywhere.' : 'Adds a copy of this bullet to another page.'),
    row(dayPick, btn('Add to daily log', () => { if (dayPick.value) link(fmt(parseDate(dayPick.value), { day: 'numeric', month: 'short' }), { kind: 'daily', id: dayPick.value }); })),
    row(...links.map(([label, target]) => btn(label, () => link(label, target), 'small')))));

  // Remove
  const removeLabel = b.nested ? `Remove with ${b.nested} sub-${b.nested === 1 ? 'bullet' : 'bullets'}` : 'Remove from this log';
  nodes.push(sec(null, row(btn(removeLabel, () => run('bullet/delete', {}, 'Removed.'), 'danger'),
    b.also && b.also.length ? h('span', { class: 'note' }, 'It stays in the other places it appears.') : null)));

  openSheet(b.title, ...nodes);
}

/* ================================================================== */
/* Custom logs                                                        */
/* ================================================================== */

async function reveal(log) {
  try {
    const r = await post('reveal', log ? { log } : {});
    toast('Opening ' + r.folder);
  } catch (e) { toast(e.message, true); }
}

function newLogSheet(parent = '') {
  if (filmNewLog(parent)) return;
  const input = h('input', { class: 'field grow', type: 'text', placeholder: parent ? 'Costco, Week 3, Ideas' : 'Groceries, Reading list, Project X', maxlength: 80, 'aria-label': 'Log name' });
  const create = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const r = await post('logs', parent ? { name, parent } : { name });
      closeSheet();
      toast(parent ? `Created the sub log "${logTitle(r.name)}".` : `Created the folder "${r.name}".`);
      go('custom', r.name);
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  openSheet(parent ? `New sub log in ${logTitle(parent)}` : 'New custom log', sec(null,
    h('p', { class: 'note' }, parent
      ? 'A sub log is a folder inside this log’s folder, with its own bullets and files.'
      : 'Every custom log is a folder inside your journal folder. Files you put in that folder show up here.'),
    row(input, btn(parent ? 'Create sub log' : 'Create log', create, 'primary'))));
  input.focus();
}

function renameLogSheet() {
  const id = state.view.id;
  const input = h('input', { class: 'field grow', type: 'text', value: logTitle(id), maxlength: 80, 'aria-label': 'New name' });
  const rename = async () => {
    const to = input.value.trim();
    if (!to || to === logTitle(id)) return closeSheet();
    try {
      const r = await post('logs/rename', { name: id, to });
      closeSheet();
      toast('Renamed. The folder was renamed too.');
      go('custom', r.name);
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
  openSheet('Rename log', sec(null, row(input, btn('Rename', rename, 'primary'))));
  input.focus();
  input.select();
}

function deleteLogSheet() {
  const id = state.view.id;
  const subs = state.logs.filter((l) => l.name.startsWith(id + '/')).length;
  openSheet('Delete this log?', sec(null,
    h('p', null, `The folder "${logTitle(id)}" and everything in it${subs ? `, including ${subs === 1 ? 'its sub log' : `its ${subs} sub logs`},` : ''} moves to the .trash folder inside your journal folder. Nothing is erased.`),
    row(btn('Move to trash', async () => {
      try {
        await post('logs/delete', { name: id });
        closeSheet();
        toast('Moved to trash.');
        const up = logParent(id);
        if (up) go('custom', up); else go('daily', todayId());
      } catch (e) { toast(e.message, true); }
    }, 'danger'), btn('Keep it', closeSheet))));
}

/* ---------- Files in the log's folder ---------- */

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'log', 'yml', 'yaml', 'ini', 'toml', 'js', 'ts', 'py', 'html', 'css', 'xml', 'sh']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const fileUrl = (log, path, extra = '') => `/api/file?log=${encodeURIComponent(log)}&path=${encodeURIComponent(path)}${extra}`;

function filesPanel(log, files) {
  const box = h('section', { class: 'files', 'aria-label': 'Files in this folder' });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { if (picker.files.length) uploadFiles(log, picker.files); } });
  box.append(
    h('div', { class: 'files-head' },
      h('h3', null, 'Files'),
      btn('New note', () => newNoteSheet(log), 'small'),
      btn('Upload files', () => picker.click(), 'small'),
      btn('Open folder', () => reveal(log), 'small quiet'),
      picker),
    h('p', { class: 'files-hint' }, 'Drop files here, or put them in the folder on your computer. They appear within a couple of seconds.'));
  if (!files.length) {
    box.append(h('div', { class: 'files-empty' }, 'The folder is empty.'));
  } else {
    box.append(h('ul', { class: 'file-grid' }, files.map((f) => {
      const ext = extOf(f.name);
      return h('li', null,
        h('button', { class: 'file', type: 'button', title: f.path, onclick: () => openFile(log, f) },
          IMG_EXT.has(ext)
            ? h('span', { class: 'thumb' }, h('img', { src: fileUrl(log, f.path), alt: '', loading: 'lazy' }))
            : h('span', { class: 'thumb ext' }, ext || 'file'),
          h('span', { class: 'fname' }, f.path),
          h('span', { class: 'fmeta' }, fmtSize(f.size) + '  ' + new Date(f.mtime).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }))));
    })));
  }
  box.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('drop'); }
  });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop'); });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drop');
    if (e.dataTransfer.files.length) uploadFiles(log, e.dataTransfer.files);
  });
  return box;
}

async function uploadFiles(log, fileList) {
  let n = 0;
  for (const f of fileList) {
    try {
      const r = await fetch(fileUrl(log, f.name, '&noclobber=1'), { method: 'PUT', headers: { 'X-Bujo': '1' }, body: f });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed.');
      n++;
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (n) toast(`Saved ${n} ${n === 1 ? 'file' : 'files'} to the folder.`);
  load();
}

function newNoteSheet(log) {
  const input = h('input', { class: 'field grow', type: 'text', placeholder: 'Meeting notes', maxlength: 100, 'aria-label': 'Note name' });
  const create = async () => {
    let name = input.value.trim().replace(/[\\/]+/g, '-');
    if (!name) return;
    const title = name.replace(/\.[A-Za-z0-9]+$/, '');
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.md';
    try {
      const r = await fetch(fileUrl(log, name, '&noclobber=1'), { method: 'PUT', headers: { 'X-Bujo': '1' }, body: `# ${title}\n\n` });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Could not create the note.');
      closeSheet();
      await load();
      openFile(log, { path: data.path, name: data.path.split('/').pop(), size: 0, mtime: Date.now() });
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  openSheet('New note', sec(null,
    h('p', { class: 'note' }, 'Creates a Markdown file in this log’s folder.'),
    row(input, btn('Create note', create, 'primary'))));
  input.focus();
}

/** Minimal, safe Markdown to HTML (all text escaped first). */
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  let para = [];
  let code = null;
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.t}>` + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + `</${list.t}>`); list = null; } };
  for (const line of src.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      if (code) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      else { flushP(); flushL(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line))) {
      flushP();
      if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; }
      list.items.push((m[1] === undefined ? '' : m[1] === ' ' ? '☐ ' : '☑ ') + m[2]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushP();
      if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; }
      list.items.push(m[1]);
    } else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line.trim()); }
  }
  if (code) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flushP();
  flushL();
  return out.join('\n');
}

async function openFile(log, f) {
  const dlg = $('#viewer');
  const body = $('#viewer-body');
  const tools = $('#viewer-tools');
  const url = fileUrl(log, f.path);
  const ext = extOf(f.name);
  $('#viewer-title').textContent = f.path;
  body.replaceChildren();
  tools.replaceChildren(
    h('a', { class: 'btn small', href: url + '&download=1' }, 'Download'),
    h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener' }, 'Open in tab'),
    btn('Delete', async () => {
      if (!confirm(`Move "${f.path}" to the .trash folder?`)) return;
      try {
        const r = await fetch(fileUrl(log, f.path), { method: 'DELETE', headers: { 'X-Bujo': '1' } });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not delete the file.');
        dlg.close();
        toast('Moved to trash.');
        load();
      } catch (e) { toast(e.message, true); }
    }, 'small danger'));

  if (TEXT_EXT.has(ext)) {
    let content;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Could not open the file.');
      content = await r.text();
    } catch (e) { toast(e.message, true); return; }
    const area = h('textarea', { class: 'view-text', spellcheck: 'false', 'aria-label': 'File contents' });
    area.value = content;
    const preview = h('div', { class: 'md' });
    const isMd = ext === 'md' || ext === 'markdown';
    const saveFile = async () => {
      try {
        const r = await fetch(fileUrl(log, f.path), { method: 'PUT', headers: { 'X-Bujo': '1' }, body: area.value });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save.');
        toast('Saved.');
      } catch (e) { toast(e.message, true); }
    };
    area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } });
    const showEdit = h('button', { type: 'button', class: 'btn small on' }, 'Edit');
    const showView = h('button', { type: 'button', class: 'btn small' }, 'Preview');
    const setMode = (edit) => {
      area.hidden = !edit;
      preview.hidden = edit;
      showEdit.classList.toggle('on', edit);
      showView.classList.toggle('on', !edit);
      if (!edit) preview.innerHTML = renderMarkdown(area.value);
    };
    showEdit.onclick = () => setMode(true);
    showView.onclick = () => setMode(false);
    body.append(
      h('div', { class: 'row' }, isMd ? [showEdit, showView] : null, btn('Save', saveFile, 'small primary'), h('span', { class: 'note' }, 'Ctrl+S or Cmd+S also saves.')),
      area, preview);
    setMode(!isMd);
  } else if (IMG_EXT.has(ext)) {
    body.append(h('img', { class: 'view-img', src: url, alt: f.name }));
  } else if (ext === 'pdf') {
    body.append(h('iframe', { class: 'view-frame', src: url, title: f.name }));
  } else if (AUDIO_EXT.has(ext)) {
    body.append(h('audio', { class: 'view-media', src: url, controls: true }));
  } else if (VIDEO_EXT.has(ext)) {
    body.append(h('video', { class: 'view-media', src: url, controls: true }));
  } else {
    body.append(h('p', { class: 'note' }, 'No preview for this file type. Use Download or Open in tab.'));
  }
  if (!dlg.open) dlg.showModal();
}

/* ================================================================== */
/* Live refresh: pick up files and edits made outside the app         */
/* ================================================================== */

function isBusy() {
  if (window.boardBusy || document.querySelector('dialog[open]')) return true;
  const a = document.activeElement;
  return !!(a && a.classList && (a.isContentEditable || a.classList.contains('edit') || a.classList.contains('sub-input') || (a.closest && a.closest('.film') && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName))));
}

/** "Today" is worked out when a page is drawn, so redraw once the day changes (midnight, or the computer waking up). */
function checkNewDay() {
  if (todayId() === shownDay || isBusy()) return false;
  shownDay = todayId();
  load();
  return true;
}

async function checkForChanges() {
  if (checkNewDay()) return;
  if (document.hidden || isBusy() || !state.sig) return;
  try {
    const { sig } = await api('sig');
    if (sig !== state.sig && !isBusy()) load();
  } catch { /* server asleep or restarting: try again next tick */ }
}

/* ================================================================== */
/* Start                                                              */
/* ================================================================== */

for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
$('#sheet-close').addEventListener('click', closeSheet);
$('#viewer-close').addEventListener('click', () => $('#viewer').close());
$('#burger').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#main').addEventListener('click', () => document.body.classList.remove('nav-open'));
window.addEventListener('hashchange', () => { state.view = parseHash(); state.subOpen = null; load(); });
window.addEventListener('focus', checkForChanges);
setInterval(checkForChanges, 2000);

(async function init() {
  state.view = parseHash();
  try { state.info = await api('info'); } catch { /* shown by load() */ }
  load();
})();
