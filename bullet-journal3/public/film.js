/* Bullet Journal: film projects. Loaded after app.js and uses its helpers (h, post, load, state, ...).
 * A film project is a custom log. Its sub logs are of a kind (brain dump, moodboard, script, shot list,
 * storyboard, breakdown, schedule). Tags belong to the whole project, so anything tagged in one sub log
 * is connected to everything carrying the same tag in all the others. */
'use strict';

const FILM_KINDS = {
  braindump: ['Brain dump', 'A board of sticky notes: type, attach files, paste links or draw.'],
  moodboard: ['Moodboard', 'Older projects only. Add images and references in the brain dump instead.'],
  script: ['Script writer', 'Write your script, then select words in it to tag them.'],
  shotlist: ['Shot list', 'Shots under each scene (1A, 1B…). Drag to reorder. Open a shot for a longer description, notes and what is tagged to it. Switch to the Storyboard view for a frame per shot.'],
  storyboard: ['Storyboard', 'Now part of the shot list: use its Storyboard view. This is an older sub log.'],
  breakdown: ['Breakdown', 'Elements of each scene, or everything linked to one element.'],
  schedule: ['Schedule', 'Choose the day and time each shot is filmed.'],
};
const TAG_TYPES = { shot: 'Shot', scene: 'Scene', cast: 'Cast', location: 'Location', prop: 'Prop', costume: 'Costume', vehicle: 'Vehicle', other: 'Other' };
const ELEMENTS = ['cast', 'prop', 'location', 'costume', 'vehicle', 'other'];
const BREAKDOWN_TYPES = ELEMENTS;
const FIXED = new Set(['shot', 'scene']); // named automatically
const PLURAL = { cast: 'Cast', location: 'Locations', prop: 'Props', costume: 'Costumes', vehicle: 'Vehicles', other: 'Other' };
const SHOT_SIZES = ['', 'Extreme wide', 'Wide', 'Medium', 'Close-up', 'Extreme close-up', 'Insert'];
const SHOT_MOVES = ['', 'Static', 'Pan', 'Tilt', 'Dolly', 'Handheld', 'Tracking', 'Crane', 'Zoom'];
const BLOCKS = { scene: 'Scene heading', action: 'Action', character: 'Character', dialogue: 'Dialogue', paren: 'Parenthetical', transition: 'Transition' };
const NEXT_BLOCK = { scene: 'action', action: 'action', character: 'dialogue', dialogue: 'character', paren: 'dialogue', transition: 'scene' };

const openSheetF = (title, ...n) => openSheet(title, ...n.filter(Boolean));
const filmKindLabel = (k) => (FILM_KINDS[k] ? FILM_KINDS[k][0] : k);
const filmHint = (l) => (l.kind ? filmKindLabel(l.kind) : l.film ? 'Film' : null);
const filmOf = () => state.data && state.data.page && state.data.page.film;
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const tagOf = (film, id) => film.meta.tags.find((t) => t.id === id);
const subsOf = (film, kind) => film.sublogs.filter((s) => s.kind === kind);

/* ================================================================== */
/* Saving. All writes go through one queue so they never overtake     */
/* each other.                                                        */
/* ================================================================== */

let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

/** A structural change (add, remove, tag). Edit `c.meta` and `c.sub(name)` freely; whatever changed is saved, then the page reloads. */
function filmDo(fn, msg) {
  return enqueue(async () => {
    const film = filmOf();
    if (!film) return;
    const project = state.view.id.split('/')[0];
    const meta = structuredClone(film.meta);
    const subs = new Map();
    const sub = (name) => {
      if (!subs.has(name)) subs.set(name, structuredClone(film.sublogs.find((s) => s.name === name).data));
      return subs.get(name);
    };
    try {
      fn({ meta, sub, film });
      renumber({ meta, sub, film });
      if (JSON.stringify(meta) !== JSON.stringify(film.meta)) await post('film/meta', { project, meta });
      for (const [name, data] of subs) {
        if (JSON.stringify(data) !== JSON.stringify(film.sublogs.find((s) => s.name === name).data)) await post('film/data', { log: name, data });
      }
      await load();
      if (msg) toast(msg);
    } catch (e) {
      toast(e.message, true);
      await load();
    }
  });
}

/** Typing in a field: saved quietly, the page is not redrawn so the cursor stays put. */
function filmField(name, fn) {
  return enqueue(async () => {
    const film = filmOf();
    const s = film && film.sublogs.find((x) => x.name === name);
    if (!s) return;
    fn(s.data);
    try { await post('film/data', { log: name, data: s.data }); } catch (e) { toast(e.message, true); }
  });
}

const addTags = (meta, fresh) => { for (const t of fresh || []) if (!meta.tags.some((x) => x.id === t.id)) meta.tags.push(t); };

/** Remove a tag from the project and from everything that carries it. */
function dropTag(c, id) {
  c.meta.tags = c.meta.tags.filter((t) => t.id !== id);
  const strip = (o) => {
    if (Array.isArray(o)) o.forEach(strip);
    else if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (k === 'tags' && Array.isArray(o[k])) o[k] = o[k].filter((x) => x !== id);
        else if (k === 'scene' && o[k] === id) o[k] = '';
        else if (k === 'fileTags') for (const f of Object.keys(o[k])) o[k][f] = o[k][f].filter((x) => x !== id);
        else strip(o[k]);
      }
    }
  };
  for (const s of c.film.sublogs) strip(c.sub(s.name));
}

/* ================================================================== */
/* Connections: every taggable thing in the project as one flat list  */
/* ================================================================== */

/** Scene headings get their own scene tag ("Scene 1"...). Shots are named after their scene (3A, 3B...). */
function renumber(c) {
  let n = 0;
  for (const s of c.film.sublogs) {
    if (s.kind !== 'script') continue;
    for (const b of c.sub(s.name).blocks || []) {
      if (b.kind !== 'scene') continue;
      let t = b.tag && c.meta.tags.find((x) => x.id === b.tag);
      if (!t) { t = { id: uid(), name: '', type: 'scene' }; c.meta.tags.push(t); b.tag = t.id; }
      t.name = 'Scene ' + (++n);
    }
  }
  const per = {};
  let loose = 0;
  for (const s of c.film.sublogs) {
    if (s.kind !== 'shotlist') continue;
    for (const sh of c.sub(s.name).shots || []) {
      const t = c.meta.tags.find((x) => x.id === sh.tag);
      if (!t) continue;
      const sc = sh.scene && c.meta.tags.find((x) => x.id === sh.scene && x.type === 'scene');
      if (sc) { const k = (per[sc.id] = (per[sc.id] || 0) + 1); t.name = sc.name.replace('Scene ', '') + (k <= 26 ? String.fromCharCode(64 + k) : '-' + k); }
      else t.name = 'Shot ' + (++loose);
    }
  }
}

/** Scenes in script order: the scene tag, the heading text and its block. */
function sceneList(film) {
  const out = [];
  for (const s of film.sublogs) if (s.kind === 'script') for (const b of s.data.blocks || []) if (b.kind === 'scene' && b.tag && tagOf(film, b.tag)) out.push({ tag: b.tag, text: b.text || '', block: b, sub: s });
  return out;
}

const framesOf = (d) => (d.frames && !Array.isArray(d.frames) ? d.frames : {});

function allShots(film) {
  return film.sublogs.filter((s) => s.kind === 'shotlist').flatMap((s) => (s.data.shots || []).map((sh) => ({ ...sh, sub: s })));
}

function filmItems(film) {
  const out = [];
  const shots = new Map(allShots(film).map((x) => [x.id, x]));
  const clip = (t, n = 110) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  for (const s of film.sublogs) {
    const d = s.data;
    const add = (text, tags, extra) => out.push({ sub: s, text: clip(text), tags: [...new Set((tags || []).filter((t) => t && tagOf(film, t)))], ...extra });
    if (s.kind === 'braindump') {
      for (const n of d.notes || []) add(noteLabel(n), n.tags, n.file ? { file: { name: String(n.file).split('/').pop(), path: n.file } } : {});
      for (const n of d.snips || []) add(n.text, n.tags); // older brain dumps not opened yet
    }
    if (s.kind === 'moodboard') for (const f of s.files) add(f.name, (d.fileTags || {})[f.path], { file: f });
    if (s.kind === 'script') {
      let cur = '';
      for (const b of d.blocks || []) {
        if (b.kind === 'scene') { cur = b.tag || ''; add(b.text || 'Scene heading', [cur, ...(b.tags || [])]); }
        else if ((b.tags || []).length) add(b.text, [cur, ...b.tags]);
        for (const m of b.marks || []) add(m.text, [cur, ...(m.tags || [])], { mark: m });
      }
    }
    if (s.kind === 'shotlist') {
      for (const sh of d.shots || []) {
        add(sh.desc || sh.long || 'Untitled shot', [sh.tag, sh.scene, ...(sh.tags || [])]);
        for (const n of sh.notes || []) if (String(n.text || '').trim()) add(n.text, [sh.tag, sh.scene]);
      }
    }
    if (s.kind === 'storyboard' || s.kind === 'shotlist') {
      for (const [sid, f] of Object.entries(framesOf(d))) { const sh = shots.get(sid); if (sh && (f.file || f.caption)) add(f.caption || 'Storyboard frame', [sh.tag, sh.scene]); }
    }
    if (s.kind === 'schedule') {
      for (const [sid, e] of Object.entries(d.entries || {})) { const sh = shots.get(sid); if (sh && e.date) add(`${e.date}${e.time ? ' ' + e.time : ''}`, [sh.tag, sh.scene]); }
    }
  }
  return out.filter((x) => x.tags.length);
}

/* ================================================================== */
/* Tag chips, tag picker, tag sheet                                   */
/* ================================================================== */

function tagChip(film, id) {
  const t = tagOf(film, id);
  if (!t) return null;
  return h('button', { class: 'tg tg-' + t.type, type: 'button', title: TAG_TYPES[t.type] + ': click to see everything connected', onclick: () => tagSheet(film, id) }, t.name);
}

function tagRow(film, ids, onSet, label = 'Tag') {
  return h('div', { class: 'tgrow' },
    (ids || []).map((id) => tagChip(film, id)),
    h('button', { class: 'tg add', type: 'button', onclick: () => pickTags(film, ids || [], onSet) }, (ids || []).length ? '+' : '+ ' + label));
}

function pickTags(film, current, onDone, title = 'Tags', pre = {}) {
  const sel = new Set(current);
  const meta = structuredClone(film.meta);
  const fresh = [];
  const name = h('input', { class: 'field grow', type: 'text', placeholder: 'New tag, e.g. Diner, Maya, Red jacket', maxlength: 80, 'aria-label': 'New tag name' });
  const type = h('select', { class: 'field', 'aria-label': 'Tag type' }, Object.entries(TAG_TYPES).filter(([k]) => !FIXED.has(k)).map(([k, v]) => h('option', { value: k }, v)));
  type.value = pre.type || 'location';
  if (pre.name) name.value = pre.name.slice(0, 80);
  const draw = () => {
    const groups = Object.keys(TAG_TYPES).sort((a, b) => (b === pre.type) - (a === pre.type)).map((ty) => {
      const list = meta.tags.filter((t) => t.type === ty);
      if (!list.length) return null;
      return sec(TAG_TYPES[ty], h('div', { class: 'tgrow' }, list.map((t) => h('button', {
        class: 'tg tg-' + t.type + (sel.has(t.id) ? ' on' : ''), type: 'button', 'aria-pressed': String(sel.has(t.id)),
        onclick: () => { if (sel.has(t.id)) sel.delete(t.id); else sel.add(t.id); draw(); },
      }, t.name))));
    }).filter(Boolean);
    const add = () => {
      const n = name.value.trim();
      if (!n) return;
      const ex = meta.tags.find((t) => t.type === type.value && normTitle(t.name) === normTitle(n));
      const t = ex || { id: uid(), name: n, type: type.value };
      if (!ex) { meta.tags.push(t); fresh.push(t); }
      sel.add(t.id);
      name.value = '';
      draw();
    };
    name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    openSheet(title,
      groups.length ? h('div', null, groups) : h('p', { class: 'note' }, 'No tags yet. Make the first one below.'),
      sec(pre.name ? 'Create a new one from the selection' : 'New tag', row(name, type, btn('Add', add))),
      sec(null, row(btn('Done', () => { closeSheet(); onDone([...sel], fresh); }, 'primary'), btn('Cancel', closeSheet, 'quiet'))));
  };
  draw();
}

/** Everything connected to one tag, grouped by sub log. */
function tagSheet(film, id) {
  const t = tagOf(film, id);
  if (!t) return;
  const items = filmItems(film).filter((i) => i.tags.includes(id));
  const related = [...new Set(items.flatMap((i) => i.tags).filter((x) => x !== id))];
  const nm = h('input', { class: 'field grow', type: 'text', value: t.name, maxlength: 80, 'aria-label': 'Tag name', disabled: FIXED.has(t.type) });
  const fixed = FIXED.has(t.type);
  const ty = h('select', { class: 'field', 'aria-label': 'Tag type', disabled: fixed }, Object.entries(TAG_TYPES).map(([k, v]) => h('option', { value: k }, v)));
  ty.value = t.type;
  const save = () => {
    const n = nm.value.trim();
    if (!n) return;
    closeSheet();
    filmDo((c) => { const x = tagOf(c, id) || c.meta.tags.find((y) => y.id === id); x.name = n; x.type = ty.value; });
  };
  nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  const bySub = new Map();
  for (const i of items) { if (!bySub.has(i.sub.name)) bySub.set(i.sub.name, []); bySub.get(i.sub.name).push(i); }
  const groups = [...bySub.entries()].map(([name, list]) => {
    const s = list[0].sub;
    return h('div', { class: 'conn' },
      h('a', { class: 'conn-head', href: href('custom', name), onclick: closeSheet }, h('b', null, s.title), h('span', null, filmKindLabel(s.kind))),
      h('ul', null, list.map((i) => h('li', null, i.file && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(i.file.name) ? h('img', { class: 'conn-img', src: fileUrl(s.name, i.file.path), alt: '' }) : null, i.text))));
  });
  openSheetF(t.name,
    fixed ? null : sec('Tag', row(nm, ty, btn('Save', save, 'primary'))),
    sec(`Connected (${items.length})`, items.length ? groups : h('p', { class: 'note' }, 'Nothing carries this tag yet. Tag a brain dump note or file, a script line, a shot or a frame with it.')),
    related.length ? sec('Appears together with', h('div', { class: 'tgrow' }, related.map((r) => h('button', { class: 'tg tg-' + tagOf(film, r).type, type: 'button', onclick: () => tagSheet(film, r) }, tagOf(film, r).name)))) : null,
    fixed ? h('p', { class: 'note' }, t.type === 'shot' ? 'Shot tags are named after their scene (3A, 3B). Remove the shot in the shot list to remove its tag.' : 'Scene tags follow the scene headings in your script.') : sec(null, row(btn('Delete tag', () => { closeSheet(); filmDo((c) => dropTag(c, id), 'Tag deleted.'); }, 'danger'))));
}

/* ================================================================== */
/* New log: regular or film project, and the sub log type chooser     */
/* ================================================================== */

function filmNewLog(parent) {
  const isFilm = !!parent && state.logs.some((l) => l.name === parent && l.film);
  if (parent && !isFilm) return false;
  const input = h('input', { class: 'field grow', type: 'text', maxlength: 80, 'aria-label': 'Log name' });
  let choice = isFilm ? 'braindump' : 'regular';
  let typed = false;
  input.addEventListener('input', () => { typed = true; });
  const options = isFilm ? Object.keys(FILM_KINDS).filter((k) => k !== 'moodboard' && k !== 'storyboard').map((k) => [k, ...FILM_KINDS[k]]) : [['regular', 'Regular log', 'Bullets and files, like your other custom logs.'], ['film', 'Film project', 'Brain dump, script, shot list (with its storyboard view), breakdown and schedule, all connected by tags.']];
  const box = h('div', { class: 'kinds' });
  const draw = () => {
    box.replaceChildren(...options.map(([k, label, blurb], i) => h('button', { type: 'button', class: 'kind' + (choice === k ? ' on' : ''), 'aria-pressed': String(choice === k), onclick: () => { choice = k; if (!typed) input.value = isFilm ? label : ''; draw(); input.focus(); } },
      h('b', null, (isFilm ? i + 1 + '. ' : '') + label), h('span', null, blurb))));
    input.placeholder = isFilm ? 'Name of this sub log' : choice === 'film' ? 'Name of the film' : 'Groceries, Reading list, Project X';
  };
  if (isFilm) input.value = 'Brain dump';
  draw();
  const create = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const r = await post('logs', isFilm ? { name, parent, kind: choice } : { name, type: choice === 'film' ? 'film' : undefined });
      closeSheet();
      toast(isFilm ? `Created “${logTitle(r.name)}”.` : `Created “${r.name}”.`);
      go('custom', r.name);
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  openSheet(isFilm ? `New sub log in ${logTitle(parent)}` : 'New log', sec(null, box), sec(null, row(input, btn('Create', create, 'primary'))));
  input.focus();
  return true;
}

/* ================================================================== */
/* Project home and sub log frame                                     */
/* ================================================================== */

function filmHome(film) {
  const items = filmItems(film);
  const used = (id) => items.filter((i) => i.tags.includes(id)).length;
  const groups = Object.keys(TAG_TYPES).map((ty) => {
    const list = film.meta.tags.filter((t) => t.type === ty);
    if (!list.length) return null;
    return h('div', { class: 'tg-group' }, h('span', { class: 'tg-label' }, TAG_TYPES[ty]),
      h('div', { class: 'tgrow' }, list.map((t) => h('button', { class: 'tg tg-' + t.type, type: 'button', title: used(t.id) + ' connected', onclick: () => tagSheet(film, t.id) }, t.name, h('i', null, used(t.id))))));
  }).filter(Boolean);
  return h('section', { class: 'film film-home' }, h('h2', { class: 'block-title' }, 'Project tags'),
    h('p', { class: 'block-sub' }, 'Tags connect everything in this project. Select one to see what it touches.'),
    groups.length ? groups : h('div', { class: 'card empty' }, 'No tags yet. Add a shot in the shot list, or tag something in any sub log.'));
}

function viewFilmSub(film, sub) {
  const parts = sub.name.split('/');
  const views = { braindump: vBrainDump, moodboard: vMoodboard, script: vScript, shotlist: vShotViews, storyboard: vShotViews, breakdown: vBreakdown, schedule: vSchedule };
  return h('div', { class: 'sheet wide film' },
    folio({
      crumbs: [h('a', { href: href('custom', parts[0]) }, parts[0])],
      num: sub.title, numClass: 'text',
      sub: filmKindLabel(sub.kind) + '. ' + FILM_KINDS[sub.kind][1],
      nav: [btn('Rename', renameLogSheet, 'quiet'), btn('Open folder', () => reveal(sub.name), 'quiet'), btn('Delete log', deleteLogSheet, 'quiet danger')],
    }),
    views[sub.kind](film, sub));
}

/** Setter for "tags of this item", used by every view. `pick(data, ids)` assigns them. */
const setTags = (subName, pick) => (ids, fresh) => filmDo((c) => { addTags(c.meta, fresh); pick(c.sub(subName), ids); });

/* ---------- 1. Brain dump: a board of sticky notes ---------- */

/* Everything you put in a brain dump becomes a sticky note on a free board: typed text, a pasted link,
 * an attached or dropped file, or a drawing. Stickies are dragged by their top strip and resized from the
 * bottom-right corner. Tags sit in the strip above the content. A sticky can be attached to a scene or a
 * shot (it simply gets that scene's or shot's tag) or turned into a new scene or shot.
 * Data: sub.data.notes = [{ id, kind: text|link|file|draw, text, url, file, x, y, w, h, z, color, tags }] */

const STICKY_COLORS = ['#ffffff', 'transparent', '#fff3a8', '#ffd6dc', '#cfeecb', '#cfe3ff', '#e3d5fb', '#ffe0bf']; // the first is the default
const COLOR_NAMES = { '#ffffff': 'White', transparent: 'Transparent', '#fff3a8': 'Yellow', '#ffd6dc': 'Pink', '#cfeecb': 'Green', '#cfe3ff': 'Blue', '#e3d5fb': 'Lilac', '#ffe0bf': 'Orange' };
/** Font size multiplier. n.font is the size in px at the default width (15). Unless n.fixed is set, the text also grows in step with the sticky's width: twice as wide, twice the size. */
const fontScale = (n) => Math.round(((+n.font || 15) / 15) * (n.fixed ? 1 : Math.min(8, Math.max(0.5, n.w / 230))) * 100) / 100;
const PEN_COLORS = ['#1b1b1a', '#c2392f', '#2f6fd0', '#2c7560', '#d9822b'];
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const DRAW_W = 900;
const DRAW_H = 560;
let boardView = { sub: '', x: 40, y: 40, z: 1 }; // pan and zoom of the board on screen, kept when the page redraws
const shotBoardViews = new Map(); // pan and zoom of each shot's own canvas, kept when the page redraws
let boardKeyOff = null;
let boardPaste = null;
window.boardBusy = false; // true while a sticky is being dragged, so the page is not redrawn under it

const noteLabel = (n) => String(n.text || '').trim() || (n.kind === 'link' ? n.url || 'Link' : n.file ? String(n.file).split('/').pop() : n.kind === 'draw' ? 'Drawing' : 'Sticky');
const clipText = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const imgRatio = (url) => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalHeight / i.naturalWidth || 1); i.onerror = () => res(1); i.src = url; });

/** Save a file (or a drawing) into the sub log's folder. Returns its path inside the folder. */
async function putBoardFile(subName, body, name, overwrite) {
  const r = await fetch(fileUrl(subName, name || 'file', overwrite ? '' : '&noclobber=1'), { method: 'PUT', headers: { 'X-Bujo': '1' }, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Upload failed.');
  return data.path;
}

/** The first sub log of a kind, created on the spot when the project has none. Returns its name. */
async function ensureSub(kind, title) {
  const film = filmOf();
  if (!film) return null;
  const have = subsOf(film, kind)[0];
  if (have) return have.name;
  try {
    const r = await post('logs', { name: title, parent: state.view.id.split('/')[0], kind });
    await load();
    toast(`Created a ${filmKindLabel(kind)} sub log.`);
    return r.name;
  } catch (e) { toast(e.message, true); return null; }
}

/* ----- rich text inside text stickies: only size, colour and bold are kept ----- */
const TEXT_COLORS = ['#1b1b1a', '#c2392f', '#d9822b', '#2c7560', '#2f6fd0', '#7a5ab8', '#ffffff'];
const SIZE_STEPS = [0.6, 0.8, 1, 1.25, 1.6, 2, 2.6, 3.4, 4.5]; // multiples of the sticky's base font size
const CLR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\))$/i;
const EM_RE = /^\d{1,2}(\.\d{1,3})?em$/;

/** Rebuilds saved or pasted HTML from a short list of safe tags, so nothing else can get in. */
function cleanHtml(src) {
  const doc = new DOMParser().parseFromString('<body>' + String(src || '') + '</body>', 'text/html');
  const out = document.createElement('div');
  const walk = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === 3) to.append(document.createTextNode(node.nodeValue));
      else if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'BR') to.append(document.createElement('br'));
        else if (['B', 'STRONG', 'I', 'EM', 'U', 'DIV', 'P'].includes(tag)) { const e = document.createElement(tag.toLowerCase()); walk(node, e); to.append(e); }
        else if (tag === 'SPAN' || tag === 'FONT') {
          const e = document.createElement('span');
          const col = String(tag === 'FONT' ? node.getAttribute('color') || '' : node.style.color || '').trim();
          if (CLR_RE.test(col)) e.style.color = col;
          const fs = node.style && node.style.fontSize;
          if (fs && EM_RE.test(fs)) e.style.fontSize = fs;
          walk(node, e);
          to.append(e);
        } else walk(node, to);
      }
    }
  };
  walk(doc.body, out);
  return out.innerHTML;
}

/** Turns the <font> elements that execCommand makes into spans. Returns the new spans. */
function normalizeRich(ed) {
  const made = [];
  for (const f of [...ed.querySelectorAll('font')]) {
    const s = document.createElement('span');
    const col = f.getAttribute('color');
    if (col) s.style.color = col;
    while (f.firstChild) s.append(f.firstChild);
    f.replaceWith(s);
    made.push(s);
  }
  return made;
}

function reselect(spans) {
  if (!spans.length) return;
  const r = document.createRange();
  r.setStartBefore(spans[0]);
  r.setEndAfter(spans[spans.length - 1]);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** After execCommand('fontSize', 7): give those marked pieces a real size, x times the base size. */
function sizeMarked(ed, x) {
  const base = parseFloat(getComputedStyle(ed).fontSize) || 15;
  const made = [];
  for (const f of [...ed.querySelectorAll('font[size="7"]')]) {
    const s = document.createElement('span');
    while (f.firstChild) s.append(f.firstChild);
    f.replaceWith(s);
    const pf = s.parentElement ? (parseFloat(getComputedStyle(s.parentElement).fontSize) || base) / base : 1;
    s.style.fontSize = (x / pf).toFixed(3) + 'em';
    s.querySelectorAll('[style]').forEach((e) => e.style.removeProperty('font-size'));
    made.push(s);
  }
  return made;
}

function vBrainDump(film, sub) {
  const d = sub.data;

  // Older brain dumps (one text box plus tagged snippets) become stickies the first time they are opened.
  if (!Array.isArray(d.notes)) {
    d.notes = [];
    let i = 0;
    const at = () => { const k = i++; return { x: 30 + (k % 4) * 250, y: 30 + Math.floor(k / 4) * 220, w: 230, h: 180, z: k + 1 }; };
    if ((d.text || '').trim()) d.notes.push({ id: uid(), kind: 'text', text: d.text.trim(), color: STICKY_COLORS[0], tags: [], ...at() });
    for (const s of d.snips || []) d.notes.push({ id: uid(), kind: 'text', text: s.text, color: STICKY_COLORS[0], tags: s.tags || [], ...at() });
    d.text = '';
    d.snips = [];
    filmField(sub.name, () => {});
  }
  return makeBoard(film, { sub });
}

/** The sticky board. Two uses: the whole brain dump of one sub log (`cfg.sub`), or a small canvas inside a shot's
 * dropdown (`cfg.tag`) that shows every brain dump sticky carrying that tag. New stickies made in the small canvas
 * are stored in the project's brain dump and tagged to the shot, so both places always agree. */
function makeBoard(film, cfg) {
  const embedded = !cfg.sub;
  const sub = cfg.sub;
  const tag = cfg.tag || '';
  const d = embedded ? null : sub.data;
  const owner = new Map(); // note -> name of the sub log it is stored in
  const own = (n) => owner.get(n) || (sub && sub.name);
  let notes;
  if (!embedded) {
    notes = d.notes;
    for (const n of notes) owner.set(n, sub.name);
  } else {
    notes = [];
    for (const x of film.sublogs) {
      if (x.kind !== 'braindump') continue;
      for (const n of Array.isArray((x.data || {}).notes) ? x.data.notes : []) {
        if (!(n.tags || []).includes(tag)) continue;
        owner.set(n, x.name);
        notes.push(n);
      }
    }
  }
  for (const n of notes) {
    n.x = +n.x || 0; n.y = +n.y || 0;
    n.w = Math.max(130, +n.w || 230); n.h = Math.max(100, +n.h || 180);
    n.z = +n.z || 1; n.tags = n.tags || [];
  }
  if (embedded) { // older moodboard files have no position: shown read-only in a row under the stickies
    let k = 0;
    const maxY = notes.reduce((m, n) => Math.max(m, n.y + n.h), 0);
    for (const x of film.sublogs) {
      if (x.kind !== 'moodboard') continue;
      for (const f of x.files || []) {
        if (!(((x.data || {}).fileTags || {})[f.path] || []).includes(tag)) continue;
        const n = { id: f.path, kind: 'file', file: f.path, ro: true, tags: [], x: k * 260, y: maxY + 40, w: 240, h: 200, z: 1 };
        owner.set(n, x.name);
        notes.push(n);
        k++;
      }
    }
  }
  let topZ = notes.reduce((m, n) => Math.max(m, n.z), 0);

  const els = new Map();
  /** Saves the sub log a sticky lives in as it is now, without redrawing. With no sticky: the board's own sub log. */
  const save = (n) => { const name = n ? own(n) : sub && sub.name; if (name) return filmField(name, () => {}); };
  /** Where new stickies go: this brain dump, or (in a shot's canvas) the project's first brain dump, made when there is none. */
  const homeName = async () => (embedded ? ensureSub('braindump', 'Brain dump') : sub.name);
  const store = (name) => { const s = (filmOf() || film).sublogs.find((x) => x.name === name); if (!s) return null; if (!Array.isArray(s.data.notes)) s.data.notes = []; return s.data.notes; };
  /* The board is an infinite canvas like Figma's: view = { x, y, z } is where the canvas origin sits on screen and the zoom. */
  const MIN_Z = 0.02, MAX_Z = 4;
  const clampZ = (z) => Math.min(MAX_Z, Math.max(MIN_Z, z));
  const hadView = embedded && shotBoardViews.has(tag);
  let view;
  if (embedded) { view = shotBoardViews.get(tag) || { x: 40, y: 40, z: 1 }; shotBoardViews.set(tag, view); }
  else {
    view = boardView.sub === sub.name ? boardView
      : { sub: sub.name, ...(d.view && Number.isFinite(+d.view.z) ? { x: +d.view.x || 0, y: +d.view.y || 0, z: clampZ(+d.view.z) } : { x: 40, y: 40, z: 1 }) };
    boardView = view;
  }
  const canvas = h('div', { class: 'board-canvas' });
  const hint = h('div', { class: 'board-hint' }, embedded
    ? 'Nothing is on this shot yet. Type something above, paste a link or an image, drop files here, or draw.'
    : 'Type something above, paste a link or an image, drop files here, or draw. Each one becomes a sticky note you can move and resize.');
  const board = h('div', { class: 'board' + (embedded ? ' mini' : ''), tabindex: '-1' }, canvas, hint);
  let zoomLabel = null, viewTimer = null;

  const apply = () => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    let step = 24;
    while (step * view.z < 12) step *= 4; // keep the dot grid from getting too dense when zoomed far out
    board.style.backgroundSize = `${step * view.z}px ${step * view.z}px`;
    board.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (zoomLabel) zoomLabel.textContent = Math.round(view.z * 100) + '%';
    placeFmt();
  };
  const persistView = () => { if (embedded) return; clearTimeout(viewTimer); viewTimer = setTimeout(() => { d.view = { x: Math.round(view.x), y: Math.round(view.y), z: view.z }; save(); }, 500); };
  const refresh = () => { hint.hidden = notes.length > 0; if (cfg.onCount) cfg.onCount(notes.length); };

  /** Zoom around the point (ox, oy) of the board, so what is under it stays under it. */
  const setZoom = (z, ox = board.clientWidth / 2, oy = board.clientHeight / 2) => {
    const nz = Math.round(clampZ(z) * 1000) / 1000;
    if (nz === view.z) return;
    const k = nz / view.z;
    view.x = ox - (ox - view.x) * k;
    view.y = oy - (oy - view.y) * k;
    view.z = nz;
    apply();
    persistView();
  };
  /** Zoom and pan so every sticky is in view. */
  const fit = () => {
    if (!notes.length) { Object.assign(view, { x: 40, y: 40, z: 1 }); apply(); persistView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of notes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
    const bw = board.clientWidth, bh = board.clientHeight, pad = 60;
    const z = clampZ(Math.min((bw - pad * 2) / (x1 - x0), (bh - pad * 2) / (y1 - y0), 2));
    view.z = z;
    view.x = (bw - (x1 - x0) * z) / 2 - x0 * z;
    view.y = (bh - (y1 - y0) * z) / 2 - y0 * z;
    apply();
    persistView();
  };

  /* ----- moving and resizing ----- */
  const gesture = (e, el, n, resize) => {
    if (e.button !== 0 || (!resize && e.target.closest('button,a,textarea,input'))) return;
    e.preventDefault();
    const t = e.currentTarget;
    t.setPointerCapture(e.pointerId);
    window.boardBusy = true;
    const sx = e.clientX, sy = e.clientY, o = { x: n.x, y: n.y, w: n.w, h: n.h };
    n.z = ++topZ;
    el.style.zIndex = n.z;
    el.classList.add('lift');
    const move = (ev) => {
      const dx = (ev.clientX - sx) / view.z, dy = (ev.clientY - sy) / view.z;
      if (resize) { n.w = Math.max(130, Math.round(o.w + dx)); n.h = Math.max(100, Math.round(o.h + dy)); el.style.width = n.w + 'px'; el.style.height = n.h + 'px'; el.style.setProperty('--fs', fontScale(n)); }
      else { n.x = Math.round(o.x + dx); n.y = Math.round(o.y + dy); el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
      placeFmt();
    };
    const end = () => {
      t.removeEventListener('pointermove', move);
      t.removeEventListener('pointerup', end);
      t.removeEventListener('pointercancel', end);
      window.boardBusy = false;
      el.classList.remove('lift');
      refresh();
      placeFmt();
      save(n);
    };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
  };

  /* ----- formatting bar for the text being edited ----- */
  let fmtEd = null, fmtBox = null, pendingSize = 0;
  const fmt = h('div', { class: 'fmt-bar', hidden: true, role: 'toolbar', 'aria-label': 'Text formatting' });
  fmt.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection and the cursor in the note
  const placeFmt = () => {
    if (!fmtBox || !fmtBox.isConnected) return hideFmt();
    const r = fmtBox.getBoundingClientRect();
    fmt.hidden = false;
    fmt.style.left = Math.max(8, Math.min(window.innerWidth - fmt.offsetWidth - 8, r.left)) + 'px';
    fmt.style.top = (r.top > 56 ? r.top - 46 : r.bottom + 8) + 'px';
  };
  const showFmt = (ed, box) => { fmtEd = ed; fmtBox = box; placeFmt(); };
  function hideFmt() { fmt.hidden = true; fmtEd = null; fmtBox = null; }
  const touched = () => { if (fmtEd) { fmtEd.markDirty(); fmtEd.focus(); } };
  const fmtSize = (dir) => {
    const ed = fmtEd, sel = window.getSelection();
    if (!ed || !sel.rangeCount) return;
    const base = parseFloat(getComputedStyle(ed).fontSize) || 15;
    const at = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const cur = at && ed.contains(at) ? (parseFloat(getComputedStyle(at).fontSize) || base) / base : 1;
    const i = SIZE_STEPS.reduce((b, v, k) => (Math.abs(v - cur) < Math.abs(SIZE_STEPS[b] - cur) ? k : b), 0);
    const x = SIZE_STEPS[Math.min(SIZE_STEPS.length - 1, Math.max(0, i + dir))];
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    const made = sizeMarked(ed, x);
    if (made.length) reselect(made); else pendingSize = x; // nothing selected: applies to what is typed next
    touched();
  };
  const fmtColor = (c) => {
    const ed = fmtEd;
    if (!ed) return;
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('foreColor', false, c);
    const made = normalizeRich(ed);
    if (made.length && !window.getSelection().isCollapsed) reselect(made);
    touched();
  };
  const fb = (label, title, fn, cls = '') => h('button', { class: 'btn small quiet ' + cls, type: 'button', title, 'aria-label': title, onclick: fn }, label);
  fmt.append(
    fb('A−', 'Smaller text', () => fmtSize(-1)), fb('A+', 'Larger text', () => fmtSize(1)),
    fb('B', 'Bold', () => { document.execCommand('bold'); touched(); }, 'bold'),
    ...TEXT_COLORS.map((c) => h('button', { class: 'swatch', type: 'button', style: `background:${c}`, title: 'Text colour', 'aria-label': 'Text colour ' + c, onclick: () => fmtColor(c) })),
    fb('Clear', 'Remove all formatting from this note', () => { if (fmtEd) { fmtEd.textContent = fmtEd.innerText; pendingSize = 0; touched(); } }));

  /* ----- one sticky ----- */
  const noteTags = (n) => pickTags(film, n.tags || [], setTags(own(n), (x, ids) => { const y = (x.notes || []).find((z) => z.id === n.id); if (y) y.tags = ids; }), 'Tags');
  const viewFile = (n) => openFile(own(n), { path: n.file, name: String(n.file).split('/').pop(), size: 0, mtime: Date.now() });

  /** A moodboard file from an older project: shown, never edited. */
  const drawRo = (n) => {
    const url = fileUrl(own(n), n.file);
    const media = IMG_RE.test(n.file || '')
      ? h('button', { class: 'st-media', type: 'button', title: 'Open', onclick: () => viewFile(n) }, h('img', { src: url, alt: '', draggable: 'false' }))
      : h('button', { class: 'st-media file', type: 'button', title: n.file, onclick: () => viewFile(n) }, h('span', { class: 'thumb ext' }, extOf(n.file || '') || 'file'), h('span', { class: 'fname' }, String(n.file).split('/').pop()));
    return h('article', { class: 'st st-file', style: `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;z-index:${n.z};--st:#ffffff;--fs:1;background-color:#ffffff` }, h('div', { class: 'st-body', style: 'padding-top:12px' }, media));
  };

  const draw = (n) => {
    if (n.ro) return drawRo(n);
    const color = STICKY_COLORS.includes(n.color) ? n.color : STICKY_COLORS[0];
    const el = h('article', { class: 'st st-' + n.kind + (color === 'transparent' ? ' clear' : ''), style: `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;z-index:${n.z};--st:${color};--fs:${fontScale(n)};background-color:${color}` });
    els.set(n.id, el);
    const chips = (n.tags || []).map((id) => tagChip(film, id)).filter(Boolean);
    const bar = h('div', { class: 'st-bar' }, chips,
      h('button', { class: 'tg add', type: 'button', title: 'Add tags', onclick: () => noteTags(n) }, chips.length ? '+' : '+ tag'),
      h('button', { class: 'st-more', type: 'button', 'aria-label': 'Sticky options', onclick: () => noteSheet(n) }, '⋯'));
    bar.addEventListener('pointerdown', (e) => gesture(e, el, n, false));

    const caption = () => {
      const cap = h('textarea', { class: 'st-cap', placeholder: 'Add a note', 'aria-label': 'Note' });
      cap.value = n.text || '';
      cap.addEventListener('change', () => { n.text = cap.value; save(n); });
      return cap;
    };
    let body;
    if (n.kind === 'link') {
      let host = '';
      try { host = new URL(n.url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
      body = [h('a', { class: 'st-link', href: URL_RE.test(n.url || '') ? n.url : null, target: '_blank', rel: 'noopener noreferrer', title: n.url }, h('b', null, host || n.url), h('span', null, n.url)), caption()];
    } else if (n.kind === 'file' || n.kind === 'draw') {
      const url = fileUrl(own(n), n.file) + (n.v ? '&v=' + n.v : '');
      const isImg = n.kind === 'draw' || IMG_RE.test(n.file || '');
      const media = isImg
        ? h('button', { class: 'st-media', type: 'button', title: n.kind === 'draw' ? 'Edit drawing' : 'Open', onclick: () => (n.kind === 'draw' ? drawSheet(n) : viewFile(n)) }, h('img', { src: url, alt: '', draggable: 'false' }))
        : h('button', { class: 'st-media file', type: 'button', title: n.file, onclick: () => viewFile(n) }, h('span', { class: 'thumb ext' }, extOf(n.file || '') || 'file'), h('span', { class: 'fname' }, String(n.file || '').split('/').pop()));
      body = [media, caption()];
    } else {
      const ed = h('div', { class: 'st-text', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Sticky text', 'data-ph': 'Type something…', spellcheck: 'true' });
      if (n.html) ed.innerHTML = cleanHtml(n.html); else ed.textContent = n.text || '';
      let timer = null, dirty = false;
      const commit = () => {
        clearTimeout(timer);
        if (!dirty) return;
        dirty = false;
        normalizeRich(ed);
        n.html = cleanHtml(ed.innerHTML);
        n.text = ed.innerText.replace(/\u00a0/g, ' ').trim();
        save(n);
      };
      ed.addEventListener('input', () => {
        if (pendingSize) { const m = sizeMarked(ed, pendingSize); if (m.length) pendingSize = 0; }
        dirty = true; clearTimeout(timer); timer = setTimeout(commit, 700);
      });
      ed.addEventListener('focus', () => showFmt(ed, el));
      ed.addEventListener('blur', () => { commit(); if (fmtEd === ed) hideFmt(); });
      ed.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }); // plain text only
      ed.markDirty = () => { dirty = true; clearTimeout(timer); timer = setTimeout(commit, 700); };
      body = [ed];
    }
    const grip = h('div', { class: 'st-resize', 'aria-hidden': 'true' });
    grip.addEventListener('pointerdown', (e) => gesture(e, el, n, true));
    el.addEventListener('pointerdown', () => { if (n.z !== topZ) { n.z = ++topZ; el.style.zIndex = n.z; } });
    el.append(bar, h('div', { class: 'st-body' }, body), grip);
    return el;
  };

  /* ----- adding stickies ----- */
  const spot = () => { const k = notes.length % 7; return { x: Math.round((board.clientWidth / 2 - view.x) / view.z - 115 + k * 24), y: Math.round((board.clientHeight / 2 - view.y) / view.z - 90 + k * 24) }; };
  const add = async (n, at, subName) => {
    const name = subName || (await homeName());
    if (!name) return null;
    const note = { id: uid(), kind: 'text', text: '', color: STICKY_COLORS[0], tags: tag ? [tag] : [], z: ++topZ, ...n, ...(at || spot()) };
    owner.set(note, name);
    if (embedded) { const arr = store(name); if (arr) arr.push(note); }
    if (!embedded || board.isConnected) { notes.push(note); canvas.append(draw(note)); refresh(); }
    await save(note);
    if (embedded && !board.isConnected) render(); // the page was redrawn while this was being made: show it
    return note;
  };
  const addText = (raw, at) => {
    const text = String(raw || '').trim();
    if (!text) return false;
    if (URL_RE.test(text)) add({ kind: 'link', url: text.slice(0, 2000), w: 250, h: 150 }, at);
    else add({ kind: 'text', text: text.slice(0, 5000), w: 230, h: Math.max(150, Math.min(420, 76 + Math.ceil(text.length / 26) * 22 + (text.split('\n').length - 1) * 22)) }, at);
    return true;
  };
  const addFiles = async (files, at) => {
    const name = await homeName();
    if (!name) return;
    let i = 0;
    for (const f of files) {
      try {
        const path = await putBoardFile(name, f, f.name);
        let hh = 150;
        if (IMG_RE.test(path)) hh = Math.round(Math.min(520, Math.max(140, 216 * (await imgRatio(fileUrl(name, path))) + 92)));
        await add({ kind: 'file', file: path, w: 240, h: hh }, at ? { x: at.x + i * 28, y: at.y + i * 28 } : undefined, name);
        i++;
      } catch (e) { toast(`${f.name || 'File'}: ${e.message}`, true); }
    }
  };

  /* ----- turning a sticky into something else ----- */
  const attachSheet = (n) => {
    const scenes = sceneList(film);
    const shots = allShots(film);
    const sel = new Set(n.tags || []);
    const body = h('div');
    const chip = (id, label, ty) => h('button', { class: 'tg tg-' + ty + (sel.has(id) ? ' on' : ''), type: 'button', 'aria-pressed': String(sel.has(id)), onclick: () => { if (sel.has(id)) sel.delete(id); else sel.add(id); paint(); } }, label);
    const paint = () => body.replaceChildren(
      sec('Scenes', scenes.length ? h('div', { class: 'tgrow' }, scenes.map((s) => chip(s.tag, clipText(sceneLabel(s), 44), 'scene'))) : h('p', { class: 'note' }, 'No scenes yet. Write a scene heading in a Script writer sub log, or turn a sticky into a scene.')),
      sec('Shots', shots.length ? h('div', { class: 'tgrow' }, shots.map((s) => chip(s.tag, clipText(`${(tagOf(film, s.tag) || {}).name || 'Shot'}${s.desc ? ': ' + s.desc : ''}`, 44), 'shot'))) : h('p', { class: 'note' }, 'No shots yet. Add one in a Shot list sub log, or turn a sticky into a shot.')));
    paint();
    openSheet('Attach to a scene or shot', body, sec(null, row(btn('Done', () => { closeSheet(); setTags(own(n), (x, ids) => { const y = (x.notes || []).find((z) => z.id === n.id); if (y) y.tags = ids; })([...sel], []); }, 'primary'), btn('Cancel', closeSheet, 'quiet'))));
  };

  const attachTo = (c, n, tagId) => { const y = (c.sub(own(n)).notes || []).find((z) => z.id === n.id); if (y && !(y.tags || []).includes(tagId)) y.tags = [...(y.tags || []), tagId]; };

  const toScene = async (n) => {
    closeSheet();
    const script = await ensureSub('script', 'Script');
    if (!script) return;
    const lines = noteLabel(n).split('\n').map((s) => s.trim()).filter(Boolean);
    const head = (lines[0] || 'Untitled scene').slice(0, 200);
    const rest = lines.slice(1).join('\n');
    filmDo((c) => {
      const tag = { id: uid(), name: '', type: 'scene' }; // renumber() names it
      c.meta.tags.push(tag);
      const x = c.sub(script);
      (x.blocks ||= []).push({ id: uid(), kind: 'scene', text: head, tag: tag.id, tags: [], marks: [] });
      if (rest) x.blocks.push({ id: uid(), kind: 'action', text: rest.slice(0, 3000), tags: [], marks: [] });
      attachTo(c, n, tag.id);
    }, 'Turned into a new scene in your script.');
  };

  const toShot = async (n, scene) => {
    closeSheet();
    const shots = await ensureSub('shotlist', 'Shot list');
    if (!shots) return;
    filmDo((c) => {
      c.meta.shots = (c.meta.shots || 0) + 1;
      const tag = { id: uid(), name: 'Shot', type: 'shot' };
      c.meta.tags.push(tag);
      (c.sub(shots).shots ||= []).push({ id: uid(), tag: tag.id, scene: scene || '', size: '', move: '', desc: noteLabel(n).slice(0, 500), tags: [] });
      attachTo(c, n, tag.id);
    }, 'Turned into a new shot in your shot list.');
  };

  const shotSheet = (n) => {
    const scenes = sceneList(film);
    if (!scenes.length) return toShot(n, '');
    const pre = (n.tags || []).find((id) => scenes.some((s) => s.tag === id)) || '';
    const pick = h('select', { class: 'field grow', 'aria-label': 'Scene' }, h('option', { value: '' }, 'No scene'), scenes.map((s) => h('option', { value: s.tag }, clipText(sceneLabel(s), 60))));
    pick.value = pre;
    openSheet('Turn into a shot', sec('In which scene?', row(pick, btn('Create shot', () => toShot(n, pick.value), 'primary'))));
  };

  const remove = (n) => {
    closeSheet();
    const name = own(n);
    notes.splice(notes.indexOf(n), 1);
    if (embedded) { const arr = store(name); const i = arr ? arr.indexOf(n) : -1; if (i >= 0) arr.splice(i, 1); else if (arr) { const j = arr.findIndex((z) => z.id === n.id); if (j >= 0) arr.splice(j, 1); } }
    const el = els.get(n.id);
    if (el) el.remove();
    refresh();
    save(n);
    if (n.file) fetch(fileUrl(name, n.file), { method: 'DELETE', headers: { 'X-Bujo': '1' } }).catch(() => {}); // goes to .trash
  };

  const noteSheet = (n) => {
    const cur = STICKY_COLORS.includes(n.color) ? n.color : STICKY_COLORS[0];
    const swatches = h('div', { class: 'swatches' }, STICKY_COLORS.map((c) => h('button', {
      class: 'swatch' + (c === 'transparent' ? ' clear' : '') + (c === cur ? ' on' : ''), type: 'button', style: c === 'transparent' ? null : `background:${c}`, title: COLOR_NAMES[c], 'aria-label': 'Colour: ' + COLOR_NAMES[c],
      onclick: () => { n.color = c; const el = els.get(n.id); if (el) { el.style.setProperty('--st', c); el.style.backgroundColor = c; el.classList.toggle('clear', c === 'transparent'); } closeSheet(); save(n); },
    })));
    const applyFont = () => { const el = els.get(n.id); if (el) el.style.setProperty('--fs', fontScale(n)); save(n); };
    const size = h('input', { class: 'field size-in', type: 'number', min: '8', max: '120', step: '1', value: String(n.font || 15), 'aria-label': 'Font size in pixels' });
    const setSize = (v) => { n.font = Math.min(120, Math.max(8, Math.round(+v) || 15)); size.value = String(n.font); applyFont(); };
    size.addEventListener('change', () => setSize(size.value));
    const grow = h('input', { type: 'checkbox', checked: !n.fixed, onchange: () => { n.fixed = !grow.checked; applyFont(); } });
    openSheet(clipText(noteLabel(n), 40),
      sec('Colour', swatches),
      sec('Font size', row(btn('−', () => setSize((n.font || 15) - 1), 'small'), size, btn('+', () => setSize((n.font || 15) + 1), 'small'),
        ...[['S', 12], ['M', 15], ['L', 22], ['XL', 32]].map(([l, v]) => btn(l, () => setSize(v), 'small quiet'))),
        h('label', { class: 'note check' }, grow, ' Grow the text when the note is enlarged')),
      sec('Connect', row(btn('Tags…', () => noteTags(n)), btn('Attach to a scene or shot', () => attachSheet(n)))),
      sec('Turn into', row(btn('Scene', () => toScene(n)), btn('Shot', () => shotSheet(n))), h('p', { class: 'note' }, 'The sticky stays on the board, connected to the scene or shot it becomes.')),
      n.kind === 'draw' ? sec(null, row(btn('Edit drawing', () => drawSheet(n)))) : n.kind === 'file' ? sec(null, row(btn('Open file', () => { closeSheet(); viewFile(n); }))) : n.kind === 'link' && URL_RE.test(n.url || '') ? sec(null, row(btn('Open link', () => { closeSheet(); window.open(n.url, '_blank', 'noopener,noreferrer'); }))) : null,
      sec(null, row(btn('Delete sticky', () => remove(n), 'danger'))));
  };

  /* ----- drawing ----- */
  function drawSheet(n) {
    const cv = h('canvas', { class: 'draw-canvas', width: DRAW_W, height: DRAW_H, 'aria-label': 'Drawing area' });
    const ctx = cv.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let color = PEN_COLORS[0], size = 4, erase = false, last = null;
    const undo = [];
    const snap = () => { undo.push(ctx.getImageData(0, 0, DRAW_W, DRAW_H)); if (undo.length > 25) undo.shift(); };
    if (n && n.file) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, DRAW_W, DRAW_H); img.src = fileUrl(own(n), n.file, '&v=' + Date.now()); }
    const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) * DRAW_W) / r.width, y: ((e.clientY - r.top) * DRAW_H) / r.height }; };
    const stroke = (a, b) => {
      ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth = erase ? size * 4 : size;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x + 0.01, b.y); ctx.stroke();
    };
    cv.addEventListener('pointerdown', (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); snap(); last = pt(e); stroke(last, last); });
    cv.addEventListener('pointermove', (e) => { if (!last) return; const p = pt(e); stroke(last, p); last = p; });
    for (const ev of ['pointerup', 'pointercancel']) cv.addEventListener(ev, () => { last = null; });

    const colorBtns = PEN_COLORS.map((c) => h('button', { class: 'swatch', type: 'button', style: `background:${c}`, 'aria-label': 'Pen colour ' + c, onclick: () => { color = c; erase = false; sync(); } }));
    const sizeBtns = [['Thin', 2], ['Medium', 5], ['Thick', 11]].map(([label, v]) => btn(label, () => { size = v; sync(); }, 'small'));
    const eraser = btn('Eraser', () => { erase = !erase; sync(); }, 'small');
    const sync = () => {
      colorBtns.forEach((b, i) => b.classList.toggle('on', !erase && PEN_COLORS[i] === color));
      sizeBtns.forEach((b, i) => b.classList.toggle('on', [2, 5, 11][i] === size));
      eraser.classList.toggle('on', erase);
    };
    sync();
    const finish = () => cv.toBlob(async (blob) => {
      if (!blob) return toast('Could not save the drawing.', true);
      try {
        const editing = !!(n && n.file);
        const name = editing ? own(n) : await homeName();
        if (!name) return;
        const path = await putBoardFile(name, blob, editing ? n.file : 'drawing.png', editing);
        closeSheet();
        if (editing) {
          n.v = Date.now();
          const old = els.get(n.id);
          if (old) old.replaceWith(draw(n));
          save(n);
        } else add({ kind: 'draw', file: path, w: 300, h: Math.round(276 * (DRAW_H / DRAW_W)) + 92 }, undefined, name);
      } catch (e) { toast(e.message, true); }
    }, 'image/png');
    openSheet(n ? 'Edit drawing' : 'Draw', cv,
      h('div', { class: 'draw-tools' }, colorBtns, sizeBtns, eraser,
        btn('Undo', () => { const s = undo.pop(); if (s) ctx.putImageData(s, 0, 0); }, 'small quiet'),
        btn('Clear', () => { snap(); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, DRAW_W, DRAW_H); }, 'small quiet')),
      sec(null, row(btn('Save as sticky', finish, 'primary'), btn('Cancel', closeSheet, 'quiet'))));
  }

  /* ----- the add bar, pasting and dropping ----- */
  const quick = h('textarea', { class: 'field quick-in', rows: 1, placeholder: embedded ? 'Add a note, link or image to this shot…' : 'Type something, or paste a link or an image…', 'aria-label': 'New sticky' });
  quick.addEventListener('input', () => { quick.style.height = 'auto'; quick.style.height = Math.min(160, quick.scrollHeight) + 'px'; });
  const submit = () => { if (addText(quick.value)) { quick.value = ''; quick.style.height = ''; quick.focus(); } };
  quick.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { const files = [...picker.files]; picker.value = ''; if (files.length) addFiles(files); } });

  const onPaste = (e) => {
    if (!board.isConnected) { document.removeEventListener('paste', onPaste); return; }
    const t = e.target;
    const field = t && t.closest && t.closest('textarea,input,select,[contenteditable="true"]');
    if (document.querySelector('dialog[open]') || (field && field !== quick)) return;
    if (embedded && field !== quick && !board.matches(':hover')) return; // a shot's canvas only takes pastes while the pointer is on it
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...cd.files];
    if (files.length) { e.preventDefault(); addFiles(files); return; }
    if (field === quick) return; // plain text pasted into the add bar stays in the add bar
    const text = cd.getData('text/plain');
    if (text.trim()) { e.preventDefault(); addText(text); }
  };
  if (!embedded) { if (boardPaste) document.removeEventListener('paste', boardPaste); boardPaste = onPaste; }
  document.addEventListener('paste', onPaste);

  const accepts = (e) => e.dataTransfer && ['Files', 'text/uri-list', 'text/plain'].some((k) => [...e.dataTransfer.types].includes(k));
  board.addEventListener('dragover', (e) => { if (accepts(e)) { e.preventDefault(); board.classList.add('drop'); } });
  board.addEventListener('dragleave', (e) => { if (!board.contains(e.relatedTarget)) board.classList.remove('drop'); });
  board.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    board.classList.remove('drop');
    const r = canvas.getBoundingClientRect();
    const at = { x: Math.round((e.clientX - r.left) / view.z - 20), y: Math.round((e.clientY - r.top) / view.z - 20) };
    if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files], at);
    else addText(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'), at);
  });

  /* ----- build ----- */
  for (const n of notes) canvas.append(draw(n));
  refresh();

  /* ----- moving around the board: wheel / two fingers pan, Ctrl or Cmd + wheel / pinch zooms, drag the background, middle button or Space + drag pans ----- */
  let space = false;
  board.addEventListener('wheel', (e) => {
    const r = board.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const step = Math.abs(e.deltaY) >= 50 ? (e.deltaY < 0 ? 1.15 : 1 / 1.15) : Math.exp(-e.deltaY * 0.01); // a mouse wheel notch, or a trackpad pinch
      setZoom(view.z * step, e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (embedded) return; // in a shot's canvas the wheel keeps scrolling the page; drag the background to pan
    const ed = e.target.closest && e.target.closest('.st-text');
    if (ed && document.activeElement === ed && ed.scrollHeight > ed.clientHeight + 1) return; // let a long note scroll while you edit it
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1;
    view.x -= e.deltaX * k;
    view.y -= e.deltaY * k;
    apply();
    persistView();
  }, { passive: false });

  const startPan = (e) => {
    board.setPointerCapture(e.pointerId);
    window.boardBusy = true;
    board.classList.add('panning');
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    const move = (ev) => { view.x = ox + ev.clientX - sx; view.y = oy + ev.clientY - sy; apply(); };
    const end = () => {
      board.removeEventListener('pointermove', move);
      board.removeEventListener('pointerup', end);
      board.removeEventListener('pointercancel', end);
      window.boardBusy = false;
      board.classList.remove('panning');
      persistView();
    };
    board.addEventListener('pointermove', move);
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
  };
  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.fmt-bar')) return;
    const onSticky = !!e.target.closest('.st');
    if (e.button === 1 || (e.button === 0 && (space || !onSticky))) {
      e.preventDefault();
      e.stopPropagation(); // the sticky under the pointer does not get this click
      const a = document.activeElement;
      if (a && a !== document.body && a.blur) a.blur();
      startPan(e);
    }
  }, true);

  const typing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const onKeyDown = (e) => {
    if (!board.isConnected) { if (boardKeyOff) boardKeyOff(); return; }
    if (document.querySelector('dialog[open]') || typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { space = true; board.classList.add('hand'); e.preventDefault(); }
    else if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(view.z * 1.25); }
    else if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); setZoom(view.z / 1.25); }
    else if (mod && e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); fit(); }
    else if (e.shiftKey && e.code === 'Digit0') { e.preventDefault(); setZoom(1); }
  };
  const onKeyUp = (e) => { if (e.code === 'Space') { space = false; board.classList.remove('hand'); } };
  if (!embedded) {
    if (boardKeyOff) boardKeyOff();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    boardKeyOff = () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('keyup', onKeyUp); boardKeyOff = null; };
  }
  const onScroll = () => { if (!board.isConnected) return window.removeEventListener('scroll', onScroll, true); if (!fmt.hidden) placeFmt(); };
  window.addEventListener('scroll', onScroll, true); // the format bar is fixed to the screen, so it follows the page

  apply();
  if (embedded && !hadView && typeof ResizeObserver === 'function') { // fit once, when the dropdown is first open and has a size
    const ro = new ResizeObserver(() => { if (board.clientWidth > 0) { ro.disconnect(); fit(); } });
    ro.observe(board);
  }

  return h('div', { class: 'braindump' + (embedded ? ' mini' : '') },
    h('div', { class: 'quick' }, quick, btn('Add', submit, 'primary'), btn('Attach', () => picker.click()), btn('Draw', () => drawSheet(null)), picker,
      h('div', { class: 'zoombar', role: 'group', 'aria-label': 'Zoom' },
        h('button', { class: 'btn small quiet', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (Ctrl/Cmd −)', onclick: () => setZoom(view.z / 1.25) }, '−'),
        (zoomLabel = h('button', { class: 'btn small quiet zoom-val', type: 'button', title: 'Back to 100% (Shift 0)', onclick: () => setZoom(1) }, Math.round(view.z * 100) + '%')),
        h('button', { class: 'btn small quiet', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (Ctrl/Cmd +)', onclick: () => setZoom(view.z * 1.25) }, '+'),
        h('button', { class: 'btn small quiet', type: 'button', title: 'Zoom to fit everything (Shift 1)', onclick: fit }, 'Fit'))),
    board, fmt);
}

/* ---------- 2. Moodboard ---------- */

function vMoodboard(film, sub) {
  const ft = sub.data.fileTags || {};
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { if (picker.files.length) uploadFiles(sub.name, picker.files); } });
  const IMG = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
  const box = h('section', { class: 'files' },
    h('div', { class: 'files-head' }, h('h3', null, 'References'), btn('Upload files', () => picker.click(), 'small'), picker),
    h('p', { class: 'files-hint' }, 'Drop images, PDFs, audio or video here. Tag any of them to connect it to your shots, locations and cast.'),
    sub.files.length ? h('ul', { class: 'file-grid' }, sub.files.map((f) => h('li', { class: 'mood' },
      h('button', { class: 'file', type: 'button', title: f.path, onclick: () => openFile(sub.name, f) },
        IMG.test(f.name) ? h('span', { class: 'thumb tall' }, h('img', { src: fileUrl(sub.name, f.path), alt: '', loading: 'lazy' })) : h('span', { class: 'thumb ext tall' }, extOf(f.name) || 'file'),
        h('span', { class: 'fname' }, f.path)),
      tagRow(film, ft[f.path], setTags(sub.name, (x, ids) => { (x.fileTags ||= {})[f.path] = ids; }))))) : h('div', { class: 'files-empty' }, 'Nothing here yet.'));
  box.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('drop'); } });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop'); });
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drop'); if (e.dataTransfer.files.length) uploadFiles(sub.name, e.dataTransfer.files); });
  return box;
}

/* ---------- 3. Script writer: write it, or select text and tag it ---------- */

let scriptMode = 'write';
const hlType = (film, m) => { const t = (m.tags || []).map((id) => tagOf(film, id)).find(Boolean); return t ? t.type : 'other'; };

function vScript(film, sub) {
  const blocks = sub.data.blocks || [];
  const modeBar = row(
    btn('Write', () => { scriptMode = 'write'; render(); }, 'small' + (scriptMode === 'write' ? ' on' : '')),
    btn('Tag', () => { scriptMode = 'tag'; render(); }, 'small' + (scriptMode === 'tag' ? ' on' : '')),
    h('span', { class: 'note' }, scriptMode === 'tag' ? 'Select any words, then choose what they are. They are highlighted and show up in the breakdown of their scene.' : 'Each scene heading becomes a scene. Switch to Tag to mark cast, props, locations…'));
  return h('div', { class: 'script' }, modeBar, scriptMode === 'tag' ? scriptTag(film, sub, blocks) : scriptWrite(film, sub, blocks));
}

function scriptWrite(film, sub, blocks) {
  const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  const mk = (kind, text) => ({ id: uid(), kind, text: text || '', tags: [], marks: [] });
  const insertAfter = (at, kind, text) => {
    const nb = mk(kind);
    state.refocus = 'blk:' + nb.id;
    filmDo((c) => {
      const x = c.sub(sub.name);
      if (at) { const cur = x.blocks.find((y) => y.id === at.id); if (cur) cur.text = text; }
      const i = at ? x.blocks.findIndex((y) => y.id === at.id) : x.blocks.length - 1;
      x.blocks.splice(i + 1, 0, nb);
    });
  };

  const rows = blocks.map((b) => {
    const ta = h('textarea', { class: 'sb-text', rows: 1, 'data-cid': 'blk:' + b.id, placeholder: BLOCKS[b.kind], 'aria-label': BLOCKS[b.kind] });
    ta.value = b.text || '';
    ta.addEventListener('input', () => grow(ta));
    ta.addEventListener('change', () => filmField(sub.name, (x) => {
      const y = x.blocks.find((z) => z.id === b.id);
      if (!y) return;
      y.text = ta.value;
      y.marks = (y.marks || []).map((m) => { const i = y.text.indexOf(m.text); return i < 0 ? null : { ...m, s: i, e: i + m.text.length }; }).filter(Boolean);
    }));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); insertAfter(b, NEXT_BLOCK[b.kind], ta.value); } });
    
    const kind = h('select', { class: 'sb-kind', 'aria-label': 'Line type', onchange: () => filmDo((c) => {
      const y = c.sub(sub.name).blocks.find((z) => z.id === b.id);
      if (!y) return;
      y.text = ta.value;
      if (y.kind === 'scene' && kind.value !== 'scene' && y.tag) { dropTag(c, y.tag); y.tag = ''; }
      y.kind = kind.value;
    }) }, Object.entries(BLOCKS).map(([k, v]) => h('option', { value: k }, v)));
    kind.value = b.kind;
    
    const no = b.kind === 'scene' && tagOf(film, b.tag) ? h('span', { class: 'sb-no', title: 'Drag to reorder scenes' }, tagOf(film, b.tag).name) : null;

    // Set up drag-and-drop variables specific to scene blocks
    const isScene = b.kind === 'scene';
    const wrap = h('div', { 
      class: 'sblock sb-' + b.kind,
      draggable: isScene,
      ondragstart: isScene ? (e) => {
        if (e.target.tagName === 'TEXTAREA') { e.preventDefault(); return; } // Let users select text normally
        e.dataTransfer.setData('text/plain', b.id);
        e.dataTransfer.effectAllowed = 'move';
        wrap.style.opacity = '0.5';
      } : null,
      ondragend: isScene ? () => { wrap.style.opacity = ''; } : null,
      ondragover: isScene ? (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = wrap.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        wrap.style.borderTop = after ? '' : '2px solid #09f';
        wrap.style.borderBottom = after ? '2px solid #09f' : '';
      } : null,
      ondragleave: isScene ? () => { wrap.style.borderTop = ''; wrap.style.borderBottom = ''; } : null,
      ondrop: isScene ? (e) => {
        wrap.style.borderTop = '';
        wrap.style.borderBottom = '';
        const dragId = e.dataTransfer.getData('text/plain');
        if (!dragId || dragId === b.id) return;
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;

        filmDo((c) => {
          const x = c.sub(sub.name);
          const blks = x.blocks;
          
          // 1. Locate the dragged scene and its trailing lines
          const srcStart = blks.findIndex(z => z.id === dragId);
          if (srcStart < 0) return;
          let srcEnd = srcStart + 1;
          while (srcEnd < blks.length && blks[srcEnd].kind !== 'scene') srcEnd++;
          
          // Pull it out of the array entirely
          const chunk = blks.splice(srcStart, srcEnd - srcStart);

          // 2. Locate the drop target scene bounds
          const destStart = blks.findIndex(z => z.id === b.id);
          if (destStart < 0) return;
          let destEnd = destStart + 1;
          while (destEnd < blks.length && blks[destEnd].kind !== 'scene') destEnd++;

          // 3. Drop it before or after the target scene group
          const insertAt = after ? destEnd : destStart;
          blks.splice(insertAt, 0, ...chunk);
        }, 'Scene moved.');
      } : null
    }, 
      h('div', { class: 'sb-top', style: isScene ? 'cursor: grab;' : '' }, kind, no), 
      ta,
      h('button', { class: 'btn small quiet danger sb-del', type: 'button', 'aria-label': 'Remove line', onclick: () => filmDo((c) => {
        const x = c.sub(sub.name);
        const y = x.blocks.find((z) => z.id === b.id);
        x.blocks = x.blocks.filter((z) => z.id !== b.id);
        if (y && y.tag) dropTag(c, y.tag);
      }) }, '×')
    );
    
    requestAnimationFrame(() => grow(ta));
    return wrap;
  });

  return h('div', null,
    rows.length ? rows : h('div', { class: 'card empty' }, 'An empty page. Start with a scene heading, for example INT. DINER - NIGHT.'),
    h('div', { class: 'row sb-add' }, h('span', { class: 'note' }, 'Add'), Object.entries(BLOCKS).map(([k, v]) => btn(v, () => insertAfter(null, k, ''), 'small')),
      h('span', { class: 'note' }, 'Enter adds the next line.')));
}
/** The script as read-only text with the tagged words highlighted. Selecting words offers the categories. */
function scriptTag(film, sub, blocks) {
  const root = h('div', { class: 'script-read' });
  const bar = h('div', { class: 'sel-bar', hidden: true });
  const hide = () => { bar.hidden = true; };
  const selection = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const owner = (n) => (n.nodeType === 1 ? n : n.parentElement).closest('[data-bid]');
    const a = owner(r.startContainer);
    if (!a || a !== owner(r.endContainer) || !root.contains(a)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(a);
    pre.setEnd(r.startContainer, r.startOffset);
    const text = r.toString();
    const s = pre.toString().length;
    return text.trim() ? { bid: a.dataset.bid, s, e: s + text.length, text, rect: r.getBoundingClientRect() } : null;
  };
  const addMark = (pick, type) => {
    hide();
    pickTags(film, [], (ids, fresh) => {
      if (!ids.length) return;
      filmDo((c) => {
        addTags(c.meta, fresh);
        const b = c.sub(sub.name).blocks.find((z) => z.id === pick.bid);
        if (!b) return;
        b.marks = b.marks || [];
        if (b.marks.some((m) => m.s < pick.e && pick.s < m.e)) return toast('Part of that is already tagged. Select it and change its tags instead.', true);
        b.marks.push({ id: uid(), text: b.text.slice(pick.s, pick.e), s: pick.s, e: pick.e, tags: ids });
      });
    }, `Tag “${pick.text.trim().slice(0, 40)}”`, { type, name: pick.text.trim() });
  };
  const show = () => {
    const pick = selection();
    if (!pick) return hide();
    bar.replaceChildren(...ELEMENTS.map((ty) => h('button', { class: 'tg tg-' + ty, type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => addMark(pick, ty) }, TAG_TYPES[ty])));
    bar.style.left = Math.max(8, Math.min(window.innerWidth - 380, pick.rect.left)) + 'px';
    bar.style.top = Math.max(8, pick.rect.top - 44) + 'px';
    bar.hidden = false;
  };
  root.addEventListener('mouseup', () => setTimeout(show, 0));
  root.addEventListener('keyup', (e) => { if (e.shiftKey || e.key.startsWith('Arrow')) show(); });
  root.addEventListener('mousedown', (e) => { if (!bar.contains(e.target)) hide(); });
  window.addEventListener('scroll', hide, { once: true, passive: true });

  for (const b of blocks) {
    const text = b.text || '';
    const parts = [];
    let pos = 0;
    for (const m of [...(b.marks || [])].sort((x, y) => x.s - y.s)) {
      if (m.s < pos || text.slice(m.s, m.e) !== m.text) continue;
      parts.push(text.slice(pos, m.s), h('mark', {
        class: 'hl tg-' + hlType(film, m), title: (m.tags || []).map((id) => (tagOf(film, id) || {}).name).filter(Boolean).join(', '),
        onclick: () => { if (window.getSelection().isCollapsed) markSheet(film, sub, b, m); },
      }, m.text));
      pos = m.e;
    }
    parts.push(text.slice(pos));
    const no = b.kind === 'scene' && tagOf(film, b.tag) ? h('span', { class: 'sb-no' }, tagOf(film, b.tag).name) : null;
    root.append(h('div', { class: 'sblock sb-' + b.kind }, no, h('div', { class: 'sb-text view', 'data-bid': b.id }, parts)));
  }
  if (!blocks.length) root.append(h('div', { class: 'card empty' }, 'Nothing to tag yet. Write your script first.'));
  return h('div', null, root, bar);
}

function markSheet(film, sub, b, m) {
  openSheet(`“${m.text}”`,
    sec('Tagged as', h('div', { class: 'tgrow' }, (m.tags || []).map((id) => tagChip(film, id)))),
    sec(null, row(
      btn('Change tags', () => pickTags(film, m.tags || [], (ids, fresh) => filmDo((c) => {
        addTags(c.meta, fresh);
        const y = c.sub(sub.name).blocks.find((z) => z.id === b.id);
        if (!y) return;
        if (!ids.length) y.marks = y.marks.filter((z) => z.id !== m.id);
        else { const z = y.marks.find((q) => q.id === m.id); if (z) z.tags = ids; }
      }), 'Tags'), 'primary'),
      btn('Remove highlight', () => { closeSheet(); filmDo((c) => { const y = c.sub(sub.name).blocks.find((z) => z.id === b.id); if (y) y.marks = y.marks.filter((z) => z.id !== m.id); }); }, 'danger'))));
}

/* ---------- 4 + 5. Shot list and storyboard: the same shots, two views ---------- */

const shotOpen = new Set(); // shots whose Details are open, kept across redraws
let shotMode = 'list'; // 'list' or 'board'
let shotModeFor = ''; // opening another sub log starts in that sub log's own view

function vShotViews(film, sub) {
  if (shotModeFor !== sub.name) { shotModeFor = sub.name; shotMode = sub.kind === 'storyboard' ? 'board' : 'list'; }
  // Both views live in the shot list sub log. An older, separate storyboard sub log just opens the same view.
  const body = subsOf(film, 'shotlist').find((s) => s.name === sub.name) || subsOf(film, 'shotlist')[0];
  return h('div', null,
    row(
      btn('Shot list', () => { shotMode = 'list'; render(); }, 'small' + (shotMode === 'list' ? ' on' : '')),
      btn('Storyboard', () => { shotMode = 'board'; render(); }, 'small' + (shotMode === 'board' ? ' on' : '')),
      h('span', { class: 'note' }, 'The same shots in two views. Reorder them in the shot list.')),
    body ? (shotMode === 'board' ? storyboardBody : shotListBody)(film, body)
      : h('div', { class: 'card empty' }, h('p', null, 'This project has no shot list yet.'), row(btn('Create shot list', () => ensureSub('shotlist', 'Shot list'), 'primary'))));
}

/* ---------- 4. Shot list view: shots under each scene, drag to reorder ---------- */

const sceneLabel = (sc) => `${(tagOf(filmOf(), sc.tag) || {}).name || 'Scene'}${sc.text ? ': ' + sc.text : ''}`;

function shotListBody(film, sub) {
  const shots = sub.data.shots || [];
  const scenes = sceneList(film);
  const inScene = new Set(scenes.map((x) => x.tag));
  const sel = (opts, val, onchange, label) => { const s = h('select', { class: 'field', 'aria-label': label, onchange: () => onchange(s.value) }, opts.map((o) => h('option', { value: o }, o || label))); s.value = val || ''; return s; };
  const edit = (id, key) => (v) => filmField(sub.name, (x) => { const s = x.shots.find((y) => y.id === id); if (s) s[key] = v; });
  /* Your own shot attributes (Light: Soft/Hard, Lens: 35mm/50mm ...). Defined once in the shot list (sub.data.attrDefs),
   * each one becomes its own dropdown on every shot; a shot's choices are stored in shot.attrs. */
  const attrs = sub.data.attrDefs || [];
  const attrSheet = (focusId, shotId) => { // shotId: the shot it was opened from; attributes created now are put on that shot
    const had = new Set(attrs.map((a) => a.id));
    const draft = structuredClone(attrs);
    let focus = focusId || null, pendingNew = ''; // text typed but not yet added is kept, and added when you press Done
    const draw = () => {
      const newName = h('input', { class: 'field grow', type: 'text', maxlength: 40, value: pendingNew, placeholder: 'New attribute, e.g. Light, Lens, Mood', 'aria-label': 'New attribute name' });
      newName.addEventListener('input', () => { pendingNew = newName.value; });
      const addAttr = () => {
        const n = newName.value.trim();
        if (!n) return;
        const a = { id: uid(), name: n, options: [] };
        draft.push(a);
        pendingNew = '';
        focus = a.id;
        draw();
      };
      newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAttr(); } });
      const block = (a) => {
        const nm = h('input', { class: 'field grow', type: 'text', value: a.name, maxlength: 40, 'aria-label': 'Attribute name' });
        nm.addEventListener('input', () => { a.name = nm.value; });
        const opt = h('input', { class: 'field grow', type: 'text', maxlength: 40, value: a._opt || '', placeholder: 'Add an option, e.g. Soft', 'aria-label': 'New option for ' + a.name });
        opt.addEventListener('input', () => { a._opt = opt.value; });
        const addOpt = () => {
          const v = opt.value.trim();
          if (!v) return;
          a._opt = '';
          if (!a.options.some((x) => x.toLowerCase() === v.toLowerCase())) a.options.push(v);
          focus = a.id;
          draw();
        };
        opt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOpt(); } });
        if (focus === a.id) setTimeout(() => opt.focus(), 0);
        return h('div', { class: 'card film-card' },
          row(nm, btn('Delete attribute', () => { draft.splice(draft.indexOf(a), 1); draw(); }, 'small quiet danger')),
          a.options.length ? h('div', { class: 'tgrow' }, a.options.map((o) => h('button', { class: 'tg tg-other', type: 'button', title: 'Remove this option', onclick: () => { a.options.splice(a.options.indexOf(o), 1); draw(); } }, o, h('i', null, '×')))) : h('p', { class: 'note' }, 'No options yet.'),
          row(opt, btn('Add option', addOpt, 'small')));
      };
      const done = () => {
        const nn = pendingNew.trim(); // anything typed but not added yet still counts
        if (nn && !draft.some((a) => a.name.trim().toLowerCase() === nn.toLowerCase())) draft.push({ id: uid(), name: nn, options: [] });
        for (const a of draft) {
          const v = (a._opt || '').trim();
          if (v && !a.options.some((x) => x.toLowerCase() === v.toLowerCase())) a.options.push(v);
        }
        closeSheet();
        filmDo((c) => {
          const clean = draft.map((a) => ({ id: a.id, name: a.name.trim() || 'Attribute', options: a.options }));
          c.sub(sub.name).attrDefs = clean;
          for (const y of c.sub(sub.name).shots || []) {
            if (shotId && y.id === shotId) y.attrIds = [...new Set([...(y.attrIds || []), ...clean.filter((a) => !had.has(a.id)).map((a) => a.id)])];
            if (y.attrIds) y.attrIds = y.attrIds.filter((k) => clean.some((z) => z.id === k)); // attribute was deleted
            for (const k of Object.keys(y.attrs || {})) {
              const a = clean.find((z) => z.id === k);
              if (!a || !a.options.includes(y.attrs[k])) delete y.attrs[k]; // attribute or option was deleted
            }
          }
        });
      };
      openSheet('Shot attributes',
        h('p', { class: 'note' }, 'Make your own dropdowns. Name it (Light), then give it options (Soft, Hard). Saved attributes can be added to any shot from its + Attribute dropdown.'),
        draft.length ? h('div', { class: 'stack' }, draft.map(block)) : null,
        sec('New attribute', row(newName, btn('Add attribute', addAttr))),
        draft.length ? h('p', { class: 'note' }, 'Deleting an attribute removes it from every shot. Deleting an option clears it from the shots using it.') : null,
        sec(null, row(btn('Done', done, 'primary'), btn('Cancel', closeSheet, 'quiet'))));
      if (!focus) newName.focus();
    };
    draw();
  };
  const attrSel = (s, a) => {
    const cur = (s.attrs || {})[a.id] || '';
    const o = h('select', { class: 'field', 'aria-label': a.name, onchange: () => { if (o.value === '\u0000more') { o.value = cur; attrSheet(a.id); return; } filmField(sub.name, (x) => { const y = x.shots.find((z) => z.id === s.id); if (y) { (y.attrs ||= {})[a.id] = o.value; if (!o.value) delete y.attrs[a.id]; } }); } },
      [...(a.options.includes(cur) || !cur ? ['', ...a.options] : ['', ...a.options, cur]).map((v) => h('option', { value: v }, v || a.name)), h('option', { value: '\u0000more' }, '+ Add option…')]);
    o.value = cur;
    const off = h('button', { class: 'btn small quiet', type: 'button', title: 'Remove ' + a.name + ' from this shot', 'aria-label': 'Remove ' + a.name + ' from this shot', onclick: () => filmDo((c) => { const y = c.sub(sub.name).shots.find((z) => z.id === s.id); if (y) { y.attrIds = (y.attrIds || []).filter((k) => k !== a.id); if (y.attrs) delete y.attrs[a.id]; } }) }, '×');
    return h('span', { class: 'attr-pick' }, o, off);
  };
  /** Attributes this shot uses (older shots: any it already has a value for). */
  const attached = (s) => { const ids = new Set([...(s.attrIds || []), ...Object.keys(s.attrs || {})]); return attrs.filter((a) => ids.has(a.id)); };
  /** The "+ Attribute" dropdown: pick a saved attribute to add it to this shot, or make a new one. */
  const attrAdd = (s) => {
    const have = new Set(attached(s).map((a) => a.id));
    const free = attrs.filter((a) => !have.has(a.id));
    const o = h('select', { class: 'field', 'aria-label': 'Add an attribute to this shot', onchange: () => {
      const v = o.value;
      o.value = '';
      if (v === '\u0000new') attrSheet(null, s.id);
      else if (v === '\u0000edit') attrSheet(null, null);
      else if (v) filmDo((c) => { const y = c.sub(sub.name).shots.find((z) => z.id === s.id); if (y) y.attrIds = [...new Set([...(y.attrIds || []), v])]; });
    } },
    h('option', { value: '' }, '+ Attribute'),
    free.map((a) => h('option', { value: a.id }, a.name)),
    h('option', { value: '\u0000new' }, 'New attribute…'),
    attrs.length ? h('option', { value: '\u0000edit' }, 'Edit attributes…') : null);
    o.value = '';
    return o;
  };
  const add = (scene) => filmDo((c) => {
    c.meta.shots = (c.meta.shots || 0) + 1;
    const tag = { id: uid(), name: 'Shot', type: 'shot' };
    c.meta.tags.push(tag);
    c.sub(sub.name).shots.push({ id: uid(), tag: tag.id, scene: scene || '', size: '', move: '', desc: '', tags: [] });
  });
  const remove = (s) => filmDo((c) => {
    for (const x of c.film.sublogs) {
      if (x.kind === 'schedule') delete (c.sub(x.name).entries || {})[s.id];
      if ((x.kind === 'storyboard' || x.kind === 'shotlist') && c.sub(x.name).frames && !Array.isArray(c.sub(x.name).frames)) delete c.sub(x.name).frames[s.id];
    }
    const own = c.sub(sub.name);
    own.shots = own.shots.filter((y) => y.id !== s.id);
    dropTag(c, s.tag);
  }, 'Shot removed.');
  /** Notes and files from the brain dump (and any older moodboard) that carry this shot's tag. */
  const linkedTo = (tag) => {
    const out = [];
    for (const x of film.sublogs) {
      const d = x.data || {};
      if (x.kind === 'braindump') {
        for (const n of d.notes || []) if ((n.tags || []).includes(tag)) out.push({ sub: x, text: noteLabel(n), file: n.file ? { name: String(n.file).split('/').pop(), path: n.file } : null });
      } else if (x.kind === 'moodboard') {
        for (const f of x.files || []) if (((d.fileTags || {})[f.path] || []).includes(tag)) out.push({ sub: x, text: f.name, file: f });
      }
    }
    return out;
  };
  const addNote = (id) => filmDo((c) => { const y = c.sub(sub.name).shots.find((z) => z.id === id); if (y) (y.notes ||= []).push({ id: uid(), text: '' }); shotOpen.add(id); });
  const dropNote = (id, nid) => filmDo((c) => { const y = c.sub(sub.name).shots.find((z) => z.id === id); if (y) y.notes = (y.notes || []).filter((n) => n.id !== nid); }, 'Note removed.');
  const card = (s) => {
    const desc = h('textarea', { class: 'field', rows: 2, placeholder: 'What happens in this shot', 'aria-label': 'Short shot description' });
    desc.value = s.desc || '';
    desc.addEventListener('change', () => edit(s.id, 'desc')(desc.value));
    const where = h('select', { class: 'field', 'aria-label': 'Scene', onchange: () => filmDo((c) => { const y = c.sub(sub.name).shots.find((z) => z.id === s.id); if (y) y.scene = where.value; }) },
      h('option', { value: '' }, 'No scene'), scenes.map((x) => h('option', { value: x.tag }, sceneLabel(x))));
    where.value = inScene.has(s.scene) ? s.scene : '';
    const long = h('textarea', { class: 'field', rows: 4, placeholder: 'Longer description: blocking, lighting, lens, sound, anything the crew needs', 'aria-label': 'Longer shot description' });
    long.value = s.long || '';
    long.addEventListener('change', () => edit(s.id, 'long')(long.value));
    const linked = linkedTo(s.tag);
    const notes = s.notes || [];
    let onCanvas = linked.length;
    const infoText = () => [s.long ? 'description' : '', onCanvas ? onCanvas + ' linked' : '', notes.length ? notes.length + (notes.length === 1 ? ' note' : ' notes') : ''].filter(Boolean).join(' · ');
    const info = h('i', null, infoText());
    const slot = h('div', { class: 'shot-board' });
    const mountBoard = () => { if (!slot.firstChild) slot.append(makeBoard(film, { tag: s.tag, onCount: (c) => { onCanvas = c; info.textContent = infoText(); } })); };
    const noteEl = (n) => {
      const ta = h('textarea', { class: 'field', rows: 2, placeholder: 'Note about this shot', 'aria-label': 'Shot note' });
      ta.value = n.text || '';
      ta.addEventListener('change', () => filmField(sub.name, (x) => { const y = x.shots.find((z) => z.id === s.id); const m = y && (y.notes || []).find((z) => z.id === n.id); if (m) m.text = ta.value; }));
      return h('div', { class: 'shot-note' }, ta, h('button', { class: 'btn small quiet danger', type: 'button', onclick: () => dropNote(s.id, n.id) }, 'Remove'));
    };
    const more = h('details', { class: 'shot-more' },
      h('summary', null, 'Details', info),
      h('div', { class: 'shot-more-body' },
        h('label', { class: 'shot-lab' }, 'Longer description'), long,
        h('label', { class: 'shot-lab' }, 'Brain dump'),
        h('p', { class: 'note' }, 'Everything tagged ' + ((tagOf(film, s.tag) || {}).name || 'this shot') + ' in the brain dump. What you add here goes into the brain dump, tagged to this shot.'),
        slot,
        h('label', { class: 'shot-lab' }, 'Notes'),
        notes.length ? h('div', { class: 'stack' }, notes.map(noteEl)) : null,
        row(btn('Add note', () => addNote(s.id), 'small'))));
    if (shotOpen.has(s.id)) { more.open = true; mountBoard(); }
    more.addEventListener('toggle', () => { if (more.open) { shotOpen.add(s.id); mountBoard(); } else shotOpen.delete(s.id); });
    return h('section', { class: 'card film-card shot', 'data-id': s.id },
      h('div', { class: 'shot-head' }, grip('shot', s.id, 'Drag to reorder this shot'), tagChip(film, s.tag), sel(SHOT_SIZES, s.size, edit(s.id, 'size'), 'Size'), sel(SHOT_MOVES, s.move, edit(s.id, 'move'), 'Movement'), attached(s).map((a) => attrSel(s, a)), where, attrAdd(s),
        h('button', { class: 'btn small quiet danger', type: 'button', onclick: () => remove(s) }, 'Remove')),
      desc, more,
      tagRow(film, s.tags, setTags(sub.name, (x, ids) => { const y = x.shots.find((z) => z.id === s.id); if (y) y.tags = ids; }), 'Gear, extra cast, props'));
  };
  const group = (head, list, scene) => h('section', { class: 'scene-group', 'data-scene': scene }, head, list.length ? h('div', { class: 'stack' }, list.map(card)) : null, row(btn('Add shot', () => add(scene), 'small')));
  const loose = shots.filter((s) => !inScene.has(s.scene));
  return shotDnd(h('div', { class: 'shot-dnd' },
    !scenes.length ? h('p', { class: 'note' }, 'Shots are organized under the scenes of your script. Write a scene heading in a Script writer sub log and it appears here.') : null,
    scenes.map((sc) => group(h('h2', { class: 'scene-head' }, grip('scene', sc.tag, 'Drag to reorder this scene'), tagChip(film, sc.tag), h('span', null, sc.text || 'Untitled scene')), shots.filter((s) => s.scene === sc.tag), sc.tag)),
    loose.length || !scenes.length ? group(h('h2', { class: 'scene-head' }, h('span', null, 'Not in a scene yet')), loose, '') : null), sub, inScene);
}

/* ---------- Drag to reorder in the shot list ---------- */

let shotDrag = null; // { type: 'shot' | 'scene', id } while something is being dragged
const DRAG_TYPE = 'application/x-bujo-film'; // custom type, so a text field never accepts the drop as text

/** The handle that starts a drag. Only the handle is draggable, so text in the cards stays selectable. */
const grip = (type, id, label) => h('span', { class: 'grip', draggable: 'true', 'data-grip': type, 'data-id': id, title: label, 'aria-hidden': 'true' }, '⋮⋮');

/** Move a scene (its heading and the script lines under it) before or after another scene.
 *  Scenes live in the script, so this reorders the script; renumber() then renames scenes and shots. */
function moveScene(c, from, to, after) {
  const find = (tag) => {
    for (const s of c.film.sublogs) {
      if (s.kind !== 'script') continue;
      const blocks = c.sub(s.name).blocks || [];
      const i = blocks.findIndex((b) => b.kind === 'scene' && b.tag === tag);
      if (i >= 0) return { blocks, i };
    }
    return null;
  };
  const src = find(from);
  if (!src) return;
  let end = src.i + 1;
  while (end < src.blocks.length && src.blocks[end].kind !== 'scene') end++;
  const chunk = src.blocks.splice(src.i, end - src.i);
  const dst = find(to);
  if (!dst) { src.blocks.splice(src.i, 0, ...chunk); return; }
  let at = dst.i;
  if (after) { at++; while (at < dst.blocks.length && dst.blocks[at].kind !== 'scene') at++; }
  dst.blocks.splice(at, 0, ...chunk);
}

/** Wires drag and drop onto the shot list. Drop a shot on another shot (before or after it) or on a scene (the end of it);
 *  drop a scene on another scene (before or after it). */
function shotDnd(root, sub, inScene) {
  const clearDrop = () => root.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
  const below = (e, el) => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  const where = (e) => {
    if (!shotDrag) return null;
    const group = e.target.closest && e.target.closest('.scene-group');
    if (!group) return null;
    const card = e.target.closest('.shot');
    if (shotDrag.type === 'shot') {
      if (!card) return { el: group, scene: group.dataset.scene, into: true };
      return card.dataset.id === shotDrag.id ? null : { el: card, over: card.dataset.id, after: below(e, card) };
    }
    const tag = group.dataset.scene; // the "Not in a scene yet" group has no tag, so scenes cannot be dropped on it
    return tag && tag !== shotDrag.id ? { el: group, over: tag, after: below(e, group) } : null;
  };

  root.addEventListener('dragstart', (e) => {
    const g = e.target.closest && e.target.closest('[data-grip]');
    if (!g) return;
    shotDrag = { type: g.dataset.grip, id: g.dataset.id };
    const isShot = shotDrag.type === 'shot';
    const box = g.closest(isShot ? '.shot' : '.scene-group');
    const img = g.closest(isShot ? '.shot' : '.scene-head'); // a whole scene would make a huge drag image
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, shotDrag.id);
    if (img) e.dataTransfer.setDragImage(img, 12, 12);
    if (box) setTimeout(() => box.classList.add('dragging'), 0);
  });
  root.addEventListener('dragend', () => {
    shotDrag = null;
    clearDrop();
    root.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });
  root.addEventListener('dragover', (e) => {
    const t = where(e);
    clearDrop();
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.el.classList.add(t.into ? 'drop-into' : t.after ? 'drop-after' : 'drop-before');
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) clearDrop(); });
  root.addEventListener('drop', (e) => {
    const t = where(e);
    const d = shotDrag;
    shotDrag = null;
    clearDrop();
    if (!t) return;
    e.preventDefault();
    if (d.type === 'scene') return filmDo((c) => moveScene(c, d.id, t.over, t.after), 'Scene moved. Scenes and shots were renumbered.');
    filmDo((c) => {
      const x = c.sub(sub.name);
      const from = x.shots.findIndex((y) => y.id === d.id);
      if (from < 0) return;
      const [s] = x.shots.splice(from, 1);
      let at;
      if (t.into) {
        const sceneOf = (y) => (inScene.has(y.scene) ? y.scene : '');
        s.scene = t.scene || '';
        const last = x.shots.reduce((k, y, i) => (sceneOf(y) === s.scene ? i : k), -1);
        at = last < 0 ? x.shots.length : last + 1;
      } else {
        const o = x.shots.findIndex((y) => y.id === t.over);
        if (o < 0) { x.shots.splice(from, 0, s); return; }
        s.scene = inScene.has(x.shots[o].scene) ? x.shots[o].scene : '';
        at = t.after ? o + 1 : o;
      }
      x.shots.splice(at, 0, s);
    });
  });
  return root;
}

/* ---------- 5. Storyboard view: a frame for every shot, under its scene ---------- */

function storyboardBody(film, sub) {
  // Frames are stored in the shot list sub log. Frames made in an older storyboard sub log are still found there.
  const own = framesOf(sub.data);
  const legacy = subsOf(film, 'storyboard');
  const frameOf = (id) => {
    if (own[id]) return own[id];
    for (const l of legacy) { const f = framesOf(l.data)[id]; if (f) return { ...f, from: l.name }; }
    return {};
  };
  const scenes = sceneList(film);
  const shots = allShots(film);
  const setFrame = (id, patch, base) => (x) => { if (!x.frames || Array.isArray(x.frames)) x.frames = {}; x.frames[id] = { ...(x.frames[id] || base || {}), ...patch }; };
  const upload = async (sh, file, base) => {
    try {
      const r = await fetch(fileUrl(sub.name, file.name, '&noclobber=1'), { method: 'PUT', headers: { 'X-Bujo': '1' }, body: file });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Upload failed.');
      filmDo((c) => setFrame(sh.id, { file: data.path, from: '' }, base)(c.sub(sub.name)));
    } catch (e) { toast(e.message, true); }
  };
  const card = (sh) => {
    const f = frameOf(sh.id);
    const pick = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { if (pick.files[0]) upload(sh, pick.files[0], f); } });
    const cap = h('textarea', { class: 'field', rows: 2, placeholder: 'Caption, action, dialogue', 'aria-label': 'Frame caption' });
    cap.value = f.caption || '';
    cap.addEventListener('change', () => filmField(sub.name, setFrame(sh.id, { caption: cap.value }, f)));
    return h('section', { class: 'card film-card frame' },
      h('button', { class: 'frame-img', type: 'button', onclick: () => pick.click(), title: f.file ? 'Replace image' : 'Add an image' },
        f.file ? h('img', { src: fileUrl(f.from || sub.name, f.file), alt: 'Storyboard frame for ' + (tagOf(film, sh.tag) || {}).name }) : h('span', null, 'Add image')),
      pick,
      h('div', { class: 'frame-n' }, tagChip(film, sh.tag), h('span', null, [sh.size, sh.move, ...(sub.data.attrDefs || []).map((a) => (sh.attrs || {})[a.id])].filter(Boolean).join(', '))),
      sh.desc ? h('p', { class: 'note' }, sh.desc) : null,
      cap);
  };
  const inScene = new Set(scenes.map((x) => x.tag));
  const group = (head, list) => (list.length ? h('section', { class: 'scene-group' }, head, h('div', { class: 'frames' }, list.map(card))) : null);
  const loose = shots.filter((s) => !inScene.has(s.scene));
  return h('div', null,
    shots.length ? null : h('div', { class: 'card empty' }, 'No shots yet. Every shot in your shot list gets a storyboard frame here, under its scene.'),
    scenes.map((sc) => group(h('h2', { class: 'scene-head' }, tagChip(film, sc.tag), h('span', null, sc.text || 'Untitled scene')), shots.filter((s) => s.scene === sc.tag))),
    group(h('h2', { class: 'scene-head' }, h('span', null, 'Not in a scene yet')), loose));
}

/* ---------- 6. Breakdown: by scene, or by element ---------- */

let bdMode = 'scene';
let bdType = 'all';

function vBreakdown(film) {
  const items = filmItems(film);
  const shots = allShots(film);
  const modes = h('div', { class: 'row' }, [['scene', 'By scene'], ['element', 'By element']].map(([k, label]) => btn(label, () => { bdMode = k; render(); }, 'small' + (bdMode === k ? ' on' : ''))));
  if (bdMode === 'scene') {
    const scenes = sceneList(film);
    const cards = scenes.map((sc) => {
      const mine = items.filter((i) => i.tags.includes(sc.tag));
      const ids = [...new Set(mine.flatMap((i) => i.tags))];
      const rows = ELEMENTS.map((ty) => [ty, ids.filter((id) => (tagOf(film, id) || {}).type === ty)]).filter(([, l]) => l.length);
      const mine2 = shots.filter((s) => s.scene === sc.tag);
      return h('section', { class: 'card film-card bd' },
        h('div', { class: 'bd-head' }, h('div', { class: 'scene-head' }, tagChip(film, sc.tag), h('span', null, sc.text || 'Untitled scene'))),
        rows.length ? rows.map(([ty, l]) => h('div', { class: 'bd-row' }, h('span', { class: 'tg-label' }, PLURAL[ty]), h('div', { class: 'tgrow' }, l.map((id) => tagChip(film, id))))) : h('p', { class: 'note' }, 'No elements yet. Use Tag mode in the script, or add one here.'),
        mine2.length ? h('div', { class: 'bd-row' }, h('span', { class: 'tg-label' }, 'Shots'), h('div', { class: 'tgrow' }, mine2.map((s) => tagChip(film, s.tag)))) : null,
        h('div', null, h('button', { class: 'tg add', type: 'button', onclick: () => pickTags(film, sc.block.tags || [], setTags(sc.sub.name, (x, tags) => { const y = x.blocks.find((z) => z.id === sc.block.id); if (y) y.tags = tags; }), 'Elements in this scene') }, '+ Element')));
    });
    return h('div', null, modes, cards.length ? h('div', { class: 'bd-grid' }, cards) : h('div', { class: 'card empty' }, 'No scenes yet. Write scene headings in a Script writer sub log and each one gets a breakdown here.'));
  }
  const name = h('input', { class: 'field grow', type: 'text', placeholder: 'New element, e.g. Diner, Maya, Red jacket', maxlength: 80, 'aria-label': 'Element name' });
  const type = h('select', { class: 'field', 'aria-label': 'Element type' }, ELEMENTS.map((k) => h('option', { value: k }, TAG_TYPES[k])));
  type.value = ELEMENTS.includes(bdType) ? bdType : 'location';
  const add = () => {
    const n = name.value.trim();
    if (!n) return;
    filmDo((c) => { if (!c.meta.tags.some((t) => t.type === type.value && normTitle(t.name) === normTitle(n))) c.meta.tags.push({ id: uid(), name: n, type: type.value }); });
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const tabs = h('div', { class: 'row' }, ['all', ...ELEMENTS].map((k) => btn(k === 'all' ? 'All' : PLURAL[k], () => { bdType = k; render(); }, 'small' + (bdType === k ? ' on' : ''))));
  const list = film.meta.tags.filter((t) => ELEMENTS.includes(t.type) && (bdType === 'all' || t.type === bdType));
  const cards = list.map((t) => {
    const mine = items.filter((i) => i.tags.includes(t.id));
    const co = [...new Set(mine.flatMap((i) => i.tags))];
    const kind = (ty) => co.filter((x) => (tagOf(film, x) || {}).type === ty);
    const by = new Map();
    for (const i of mine) { if (!by.has(i.sub.name)) by.set(i.sub.name, []); by.get(i.sub.name).push(i); }
    return h('section', { class: 'card film-card bd' },
      h('div', { class: 'bd-head' }, tagChip(film, t.id), h('span', { class: 'note' }, TAG_TYPES[t.type] + '. ' + mine.length + (mine.length === 1 ? ' connection' : ' connections'))),
      h('div', { class: 'bd-row' }, h('span', { class: 'tg-label' }, 'Scenes'), kind('scene').length ? h('div', { class: 'tgrow' }, kind('scene').map((x) => tagChip(film, x))) : h('span', { class: 'note' }, 'Not in a scene yet.')),
      kind('shot').length ? h('div', { class: 'bd-row' }, h('span', { class: 'tg-label' }, 'Shots'), h('div', { class: 'tgrow' }, kind('shot').map((x) => tagChip(film, x)))) : null,
      [...by.values()].map((l) => h('div', { class: 'bd-row' }, h('span', { class: 'tg-label' }, l[0].sub.title),
        h('div', { class: 'bd-items' }, l.slice(0, 4).map((i) => h('span', null, i.text)), l.length > 4 ? h('span', { class: 'note' }, `+${l.length - 4} more`) : null))));
  });
  return h('div', null, modes, tabs,
    cards.length ? h('div', { class: 'bd-grid' }, cards) : h('div', { class: 'card empty' }, 'No elements here yet. Tag words in the script, or add one below.'),
    row(name, type, btn('Add element', add, 'primary')));
}

/* ---------- 7. Schedule ---------- */

function vSchedule(film, sub) {
  const shots = allShots(film);
  const entries = sub.data.entries || {};
  const set = (id, key, v, redraw) => {
    const fn = (x) => { const e = (x.entries ||= {})[id] || (x.entries[id] = {}); e[key] = v; if (!e.date && !e.time && !e.note) delete x.entries[id]; };
    if (redraw) return filmDo((c) => fn(c.sub(sub.name)));
    return filmField(sub.name, fn);
  };
  const days = new Map();
  for (const s of shots) { const e = entries[s.id]; if (e && e.date) { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(s); } }
  const dayCards = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => h('section', { class: 'card film-card day-card' },
    h('h3', null, fmt(parseDate(date), { weekday: 'long', day: 'numeric', month: 'long' }), h('span', { class: 'note' }, ` ${list.length} ${list.length === 1 ? 'shot' : 'shots'}`)),
    list.sort((a, b) => ((entries[a.id].time || '99') < (entries[b.id].time || '99') ? -1 : 1)).map((s) => h('div', { class: 'day-shot' },
      h('span', { class: 'time' }, entries[s.id].time || 'any time'), tagChip(film, s.tag), tagChip(film, s.scene), h('span', { class: 'day-desc' }, s.desc || ''),
      h('div', { class: 'tgrow' }, (s.tags || []).map((t) => tagChip(film, t)))))));
  const table = shots.map((s) => {
    const e = entries[s.id] || {};
    return h('div', { class: 'sched-row' },
      h('div', { class: 'sched-shot' }, tagChip(film, s.tag), tagChip(film, s.scene), h('span', null, s.desc || 'Untitled shot')),
      h('input', { class: 'field', type: 'date', value: e.date || '', 'aria-label': 'Day', onchange: (ev) => set(s.id, 'date', ev.target.value, true) }),
      h('input', { class: 'field', type: 'time', value: e.time || '', 'aria-label': 'Time', onchange: (ev) => set(s.id, 'time', ev.target.value, true) }),
      h('input', { class: 'field', type: 'text', value: e.note || '', placeholder: 'Note', maxlength: 200, 'aria-label': 'Note', onchange: (ev) => set(s.id, 'note', ev.target.value, false) }));
  });
  return h('div', null,
    dayCards.length ? h('div', { class: 'stack' }, dayCards) : null,
    h('h2', { class: 'block-title' }, 'All shots'),
    shots.length ? h('div', { class: 'card sched' }, table) : h('div', { class: 'card empty' }, 'No shots yet. Add them in a Shot list sub log, then schedule them here.'));
}
