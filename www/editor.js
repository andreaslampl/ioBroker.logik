'use strict';

/* Function block editor: palette, SVG canvas with blocks and wires, properties, live values. */

const SVGNS = 'http://www.w3.org/2000/svg';
const W = 130;
const HEAD = 26;
const ROW = 20;
const base = location.pathname.replace(/[^/]*$/, '');
const $ = id => document.getElementById(id);

let catalog = {};
let programs = [];
let prog = null; // program being edited (copy)
let dirty = false;
let selected = null; // {kind: 'block'|'wire', id}
let live = null;
let ws = null;
const view = { x: 40, y: 20, k: 1 };
const stateNames = {};

// ---------------- helpers ----------------

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function show(text, error) {
  const m = $('msg');
  m.textContent = text;
  m.className = error ? 'error' : '';
  m.style.display = text ? 'block' : 'none';
  clearTimeout(show.t);
  if (text) show.t = setTimeout(() => show(''), error ? 6000 : 2500);
}

const accessKey = new URLSearchParams(location.search).get('key');

async function api(path, options = {}) {
  const url = base + 'api/' + path + (accessKey ? (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(accessKey) : '');
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error((await res.text()) || 'HTTP ' + res.status);
  return res.status === 204 ? null : res.json();
}

function setDirty(d) {
  dirty = d;
  $('save').classList.toggle('dirty', d);
}

/** Comment text in lines of at most 30 characters, broken at spaces. */
function wrap(text) {
  const lines = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/)) {
    if (line && (line + ' ' + word).length > 30) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function width(b) {
  return b.type === 'comment' ? 220 : b.type === 'input' || b.type === 'output' ? 170 : W;
}

function height(b) {
  const d = catalog[b.type];
  if (b.type === 'comment') return 20 + wrap(b.params.text).length * 15;
  const rows = Math.max(d.inputs.length, d.outputs.length, 1);
  return HEAD + 10 + rows * ROW + (b.type === 'input' || b.type === 'output' ? 16 : 0);
}

function portPos(b, port, isOut) {
  const d = catalog[b.type];
  const list = isOut ? d.outputs : d.inputs.map(i => i.name);
  const i = Math.max(0, list.indexOf(port));
  return { x: b.x + (isOut ? width(b) : 0), y: b.y + HEAD + 14 + i * ROW };
}

function wirePath(a, z) {
  const dx = Math.max(40, Math.abs(z.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${z.x - dx} ${z.y}, ${z.x} ${z.y}`;
}

function shortState(id) {
  if (!id) return '(kein Datenpunkt)';
  const parts = id.split('.');
  return parts.length > 3 ? '…' + parts.slice(-3).join('.') : id;
}

function blockById(id) {
  return prog.blocks.find(b => b.id === id);
}

function newId(type) {
  let i = 1;
  while (prog.blocks.some(b => b.id === type + i)) i++;
  return type + i;
}

// ---------------- rendering ----------------

function renderTabs() {
  const tabs = $('tabs');
  tabs.textContent = '';
  for (const p of programs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.className = (prog && p.id === prog.id ? 'active' : '') + (p.enabled === false ? ' off' : '');
    b.onclick = () => openProgram(p.id);
    tabs.appendChild(b);
  }
  $('enabled').checked = Boolean(prog && prog.enabled !== false);
  for (const id of ['enabled', 'rename', 'delete', 'save']) $(id).disabled = !prog;
}

function render() {
  const gb = $('blocks');
  const gw = $('wires');
  gb.textContent = '';
  gw.textContent = '';
  $('viewport').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  if (!prog) return;
  for (const w of prog.wires) {
    const from = blockById(w.from.block);
    const to = blockById(w.to.block);
    if (!from || !to) continue;
    const d = wirePath(portPos(from, w.from.port, true), portPos(to, w.to.port, false));
    const g = el('g', { 'data-wire': w.id }, gw);
    el('path', { d, class: 'wire' + (selected && selected.kind === 'wire' && selected.id === w.id ? ' selected' : ''), 'data-src': w.from.block + '.' + w.from.port }, g);
    el('path', { d, class: 'wirehit', 'data-wire': w.id }, g);
  }
  for (const b of prog.blocks) renderBlock(gb, b);
  applyLive();
}

function renderBlock(parent, b) {
  const d = catalog[b.type];
  const w = width(b);
  const h = height(b);
  const cls = ['block', b.type === 'input' || b.type === 'output' ? 'io' : '', b.type === 'comment' ? 'note' : '', selected && selected.kind === 'block' && selected.id === b.id ? 'selected' : ''];
  const g = el('g', { class: cls.join(' '), 'data-block': b.id, transform: `translate(${b.x},${b.y})` }, parent);
  el('rect', { class: 'body', width: w, height: h }, g);
  if (b.type === 'comment') {
    wrap(b.params.text).forEach((line, i) => {
      el('text', { x: 8, y: 20 + i * 15 }, g).textContent = line;
    });
    return;
  }
  el('rect', { class: 'head', x: 1, y: 1, width: w - 2, height: HEAD - 1 }, g);
  el('text', { class: 'sym', x: 8, y: 18 }, g).textContent = d.symbol;
  const labelX = 16 + Math.max(16, String(d.symbol).length * 11);
  const room = Math.floor((w - labelX - 6) / 6.5);
  el('text', { x: labelX, y: 17 }, g).textContent = d.label.length > room ? d.label.slice(0, room - 1) + '…' : d.label;
  d.inputs.forEach((inp, i) => {
    const y = HEAD + 14 + i * ROW;
    el('circle', { class: 'port', cx: 0, cy: y, r: 6, 'data-port': inp.name, 'data-dir': 'in', 'data-block': b.id }, g);
    el('text', { class: 'small', x: 10, y: y + 4 }, g).textContent = inp.name;
  });
  d.outputs.forEach((out, i) => {
    const y = HEAD + 14 + i * ROW;
    el('circle', { class: 'port', cx: w, cy: y, r: 6, 'data-port': out, 'data-dir': 'out', 'data-block': b.id }, g);
    el('text', { class: 'small', x: w - 10, y: y + 4, 'text-anchor': 'end' }, g).textContent = out;
    el('text', { class: 'val', x: w + 9, y: y - 7, 'data-val': b.id + '.' + out }, g);
  });
  if (b.type === 'input' || b.type === 'output') {
    const name = stateNames[b.params.state];
    el('text', { class: 'small', x: b.type === 'input' ? 8 : 30, y: h - 8 }, g).textContent = name ? (name.length > 26 ? name.slice(0, 25) + '…' : name) : shortState(b.params.state);
  }
  el('text', { class: 'small', x: w - 6, y: h - 6, 'text-anchor': 'end', 'data-remaining': b.id }, g);
}

function applyLive() {
  const on = $('live').checked && live && prog && live.program === prog.id ? live.blocks : null;
  for (const p of document.querySelectorAll('#wires path.wire')) {
    const [bid, port] = p.getAttribute('data-src').split('.');
    const v = on && on[bid] && on[bid].out ? on[bid].out[port] : 0;
    p.classList.toggle('on', Boolean(on && v));
  }
  for (const t of document.querySelectorAll('[data-val]')) {
    const [bid, port] = t.getAttribute('data-val').split('.');
    const v = on && on[bid] && on[bid].out ? on[bid].out[port] : undefined;
    t.textContent = v === undefined ? '' : String(Math.round(v * 100) / 100);
  }
  for (const t of document.querySelectorAll('[data-remaining]')) {
    const r = on && on[t.getAttribute('data-remaining')] && on[t.getAttribute('data-remaining')].remaining;
    t.textContent = r ? '⏱ ' + r + ' s' : '';
  }
  for (const g of document.querySelectorAll('g.block')) {
    const id = g.getAttribute('data-block');
    const b = blockById(id);
    let active = false;
    if (on && on[id]) {
      if (b.type === 'output') active = Boolean(on[id].out && on[id].out.I);
      else if (b.type === 'input') active = Boolean(on[id].out && on[id].out.Q);
    }
    g.classList.toggle('active', active);
  }
}

// ---------------- palette ----------------

function renderPalette() {
  const pal = $('palette');
  pal.textContent = '';
  const groups = {};
  for (const d of Object.values(catalog)) (groups[d.group] = groups[d.group] || []).push(d);
  for (const [group, items] of Object.entries(groups)) {
    const h = document.createElement('h4');
    h.textContent = group;
    pal.appendChild(h);
    for (const d of items) {
      const item = document.createElement('div');
      item.className = 'item';
      item.draggable = true;
      item.title = 'Klicken oder auf die Fläche ziehen';
      item.innerHTML = '<span class="sym"></span><span></span>';
      item.firstChild.textContent = d.symbol;
      item.lastChild.textContent = d.label;
      item.onclick = () => addBlock(d.type, null);
      item.ondragstart = e => e.dataTransfer.setData('text/plain', d.type);
      pal.appendChild(item);
    }
  }
}

function toCanvas(clientX, clientY) {
  const r = $('canvas').getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}

function addBlock(type, at) {
  if (!prog) return show('Zuerst ein Programm anlegen (＋ Neu).', true);
  const d = catalog[type];
  const r = $('canvas').getBoundingClientRect();
  const pos = at || toCanvas(r.left + r.width / 2 - 60 + Math.random() * 40, r.top + r.height / 2 - 40 + Math.random() * 40);
  const params = {};
  for (const p of d.params) params[p.key] = p.default;
  const b = { id: newId(type), type, x: Math.round(pos.x / 10) * 10, y: Math.round(pos.y / 10) * 10, params };
  prog.blocks.push(b);
  selected = { kind: 'block', id: b.id };
  setDirty(true);
  render();
  renderProps();
}

// ---------------- properties ----------------

function renderProps() {
  const box = $('props');
  box.textContent = '';
  if (!prog) {
    box.innerHTML = '<p class="muted">Noch kein Programm. Mit „＋ Neu“ anlegen oder ein Beispiel einfügen.</p>';
    return;
  }
  const b = selected && selected.kind === 'block' ? blockById(selected.id) : null;
  if (!b) {
    const h = document.createElement('h3');
    h.textContent = prog.name;
    box.appendChild(h);
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = prog.blocks.length + ' Bausteine, ' + prog.wires.length + ' Verbindungen. Baustein anklicken, um ihn einzustellen.';
    box.appendChild(p);
    return;
  }
  const d = catalog[b.type];
  const h = document.createElement('h3');
  h.textContent = d.label;
  box.appendChild(h);
  const idp = document.createElement('div');
  idp.className = 'muted';
  idp.textContent = 'ID: ' + b.id;
  box.appendChild(idp);
  for (const p of d.params) {
    const label = document.createElement('label');
    label.textContent = p.label + (p.unit ? ' (' + p.unit + ')' : '');
    box.appendChild(label);
    let input;
    if (p.type === 'select') {
      input = document.createElement('select');
      for (const [v, t] of p.options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = t;
        input.appendChild(o);
      }
      input.value = b.params[p.key];
    } else if (p.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(b.params[p.key]);
    } else if (p.type === 'text' && b.type === 'comment') {
      input = document.createElement('textarea');
      input.value = b.params[p.key] || '';
    } else {
      input = document.createElement('input');
      input.type = p.type === 'number' || p.type === 'time' ? 'number' : 'text';
      if (input.type === 'number') input.step = 'any';
      input.value = b.params[p.key] === undefined ? '' : b.params[p.key];
      if (p.type === 'state') {
        input.setAttribute('list', 'stateList');
        input.placeholder = 'z. B. hm-rpc.0.ABC123.1.STATE';
        input.oninput = () => searchStates(input.value);
      }
    }
    const apply = () => {
      const v = p.type === 'bool' ? input.checked : p.type === 'number' || p.type === 'time' ? Number(input.value) : input.value.trim();
      b.params[p.key] = v;
      setDirty(true);
      render();
      if (p.type === 'state') updateStateName(v, nameEl);
    };
    input.onchange = apply;
    if (p.type === 'text' && b.type === 'comment') input.oninput = apply;
    box.appendChild(input);
    let nameEl = null;
    if (p.type === 'state') {
      nameEl = document.createElement('div');
      nameEl.className = 'statename';
      box.appendChild(nameEl);
      updateStateName(b.params[p.key], nameEl);
    }
    if (p.help) {
      const help = document.createElement('div');
      help.className = 'help';
      help.textContent = p.help;
      box.appendChild(help);
    }
  }
  if (live && live.blocks && live.blocks[b.id] && $('live').checked) {
    const v = document.createElement('p');
    v.className = 'muted';
    v.textContent = 'Live: ' + JSON.stringify(live.blocks[b.id].out);
    box.appendChild(v);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = 'Baustein löschen';
  del.style.marginTop = '16px';
  del.onclick = () => deleteSelected();
  box.appendChild(del);
}

async function updateStateName(id, nameEl) {
  if (!nameEl) return;
  nameEl.textContent = '';
  if (!id) return;
  if (stateNames[id] === undefined) {
    try {
      const list = await api('states?q=' + encodeURIComponent(id) + '&exact=1');
      stateNames[id] = list[0] && list[0].id === id ? list[0].name || '' : null;
    } catch (e) {
      stateNames[id] = null;
    }
  }
  nameEl.textContent = stateNames[id] === null ? '⚠ Datenpunkt nicht gefunden' : stateNames[id] || '';
  render();
}

let searchTimer = null;
function searchStates(text) {
  clearTimeout(searchTimer);
  if (text.length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const list = await api('states?q=' + encodeURIComponent(text));
      const dl = $('stateList');
      dl.textContent = '';
      for (const s of list) {
        stateNames[s.id] = s.name || '';
        const o = document.createElement('option');
        o.value = s.id;
        o.label = (s.name || '') + (s.type ? ' (' + s.type + ')' : '');
        dl.appendChild(o);
      }
    } catch (e) {
      // ignore
    }
  }, 250);
}

// ---------------- canvas interaction ----------------

let drag = null;

function svgTarget(e) {
  return e.target.closest ? e.target : null;
}

$('canvas').addEventListener('pointerdown', e => {
  const t = svgTarget(e);
  if (!prog || !t) return;
  const pt = toCanvas(e.clientX, e.clientY);
  if (t.classList.contains('port')) {
    drag = { kind: 'wire', block: t.getAttribute('data-block'), port: t.getAttribute('data-port'), dir: t.getAttribute('data-dir') };
  } else if (t.classList.contains('wirehit')) {
    selected = { kind: 'wire', id: t.getAttribute('data-wire') };
    render();
    renderProps();
    return;
  } else if (t.closest('g.block')) {
    const id = t.closest('g.block').getAttribute('data-block');
    const b = blockById(id);
    selected = { kind: 'block', id };
    drag = { kind: 'move', block: b, dx: pt.x - b.x, dy: pt.y - b.y, moved: false };
    render();
    renderProps();
  } else {
    selected = null;
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    render();
    renderProps();
  }
  $('canvas').setPointerCapture(e.pointerId);
});

$('canvas').addEventListener('pointermove', e => {
  if (!drag) return;
  const pt = toCanvas(e.clientX, e.clientY);
  if (drag.kind === 'pan') {
    view.x = drag.vx + e.clientX - drag.x;
    view.y = drag.vy + e.clientY - drag.y;
    $('viewport').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  } else if (drag.kind === 'move') {
    drag.block.x = Math.round((pt.x - drag.dx) / 10) * 10;
    drag.block.y = Math.round((pt.y - drag.dy) / 10) * 10;
    drag.moved = true;
    render();
  } else if (drag.kind === 'wire') {
    const b = blockById(drag.block);
    const p = portPos(b, drag.port, drag.dir === 'out');
    $('drag').setAttribute('d', drag.dir === 'out' ? wirePath(p, pt) : wirePath(pt, p));
  }
});

$('canvas').addEventListener('pointerup', e => {
  if (!drag) return;
  if (drag.kind === 'move' && drag.moved) setDirty(true);
  if (drag.kind === 'wire') {
    $('drag').setAttribute('d', '');
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit && hit.classList && hit.classList.contains('port') && hit.getAttribute('data-dir') !== drag.dir) {
      const other = { block: hit.getAttribute('data-block'), port: hit.getAttribute('data-port') };
      const from = drag.dir === 'out' ? { block: drag.block, port: drag.port } : other;
      const to = drag.dir === 'out' ? other : { block: drag.block, port: drag.port };
      // an input has exactly one source: replace an existing wire
      prog.wires = prog.wires.filter(w => !(w.to.block === to.block && w.to.port === to.port));
      let n = 1;
      while (prog.wires.some(w => w.id === 'w' + n)) n++;
      prog.wires.push({ id: 'w' + n, from, to });
      setDirty(true);
      render();
    }
  }
  drag = null;
});

$('canvas').addEventListener('wheel', e => {
  e.preventDefault();
  const r = $('canvas').getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  const k = Math.min(2.5, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  view.x = mx - ((mx - view.x) * k) / view.k;
  view.y = my - ((my - view.y) * k) / view.k;
  view.k = k;
  $('viewport').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}, { passive: false });

$('canvasWrap').addEventListener('dragover', e => e.preventDefault());
$('canvasWrap').addEventListener('drop', e => {
  e.preventDefault();
  const type = e.dataTransfer.getData('text/plain');
  if (catalog[type]) addBlock(type, toCanvas(e.clientX, e.clientY));
});

function deleteSelected() {
  if (!prog || !selected) return;
  if (selected.kind === 'wire') {
    prog.wires = prog.wires.filter(w => w.id !== selected.id);
  } else {
    prog.blocks = prog.blocks.filter(b => b.id !== selected.id);
    prog.wires = prog.wires.filter(w => w.from.block !== selected.id && w.to.block !== selected.id);
  }
  selected = null;
  setDirty(true);
  render();
  renderProps();
}

document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteSelected();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

// ---------------- programs ----------------

/** Zoom and move so the whole program is visible. */
function fit() {
  if (!prog || !prog.blocks.length) {
    Object.assign(view, { x: 40, y: 20, k: 1 });
    return;
  }
  const r = $('canvas').getBoundingClientRect();
  const x0 = Math.min(...prog.blocks.map(b => b.x)) - 30;
  const y0 = Math.min(...prog.blocks.map(b => b.y)) - 30;
  const x1 = Math.max(...prog.blocks.map(b => b.x + width(b))) + 40;
  const y1 = Math.max(...prog.blocks.map(b => b.y + height(b))) + 30;
  const k = Math.min(1.2, Math.max(0.3, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
  Object.assign(view, { k, x: -x0 * k + (r.width - (x1 - x0) * k) / 2, y: -y0 * k });
}

function openProgram(id) {
  if (dirty && !confirm('Änderungen am aktuellen Programm verwerfen?')) return;
  const p = programs.find(x => x.id === id);
  prog = p ? JSON.parse(JSON.stringify(p)) : null;
  prog && prog.wires.forEach((w, i) => { w.id = w.id || 'w' + (i + 1); });
  selected = null;
  live = null;
  setDirty(false);
  fit();
  renderTabs();
  render();
  renderProps();
  watch();
  if (prog) prog.blocks.filter(b => b.params && b.params.state).forEach(b => updateStateName(b.params.state, null));
}

async function loadPrograms(selectId) {
  programs = await api('programs');
  renderTabs();
  if (selectId || !prog) {
    dirty = false;
    openProgram(selectId || (programs[0] && programs[0].id));
  }
}

async function save() {
  if (!prog) return;
  try {
    const saved = await api('programs/' + encodeURIComponent(prog.id), { method: 'PUT', body: JSON.stringify(prog) });
    const i = programs.findIndex(p => p.id === saved.id);
    programs[i] = saved;
    setDirty(false);
    renderTabs();
    show('Gespeichert – das Programm läuft mit den neuen Einstellungen.');
  } catch (e) {
    show('Speichern fehlgeschlagen: ' + e.message, true);
  }
}

$('save').onclick = save;
$('newProg').onclick = async () => {
  const name = prompt('Name des neuen Programms:', 'Neues Programm');
  if (!name) return;
  if (dirty && !confirm('Änderungen am aktuellen Programm verwerfen?')) return;
  dirty = false;
  const p = await api('programs', { method: 'POST', body: JSON.stringify({ name }) });
  await loadPrograms(p.id);
};
$('fromTemplate').onclick = async () => {
  if (dirty && !confirm('Änderungen am aktuellen Programm verwerfen?')) return;
  dirty = false;
  const p = await api('programs?template=solarium', { method: 'POST', body: '{}' });
  await loadPrograms(p.id);
  show('Beispiel eingefügt – Datenpunkte (demo.*) durch die eigenen ersetzen und aktiv schalten.');
};
$('rename').onclick = () => {
  const name = prompt('Neuer Name:', prog.name);
  if (!name) return;
  prog.name = name;
  setDirty(true);
  renderTabs();
  renderProps();
};
$('delete').onclick = async () => {
  if (!confirm('Programm „' + prog.name + '“ wirklich löschen?')) return;
  await api('programs/' + encodeURIComponent(prog.id), { method: 'DELETE' });
  prog = null;
  dirty = false;
  await loadPrograms();
};
$('enabled').onchange = () => {
  prog.enabled = $('enabled').checked;
  setDirty(true);
  renderTabs();
};
$('live').onchange = () => applyLive();
$('fitView').onclick = () => {
  fit();
  render();
};
window.addEventListener('beforeunload', e => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------- live values ----------------

function watch() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'watch', program: prog ? prog.id : null }));
}

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws' + location.search);
  ws.onopen = watch;
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'live' && prog && msg.program === prog.id) {
      live = msg;
      applyLive();
    } else if (msg.type === 'programs' && !dirty) {
      loadPrograms(prog && prog.id);
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

(async () => {
  try {
    for (const d of await api('catalog')) catalog[d.type] = d;
    renderPalette();
    await loadPrograms();
    connect();
  } catch (e) {
    show('Verbindung zum Adapter fehlgeschlagen: ' + e.message, true);
  }
})();
