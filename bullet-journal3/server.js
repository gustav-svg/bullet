#!/usr/bin/env node
/*
 * Bullet Journal: local server.
 * No dependencies. Needs Node 18 or newer.
 *
 *   node server.js                      -> uses ~/BulletJournal
 *   node server.js "D:\Notes\Journal"   -> uses that folder
 *   node server.js --port 4000          -> different port
 *
 * Everything is stored as plain files in the journal folder:
 *
 *   Daily/2026-10-18.md
 *   Weekly/2026-W42.md
 *   Monthly/2026-10.md
 *   Custom Logs/<log name>/log.md       <- bullets of that log
 *   Custom Logs/<log name>/anything     <- any file you drop in shows up in the app
 *   Custom Logs/<log>/<sub log>/log.md  <- a sub log: a folder inside a log that has its own log.md
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

let ROOT = process.env.BUJO_DIR || '';
let PORT = parseInt(process.env.PORT, 10) || 3000;
let OPEN_BROWSER = false;
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port' || a[i] === '-p') PORT = parseInt(a[++i], 10) || PORT;
    else if (a[i] === '--open') OPEN_BROWSER = true;
    else if (!a[i].startsWith('-')) ROOT = a[i];
  }
}
if (!ROOT) ROOT = path.join(os.homedir(), 'BulletJournal');
ROOT = path.resolve(ROOT.replace(/^~(?=$|[\\/])/, os.homedir()));

const PUBLIC = path.join(__dirname, 'public');
const DIRS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const CUSTOM = 'Custom Logs';
const LOG_FILE = 'log.md';
const TRASH = '.trash';
const PROJECT_FILE = '.project.json'; // marks a log as a film project (tags live in here)
const SUB_FILE = '.sublog.json'; // marks a sub log of a film project and holds its content
const FILM_KINDS = ['braindump', 'moodboard', 'script', 'shotlist', 'storyboard', 'breakdown', 'schedule'];
const TAG_TYPES = ['shot', 'scene', 'cast', 'location', 'prop', 'costume', 'vehicle', 'other'];
const MAX_LOG_DEPTH = 3; // a log, a sub log, a sub log of that
const MAX_DEPTH = 2; // a bullet, its subtask, and that subtask's subtask
const ID_RE = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const safeStat = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Turn a user-typed log name into a safe folder name. */
function cleanName(raw) {
  let n = String(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n) throw new HttpError(400, 'Give the log a name.');
  if (n.length > 80) throw new HttpError(400, 'That name is too long (80 characters max).');
  return n;
}

const okPart = (p) => !!p && p !== '.' && p !== '..' && !p.startsWith('.') && p.length <= 200 && !/[\\\u0000]/.test(p);

/** Validate a log path coming from the browser: "Groceries" or "Groceries/Costco". */
function logPath(raw) {
  const s = String(raw || '');
  const parts = s.split('/');
  if (!s || parts.length > MAX_LOG_DEPTH || !parts.every(okPart)) throw new HttpError(400, 'Invalid log name.');
  return parts.join('/');
}

const logDir = (name) => path.join(ROOT, CUSTOM, ...logPath(name).split('/'));

function pageFile(kind, id) {
  if (kind === 'custom') return path.join(logDir(id), LOG_FILE);
  if (!DIRS[kind] || !ID_RE[kind].test(String(id))) throw new HttpError(400, 'Invalid page.');
  return path.join(ROOT, DIRS[kind], id + '.md');
}

function headerFor(kind, id) {
  try {
    if (kind === 'daily') {
      const [y, m, d] = id.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
    }
    if (kind === 'weekly') return `Week ${Number(id.slice(6))}, ${id.slice(0, 4)}`;
    if (kind === 'monthly') {
      const [y, m] = id.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    }
  } catch { /* fall through */ }
  if (kind === 'custom') return String(id).split('/').pop();
  return id;
}

/* ------------------------------------------------------------------ */
/* Bullet format                                                       */
/*                                                                     */
/*   - [ ] Task          open task                                     */
/*   - [x] Task          done                                          */
/*   - [>] Task          migrated (moved on to another day/week/month) */
/*   - [<] Task          scheduled                                     */
/*   - [-] Task          cancelled                                     */
/*   - (o) Event                                                       */
/*   - Note                                                            */
/*                                                                     */
/* Indent a bullet by two spaces under another one and it is a         */
/* subtask (or a sub note) of that bullet, up to three levels deep.    */
/* ------------------------------------------------------------------ */

const RE_TASK = /^(\s*)[-*+]\s+\[([ xX><\-])\]\s+(\S.*?)\s*$/;
const RE_EVENT = /^(\s*)[-*+]\s+\([oO]\)\s+(\S.*?)\s*$/;
const RE_NOTE = /^(\s*)[-*+]\s+(\S.*?)\s*$/;
const STATUS_FROM = { ' ': 'open', x: 'done', X: 'done', '>': 'migrated', '<': 'scheduled', '-': 'cancelled' };
const STATUS_CH = { open: ' ', done: 'x', migrated: '>', scheduled: '<', cancelled: '-' };
const TYPES = ['task', 'event', 'note'];
const MOVED = new Set(['migrated', 'scheduled']);

function parseLine(line, idx) {
  let m;
  if ((m = RE_TASK.exec(line))) return { idx, raw: line, indent: m[1], type: 'task', status: STATUS_FROM[m[2]], title: m[3] };
  if ((m = RE_EVENT.exec(line))) return { idx, raw: line, indent: m[1], type: 'event', status: 'open', title: m[2] };
  if ((m = RE_NOTE.exec(line))) return { idx, raw: line, indent: m[1], type: 'note', status: 'open', title: m[2] };
  return null;
}

function buildLine(b) {
  const indent = b.indent || '';
  if (b.type === 'task') return `${indent}- [${STATUS_CH[b.status] || ' '}] ${b.title}`;
  if (b.type === 'event') return `${indent}- (o) ${b.title}`;
  return `${indent}- ${b.title}`;
}

const normKey = (t) => oneLine(t).toLowerCase();

/** Width of leading whitespace, a tab counting as two spaces. */
const widthOf = (s) => String(s || '').replace(/\t/g, '  ').length;

/**
 * The bullets of a page as a tree. Each node knows its parent (a node number, -1 for none),
 * its depth, and `end`, the last node inside it, so a bullet and everything nested under it
 * is nodes[n] .. nodes[end]. Lines that are not bullets are skipped and left alone.
 */
function analyzeLines(lines) {
  const nodes = [];
  const stack = [];
  lines.forEach((l, i) => {
    const b = parseLine(l, i);
    if (!b) return;
    const w = widthOf(b.indent);
    while (stack.length && nodes[stack[stack.length - 1]].w >= w) stack.pop();
    const n = nodes.length;
    nodes.push({ n, idx: i, b, w, parent: stack.length ? stack[stack.length - 1] : -1, depth: stack.length, end: n });
    stack.push(n);
  });
  for (let n = nodes.length - 1; n >= 0; n--) {
    const p = nodes[n].parent;
    if (p >= 0 && nodes[p].end < nodes[n].end) nodes[p].end = nodes[n].end;
  }
  return nodes;
}

/** What travels with a bullet when it is linked or migrated: its subtasks, minus dead ones. */
function liveSubtree(nodes, a) {
  const out = [];
  for (let n = a.n + 1; n <= a.end; n++) {
    const x = nodes[n];
    if (x.b.type === 'task' && (x.b.status === 'cancelled' || MOVED.has(x.b.status))) { n = x.end; continue; }
    out.push({ type: x.b.type, title: x.b.title, rel: x.depth - a.depth });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* File I/O                                                            */
/* ------------------------------------------------------------------ */

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function writeLines(file, lines) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, file);
  idxCache.sig = null;
}

function readJsonFile(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function writeJsonFile(file, obj) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  fs.renameSync(tmp, file);
  idxCache.sig = null;
}

/* ------------------------------------------------------------------ */
/* Scanning the journal folder                                         */
/* ------------------------------------------------------------------ */

const isDir = (p) => { const s = safeStat(p); return !!s && s.isDirectory(); };

/**
 * Logs directly inside `rel` ('' means Custom Logs). Any folder in Custom Logs is a log.
 * Inside a log, a folder only counts as a sub log once it holds its own log.md,
 * so ordinary file folders such as receipts/ stay file folders.
 */
function childLogs(rel) {
  const dir = path.join(ROOT, CUSTOM, ...(rel ? rel.split('/') : []));
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return []; }
  return ents
    .filter((n) => okPart(n) && isDir(path.join(dir, n)) && (!rel || safeStat(path.join(dir, n, LOG_FILE))))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .sort((a, b) => {
      // In a film project the sub logs follow the order of the kinds: brain dump first, schedule last.
      if (!rel || rel.includes('/') || !safeStat(path.join(dir, PROJECT_FILE))) return 0;
      const k = (n) => { const d = readJsonFile(path.join(dir, n, SUB_FILE)); const i = d ? FILM_KINDS.indexOf(d.kind) : -1; return i < 0 ? 99 : i; };
      return k(a) - k(b);
    });
}

/** Every log and sub log as a path like "Groceries/Costco", parents before their children. */
function listLogPaths() {
  const out = [];
  (function rec(rel, depth) {
    for (const n of childLogs(rel)) {
      const p = rel ? rel + '/' + n : n;
      out.push(p);
      if (depth + 1 < MAX_LOG_DEPTH) rec(p, depth + 1);
    }
  })('', 0);
  return out;
}

/** Every file that holds bullets. */
function bulletFiles() {
  const out = [];
  for (const kind of Object.keys(DIRS)) {
    const dir = path.join(ROOT, DIRS[kind]);
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch { /* none yet */ }
    for (const f of ents) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue;
      const id = f.slice(0, -3);
      if (ID_RE[kind].test(id)) out.push({ kind, id, file: path.join(dir, f) });
    }
  }
  for (const name of listLogPaths()) {
    out.push({ kind: 'custom', id: name, file: path.join(ROOT, CUSTOM, ...name.split('/'), LOG_FILE) });
  }
  return out;
}

function listFiles(name) {
  const base = logDir(name);
  const out = [];
  (function rec(dir, rel, depth) {
    let ents;
    try { ents = fs.readdirSync(dir); } catch { return; }
    for (const n of ents) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      const st = safeStat(full);
      if (!st) continue;
      const r = rel ? rel + '/' + n : n;
      if (st.isDirectory()) {
        if (depth === 0 && safeStat(path.join(full, LOG_FILE))) continue; // a sub log keeps its own files
        if (depth < 4) rec(full, r, depth + 1);
      } else if (r !== LOG_FILE) {
        out.push({ path: r, name: n, size: st.size, mtime: st.mtimeMs });
      }
    }
  })(base, '', 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** A fingerprint of the whole folder. Changes when anything is added, removed or edited. */
function computeSig() {
  const h = crypto.createHash('md5');
  (function rec(dir, rel, depth) {
    let ents;
    try { ents = fs.readdirSync(dir); } catch { return; }
    ents.sort();
    for (const n of ents) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      const st = safeStat(full);
      if (!st) continue;
      const r = rel ? rel + '/' + n : n;
      if (st.isDirectory()) {
        h.update(r + '/\n');
        if (depth < 5) rec(full, r, depth + 1);
      } else {
        h.update(`${r}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      }
    }
  })(ROOT, '', 0);
  return h.digest('hex');
}

/** key -> places where a task with that (normalised) name lives */
function buildIndex() {
  const map = new Map();
  for (const f of bulletFiles()) {
    readLines(f.file).forEach((l, i) => {
      const b = parseLine(l, i);
      if (!b || b.type !== 'task') return;
      const k = normKey(b.title);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ kind: f.kind, id: f.id, idx: i, status: b.status });
    });
  }
  return map;
}

let idxCache = { sig: null, map: null };
function getIndex() {
  const sig = computeSig();
  if (idxCache.sig !== sig) idxCache = { sig, map: buildIndex() };
  return idxCache.map;
}

/* ------------------------------------------------------------------ */
/* Reading pages                                                       */
/* ------------------------------------------------------------------ */

function pageData(kind, id, index) {
  const file = pageFile(kind, id);
  if (kind === 'custom' && !safeStat(path.dirname(file))) throw new HttpError(404, 'That log does not exist.');
  const idx = index || getIndex();
  const nodes = analyzeLines(readLines(file));
  const bullets = nodes.map((x) => {
    const b = x.b;
    const o = {
      idx: x.idx,
      raw: b.raw,
      depth: x.depth,
      parent: x.parent,
      type: b.type,
      status: b.status,
      title: b.title,
      kids: 0, // direct sub-bullets
      nested: x.end - x.n, // everything below it
      subs: { done: 0, total: 0 }, // progress over the tasks below it
    };
    if (b.type === 'task') {
      const seen = new Set();
      o.also = [];
      for (const p of idx.get(normKey(b.title)) || []) {
        const k = p.kind + '\u0000' + p.id;
        if ((p.kind === kind && p.id === id) || seen.has(k)) continue;
        seen.add(k);
        o.also.push({ kind: p.kind, id: p.id });
      }
    }
    return o;
  });
  for (const x of nodes) {
    for (let m = x.n + 1; m <= x.end; m++) {
      const c = nodes[m];
      if (c.parent === x.n) bullets[x.n].kids++;
      if (c.b.type === 'task' && (c.b.status === 'open' || c.b.status === 'done')) {
        bullets[x.n].subs.total++;
        if (c.b.status === 'done') bullets[x.n].subs.done++;
      }
    }
  }
  // A subtask needs no chip for a place its parent already shows.
  const parentAlso = bullets.map((o) => o.also);
  for (const o of bullets) {
    const up = o.parent >= 0 ? parentAlso[o.parent] : null;
    if (!o.also || !o.also.length || !up || !up.length) continue;
    const have = new Set(up.map((p) => p.kind + '\u0000' + p.id));
    o.also = o.also.filter((p) => !have.has(p.kind + '\u0000' + p.id));
  }
  return { kind, id, bullets };
}

/* ------------------------------------------------------------------ */
/* Film projects: a log with .project.json. Its sub logs have a kind   */
/* (brain dump, moodboard, script, ...) and keep their content in      */
/* .sublog.json. Tags are shared by the whole project.                 */
/* ------------------------------------------------------------------ */

const filmMeta = (project) => readJsonFile(path.join(logDir(project), PROJECT_FILE));

function filmData(project) {
  const meta = filmMeta(project);
  if (!meta) return null;
  const sublogs = [];
  for (const n of childLogs(project)) {
    const name = project + '/' + n;
    const data = readJsonFile(path.join(logDir(name), SUB_FILE));
    if (data && FILM_KINDS.includes(data.kind)) sublogs.push({ name, title: n, kind: data.kind, data, files: listFiles(name) });
  }
  return { meta, sublogs };
}

const newSubData = (kind) => ({
  kind,
  ...({ braindump: { notes: [] }, moodboard: { fileTags: {} }, script: { blocks: [] }, shotlist: { shots: [] },
    storyboard: { frames: {} }, breakdown: {}, schedule: { entries: {} } })[kind],
});

function saveFilmMeta(body) {
  const project = logPath(body.project).split('/')[0];
  if (!filmMeta(project)) throw new HttpError(404, 'That is not a film project.');
  const m = body.meta;
  if (!m || !Array.isArray(m.tags) || m.tags.length > 3000) throw new HttpError(400, 'Invalid tags.');
  const seen = new Set();
  const tags = m.tags.map((t) => {
    const id = String(t && t.id || '').slice(0, 30);
    const name = oneLine(t && t.name).slice(0, 80);
    if (!id || !name || seen.has(id) || !TAG_TYPES.includes(t.type)) throw new HttpError(400, 'Invalid tag.');
    seen.add(id);
    return { id, name, type: t.type };
  });
  writeJsonFile(path.join(logDir(project), PROJECT_FILE), { type: 'film', tags, shots: Math.max(0, parseInt(m.shots, 10) || 0) });
  return { ok: true };
}

function saveFilmData(body) {
  const name = logPath(body.log);
  const file = path.join(logDir(name), SUB_FILE);
  const old = readJsonFile(file);
  const d = body.data;
  if (!old) throw new HttpError(404, 'That is not a film sub log.');
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, 'Invalid data.');
  writeJsonFile(file, { ...d, kind: old.kind });
  return { ok: true };
}

function pageResponse(kind, id) {
  const data = pageData(kind, id);
  if (kind === 'custom') {
    data.files = listFiles(id);
    data.folder = logDir(id);
    const film = filmData(logPath(id).split('/')[0]);
    if (film) data.film = film;
  }
  return data;
}

function dayIds(from, to) {
  if (!ID_RE.daily.test(from || '') || !ID_RE.daily.test(to || '')) throw new HttpError(400, 'Invalid date range.');
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  const n = Math.round((b - a) / 864e5) + 1;
  if (n < 1 || n > 62) throw new HttpError(400, 'Date range too large.');
  return Array.from({ length: n }, (_, i) => new Date(a + i * 864e5).toISOString().slice(0, 10));
}

function rangePages(from, to) {
  const idx = getIndex();
  return dayIds(from, to).map((id) => pageData('daily', id, idx));
}

function logsList() {
  return listLogPaths().map((name) => {
    let open = 0;
    let total = 0;
    for (const l of readLines(path.join(ROOT, CUSTOM, ...name.split('/'), LOG_FILE))) {
      const b = parseLine(l);
      if (!b) continue;
      total++;
      if (b.type === 'task' && b.status === 'open') open++;
    }
    const parts = name.split('/');
    const sub = readJsonFile(path.join(ROOT, CUSTOM, ...parts, SUB_FILE));
    const film = parts.length === 1 && !!readJsonFile(path.join(ROOT, CUSTOM, ...parts, PROJECT_FILE));
    return { name, title: parts[parts.length - 1], parent: parts.slice(0, -1).join('/'), depth: parts.length - 1, open, total, files: listFiles(name).length, film, kind: sub && FILM_KINDS.includes(sub.kind) ? sub.kind : null };
  });
}

function carryOver(date) {
  if (!ID_RE.daily.test(date || '')) throw new HttpError(400, 'Invalid date.');
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const latest = new Map();
  for (let k = 30; k >= 1; k--) {
    const id = new Date(t - k * 864e5).toISOString().slice(0, 10);
    const nodes = analyzeLines(readLines(pageFile('daily', id)));
    for (const x of nodes) {
      if (x.b.type !== 'task') continue;
      // A subtask of an open task travels with that task, so it is not offered on its own.
      let under = false;
      for (let p = x.parent; p >= 0 && !under; p = nodes[p].parent) under = nodes[p].b.type === 'task' && nodes[p].b.status === 'open';
      latest.set(normKey(x.b.title), { title: x.b.title, status: x.b.status, under, from: { kind: 'daily', id, idx: x.idx, raw: x.b.raw } });
    }
  }
  const here = new Set();
  for (const l of readLines(pageFile('daily', date))) {
    const b = parseLine(l);
    if (b && b.type === 'task') here.add(normKey(b.title));
  }
  return [...latest.entries()]
    .filter(([k, v]) => v.status === 'open' && !v.under && !here.has(k))
    .map(([, v]) => ({ title: v.title, from: v.from }))
    .sort((a, b) => a.from.id.localeCompare(b.from.id));
}

/* ------------------------------------------------------------------ */
/* Changing bullets (this is where same-name tasks stay in sync)       */
/* ------------------------------------------------------------------ */

function locate(lines, idx, raw) {
  if (lines[idx] === raw) return idx;
  const j = lines.indexOf(raw);
  if (j >= 0) return j;
  throw new HttpError(409, 'That line changed on disk. The page was refreshed.');
}

/** Apply `mutate` to every task with this key in every log. mutate returns a new line or null. */
function applyEverywhere(key, mutate) {
  for (const f of bulletFiles()) {
    const lines = readLines(f.file);
    let changed = false;
    lines.forEach((l, i) => {
      const b = parseLine(l, i);
      if (!b || b.type !== 'task' || normKey(b.title) !== key) return;
      const nl = mutate(b);
      if (nl != null && nl !== l) {
        lines[i] = nl;
        changed = true;
      }
    });
    if (changed) writeLines(f.file, lines);
  }
}

/** Status a new copy of this task should start with (so it matches the other copies). */
function adoptStatus(key) {
  for (const f of bulletFiles()) {
    for (const l of readLines(f.file)) {
      const b = parseLine(l);
      if (b && b.type === 'task' && normKey(b.title) === key && !MOVED.has(b.status)) return b.status;
    }
  }
  return 'open';
}

/**
 * Put a bullet on a page. `subtree` (see liveSubtree) brings its subtasks along: any that are
 * missing are added under it, whether the bullet was new there or already existed.
 */
function addToPage(kind, id, { type, title, subtree = [] }) {
  const file = pageFile(kind, id);
  if (kind === 'custom' && !safeStat(path.dirname(file))) throw new HttpError(404, 'That log does not exist.');
  const lines = readLines(file);
  const key = normKey(title);
  const matches = (b) => b && b.type === type && normKey(b.title) === key && !(type === 'task' && MOVED.has(b.status));
  let at = lines.findIndex((l) => matches(parseLine(l)));
  const added = at < 0;
  if (added) {
    const status = type === 'task' ? adoptStatus(key) : 'open';
    if (!lines.length) lines.push('# ' + headerFor(kind, id), '');
    lines.push(buildLine({ type, status, title }));
    at = lines.length - 1;
  }
  let merged = 0;
  if (subtree.length) {
    const nodes = analyzeLines(lines);
    const root = nodes.find((x) => x.idx === at);
    const have = new Set(nodes.slice(root.n + 1, root.end + 1).map((x) => x.b.type + '\u0000' + normKey(x.b.title)));
    let last = nodes[root.end].idx;
    for (const it of subtree) {
      const k = it.type + '\u0000' + normKey(it.title);
      if (have.has(k)) continue;
      have.add(k);
      const status = it.type === 'task' ? adoptStatus(normKey(it.title)) : 'open';
      lines.splice(++last, 0, buildLine({ indent: root.b.indent + '  '.repeat(it.rel), type: it.type, status, title: it.title }));
      merged++;
    }
  }
  if (added || merged) writeLines(file, lines);
  return { kind, id, added, merged };
}

/** Add a subtask (or sub note or event) under a bullet. */
function addChild(body) {
  const file = pageFile(body.kind, body.id);
  const lines = readLines(file);
  const i = locate(lines, body.idx, body.raw);
  const nodes = analyzeLines(lines);
  const a = nodes.find((x) => x.idx === i);
  if (!a) throw new HttpError(409, 'That line is not a bullet any more.');
  if (a.depth >= MAX_DEPTH) throw new HttpError(400, 'Subtasks can only go three levels deep.');
  const text = oneLine(body.text).slice(0, 500);
  if (!text) throw new HttpError(400, 'Nothing to add.');
  const type = body.type || 'task';
  if (!TYPES.includes(type)) throw new HttpError(400, 'Invalid bullet type.');
  const key = normKey(text);
  const below = nodes.slice(a.n + 1, a.end + 1).filter((x) => x.depth === a.depth + 1);
  if (below.some((x) => x.b.type === type && normKey(x.b.title) === key)) return { added: false };
  const indent = below.length ? below[0].b.indent : a.b.indent + (a.b.indent.includes('\t') ? '\t' : '  ');
  const status = type === 'task' ? adoptStatus(key) : 'open';
  lines.splice(nodes[a.end].idx + 1, 0, buildLine({ indent, type, status, title: text }));
  writeLines(file, lines);
  return { added: true };
}

/** Nest a bullet under the one above it ("in"), or move it out to its parent's level ("out"). */
function indentBullet(body) {
  const file = pageFile(body.kind, body.id);
  const lines = readLines(file);
  const i = locate(lines, body.idx, body.raw);
  let nodes = analyzeLines(lines);
  const a = nodes.find((x) => x.idx === i);
  if (!a) throw new HttpError(409, 'That line is not a bullet any more.');
  const span = nodes.slice(a.n, a.end + 1);

  if (body.dir === 'in') {
    let m = a.n - 1;
    while (m >= 0 && nodes[m].depth > a.depth) m--;
    if (m < 0 || nodes[m].depth !== a.depth) throw new HttpError(400, 'There is no bullet above it to nest it under.');
    const deepest = Math.max(...span.map((x) => x.depth)) - a.depth;
    if (a.depth + 1 + deepest > MAX_DEPTH) throw new HttpError(400, 'Subtasks can only go three levels deep.');
    const shift = Math.max(2, nodes[m].w - a.w + 2);
    for (const x of span) lines[x.idx] = ' '.repeat(shift) + lines[x.idx];
    writeLines(file, lines);
    return { ok: true };
  }
  if (body.dir === 'out') {
    if (a.parent < 0) throw new HttpError(400, 'It is not nested under anything.');
    const parentIdx = nodes[a.parent].idx;
    const cut = nodes[a.parent].w - a.w;
    const moved = span.map((x) => ' '.repeat(Math.max(0, x.w + cut)) + lines[x.idx].trimStart());
    for (const x of [...span].reverse()) lines.splice(x.idx, 1);
    nodes = analyzeLines(lines);
    const p = nodes.find((x) => x.idx === parentIdx);
    lines.splice(nodes[p.end].idx + 1, 0, ...moved);
    writeLines(file, lines);
    return { ok: true };
  }
  throw new HttpError(400, 'Unknown direction.');
}

function checkTarget(t) {
  if (!t || typeof t !== 'object') throw new HttpError(400, 'Missing target.');
  pageFile(t.kind, t.id); // validates
  return { kind: t.kind, id: String(t.id) };
}

function addBullets(body) {
  const text = oneLine(body.text).slice(0, 500);
  if (!text) throw new HttpError(400, 'Nothing to add.');
  const type = body.type || 'task';
  if (!TYPES.includes(type)) throw new HttpError(400, 'Invalid bullet type.');
  const targets = (Array.isArray(body.targets) ? body.targets : []).slice(0, 12).map(checkTarget);
  if (!targets.length) throw new HttpError(400, 'Missing target.');
  const seen = new Set();
  const results = [];
  for (const t of targets) {
    const k = t.kind + '\u0000' + t.id;
    if (seen.has(k)) continue;
    seen.add(k);
    results.push(addToPage(t.kind, t.id, { type, title: text }));
  }
  return { results };
}

function updateBullet(body) {
  const file = pageFile(body.kind, body.id);
  const lines = readLines(file);
  const i = locate(lines, body.idx, body.raw);
  const old = parseLine(lines[i], i);
  if (!old) throw new HttpError(409, 'That line is not a bullet any more.');
  const nb = { indent: old.indent, type: old.type, status: old.status, title: old.title };
  let rename = null;
  let newStatus = null;

  if (typeof body.title === 'string') {
    const t = oneLine(body.title).slice(0, 500);
    if (!t) throw new HttpError(400, 'A bullet cannot be empty.');
    if (t !== old.title) {
      nb.title = t;
      if (old.type === 'task') rename = { from: normKey(old.title), to: t };
    }
  }
  if (body.type && body.type !== old.type) {
    if (!TYPES.includes(body.type)) throw new HttpError(400, 'Invalid bullet type.');
    nb.type = body.type;
    nb.status = body.type === 'task' ? adoptStatus(normKey(nb.title)) : 'open';
  }
  if (body.status && nb.type === 'task') {
    if (!(body.status in STATUS_CH)) throw new HttpError(400, 'Invalid status.');
    let s = body.status;
    // Bringing a moved-on bullet back: follow whatever the other copies say.
    if (MOVED.has(old.status) && s === 'open') s = adoptStatus(normKey(nb.title));
    if (s !== nb.status) newStatus = s;
    nb.status = s;
  }

  lines[i] = buildLine(nb);
  writeLines(file, lines);

  if (rename) {
    // Same task = same name, so a rename follows the task everywhere.
    applyEverywhere(rename.from, (b) => buildLine({ ...b, title: rename.to }));
  }
  if (newStatus && nb.type === 'task') {
    // Done / open / cancelled follows the task everywhere (except copies already moved on).
    const s = newStatus;
    applyEverywhere(normKey(nb.title), (b) => (MOVED.has(b.status) || b.status === s ? null : buildLine({ ...b, status: s })));
  }
  return { ok: true };
}

function deleteBullet(body) {
  const file = pageFile(body.kind, body.id);
  const lines = readLines(file);
  const i = locate(lines, body.idx, body.raw);
  const nodes = analyzeLines(lines);
  const a = nodes.find((x) => x.idx === i);
  // Removing a bullet removes what is nested under it too.
  const drop = a ? nodes.slice(a.n, a.end + 1).map((x) => x.idx) : [i];
  for (const k of drop.reverse()) lines.splice(k, 1);
  writeLines(file, lines);
  return { ok: true };
}

function linkBullet(body) {
  const lines = readLines(pageFile(body.kind, body.id));
  const i = locate(lines, body.idx, body.raw);
  const nodes = analyzeLines(lines);
  const a = nodes.find((x) => x.idx === i);
  if (!a) throw new HttpError(409, 'That line is not a bullet any more.');
  const t = checkTarget(body.target);
  if (t.kind === body.kind && t.id === body.id) throw new HttpError(400, 'It is already here.');
  return addToPage(t.kind, t.id, { type: a.b.type, title: a.b.title, subtree: liveSubtree(nodes, a) });
}

function migrateBullet(body) {
  const file = pageFile(body.kind, body.id);
  const lines = readLines(file);
  const i = locate(lines, body.idx, body.raw);
  const nodes = analyzeLines(lines);
  const a = nodes.find((x) => x.idx === i);
  if (!a || a.b.type !== 'task') throw new HttpError(400, 'Only tasks can be migrated.');
  const t = checkTarget(body.target);
  if (t.kind === body.kind && t.id === body.id) throw new HttpError(400, 'Pick a different day, week or month.');
  const subtree = liveSubtree(nodes, a);
  // The task and its unfinished subtasks move on together.
  lines[i] = buildLine({ ...a.b, status: 'migrated' });
  for (let n = a.n + 1; n <= a.end; n++) {
    const x = nodes[n];
    if (x.b.type === 'task' && x.b.status === 'open') lines[x.idx] = buildLine({ ...x.b, status: 'migrated' });
  }
  writeLines(file, lines);
  return addToPage(t.kind, t.id, { type: 'task', title: a.b.title, subtree });
}

/* ------------------------------------------------------------------ */
/* Custom logs (folders)                                               */
/* ------------------------------------------------------------------ */

function createLog(body) {
  const name = cleanName(body.name);
  const parent = body.parent ? logPath(body.parent) : '';
  if (parent) {
    if (!isDir(logDir(parent))) throw new HttpError(404, 'That log does not exist.');
    if (parent.split('/').length >= MAX_LOG_DEPTH) throw new HttpError(400, 'Sub logs can only go three levels deep.');
  }
  if (body.kind) {
    if (!parent || parent.includes('/') || !filmMeta(parent)) throw new HttpError(400, 'Only a film project can have these sub logs.');
    if (!FILM_KINDS.includes(body.kind)) throw new HttpError(400, 'Unknown sub log type.');
  }
  const base = parent ? logDir(parent) : path.join(ROOT, CUSTOM);
  fs.mkdirSync(base, { recursive: true });
  if (fs.readdirSync(base).some((n) => n.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, parent ? 'That log already has a folder or file with that name.' : 'A log with that name already exists.');
  }
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  writeLines(path.join(dir, LOG_FILE), ['# ' + name, '']);
  if (!parent && body.type === 'film') writeJsonFile(path.join(dir, PROJECT_FILE), { type: 'film', tags: [], shots: 0 });
  if (body.kind) writeJsonFile(path.join(dir, SUB_FILE), newSubData(body.kind));
  return { name: parent ? parent + '/' + name : name };
}

function renameLog(body) {
  const from = logPath(body.name);
  const to = cleanName(body.to);
  if (!isDir(logDir(from))) throw new HttpError(404, 'That log does not exist.');
  const parts = from.split('/');
  const oldBase = parts.pop();
  const parentDir = path.join(ROOT, CUSTOM, ...parts);
  if (fs.readdirSync(parentDir).some((n) => n !== oldBase && n.toLowerCase() === to.toLowerCase())) {
    throw new HttpError(409, 'A log with that name already exists.');
  }
  if (oldBase !== to) fs.renameSync(path.join(parentDir, oldBase), path.join(parentDir, to));
  const file = path.join(parentDir, to, LOG_FILE);
  const lines = readLines(file);
  if (lines.length && lines[0] === '# ' + oldBase) {
    lines[0] = '# ' + to;
    writeLines(file, lines);
  }
  idxCache.sig = null;
  return { name: [...parts, to].join('/') };
}

function moveToTrash(full, label) {
  const dir = path.join(ROOT, TRASH);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}-${label}`.replace(/[\\/:*?"<>|]/g, '_'));
  fs.renameSync(full, dest);
  idxCache.sig = null;
}

function deleteLog(body) {
  const name = logPath(body.name);
  if (!isDir(logDir(name))) throw new HttpError(404, 'That log does not exist.');
  moveToTrash(logDir(name), name.split('/').pop());
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Files inside a custom log folder                                    */
/* ------------------------------------------------------------------ */

const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8',
};

function resolveFile(log, rel, forWrite) {
  const base = path.resolve(logDir(log));
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) {
    throw new HttpError(400, 'Invalid file path.');
  }
  if (forWrite && parts[parts.length - 1].toLowerCase() === LOG_FILE) {
    throw new HttpError(400, 'log.md holds the bullets of a log. Edit them in the app.');
  }
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) throw new HttpError(400, 'Invalid file path.');
  return { base, full };
}

function uniquePath(full) {
  if (!fs.existsSync(full)) return full;
  const ext = path.extname(full);
  const stem = full.slice(0, full.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const p = `${stem} (${n})${ext}`;
    if (!fs.existsSync(p)) return p;
  }
  throw new HttpError(409, 'Could not find a free file name.');
}

function serveFile(req, res, full, download) {
  const st = safeStat(full);
  if (!st || !st.isFile()) throw new HttpError(404, 'File not found.');
  const ext = path.extname(full).slice(1).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) headers['Content-Security-Policy'] = 'sandbox';
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`;
  if (st.size === 0) {
    headers['Content-Length'] = 0;
    res.writeHead(200, headers);
    return res.end();
  }
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(end, parseInt(m[2], 10));
    } else {
      start = Math.max(0, st.size - parseInt(m[2], 10));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full, { start, end }).pipe(res);
}

async function putFile(req, res, q) {
  const { base, full } = resolveFile(q.log, q.path, true);
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > 2 * 1024 ** 3) throw new HttpError(413, 'That file is too large (2 GB max).');
  const target = q.noclobber === '1' ? uniquePath(full) : full;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.upload');
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  json(res, 200, { path: path.relative(base, target).split(path.sep).join('/') });
}

function deleteFile(q) {
  const { full } = resolveFile(q.log, q.path, true);
  const st = safeStat(full);
  if (!st || !st.isFile()) throw new HttpError(404, 'File not found.');
  moveToTrash(full, path.basename(full));
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* OS helpers                                                          */
/* ------------------------------------------------------------------ */

function openWithOS(target) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const p = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8e6) throw new HttpError(413, 'Request too large.');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep) || !safeStat(full) || !safeStat(full).isFile()) {
    throw new HttpError(404, 'Not found.');
  }
  const ext = path.extname(full).slice(1).toLowerCase();
  const body = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function route(req, res) {
  // Only talk to pages served from this machine (blocks other websites and DNS rebinding).
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, 'Forbidden.');
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) throw new HttpError(403, 'Forbidden.');
    if (req.headers['x-bujo'] !== '1') throw new HttpError(403, 'Forbidden.');
  }

  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  switch (method + ' ' + p) {
    case 'GET /api/info':
      return json(res, 200, { root: ROOT, platform: process.platform });
    case 'GET /api/sig':
      return json(res, 200, { sig: computeSig() });
    case 'GET /api/logs':
      return json(res, 200, { logs: logsList() });
    case 'GET /api/page':
      return json(res, 200, pageResponse(q.kind, q.id));
    case 'GET /api/pages':
      return json(res, 200, { pages: rangePages(q.from, q.to) });
    case 'GET /api/carry':
      return json(res, 200, { items: carryOver(q.date) });
    case 'POST /api/bullet/add':
      return json(res, 200, addBullets(await readJson(req)));
    case 'POST /api/bullet/update':
      return json(res, 200, updateBullet(await readJson(req)));
    case 'POST /api/bullet/child':
      return json(res, 200, addChild(await readJson(req)));
    case 'POST /api/bullet/indent':
      return json(res, 200, indentBullet(await readJson(req)));
    case 'POST /api/bullet/delete':
      return json(res, 200, deleteBullet(await readJson(req)));
    case 'POST /api/bullet/link':
      return json(res, 200, linkBullet(await readJson(req)));
    case 'POST /api/bullet/migrate':
      return json(res, 200, migrateBullet(await readJson(req)));
    case 'POST /api/logs':
      return json(res, 200, createLog(await readJson(req)));
    case 'POST /api/film/meta':
      return json(res, 200, saveFilmMeta(await readJson(req)));
    case 'POST /api/film/data':
      return json(res, 200, saveFilmData(await readJson(req)));
    case 'POST /api/logs/rename':
      return json(res, 200, renameLog(await readJson(req)));
    case 'POST /api/logs/delete':
      return json(res, 200, deleteLog(await readJson(req)));
    case 'GET /api/file':
    case 'HEAD /api/file':
      return serveFile(req, res, resolveFile(q.log, q.path).full, q.download === '1');
    case 'PUT /api/file':
      return putFile(req, res, q);
    case 'DELETE /api/file':
      return json(res, 200, deleteFile(q));
    case 'POST /api/reveal': {
      const body = await readJson(req);
      const dir = body.log ? logDir(body.log) : ROOT;
      if (!safeStat(dir)) throw new HttpError(404, 'Folder not found.');
      openWithOS(dir);
      return json(res, 200, { ok: true, folder: dir });
    }
    default:
      throw new HttpError(404, 'Not found.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong.' : e.message });
    else res.end();
  }
});

for (const d of [...Object.values(DIRS), CUSTOM]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try: node server.js --port ${PORT + 1}`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  Bullet Journal is running');
  console.log(`  Open:    ${url}`);
  console.log(`  Folder:  ${ROOT}\n`);
  if (OPEN_BROWSER) openWithOS(url);
});
