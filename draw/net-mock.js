// テスト用のにせデータベース。?mock をつけて開いたときだけ使う。
// 同じブラウザのタブ同士で localStorage を共有して、Firebase の代わりにする。
const KEY = 'rakugaki.mockdb';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function parts(p) { return p.split('/').filter(Boolean); }
function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function getAt(t, p) {
  let cur = t;
  for (const k of parts(p)) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}
function prune(o) {
  if (!o || typeof o !== 'object') return o;
  for (const k of Object.keys(o)) {
    const v = prune(o[k]);
    if (v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0)) delete o[k];
  }
  return o;
}
function setAt(t, p, v) {
  const ks = parts(p);
  if (!ks.length) return v && typeof v === 'object' ? clone(v) : {};
  let cur = t;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  if (v === null || v === undefined) delete cur[ks[ks.length - 1]];
  else cur[ks[ks.length - 1]] = clone(v);
  return prune(t);
}

export function connectMock() {
  const listeners = new Set();
  const bc = 'BroadcastChannel' in self ? new BroadcastChannel(KEY) : null;
  function fire() {
    const all = readAll();
    for (const l of listeners) {
      const v = getAt(all, l.path);
      const s = JSON.stringify(v);
      if (s !== l.last) { l.last = s; try { l.cb(clone(v)); } catch (e) { console.error(e); } }
    }
  }
  function writeAll(t) {
    localStorage.setItem(KEY, JSON.stringify(t));
    bc && bc.postMessage(1);
    setTimeout(fire, 0);
  }
  window.addEventListener('storage', e => { if (e.key === KEY) fire(); });
  bc && (bc.onmessage = () => fire());
  const onLeave = [];
  window.addEventListener('pagehide', () => {
    const t = readAll();
    for (const [p, v] of onLeave) setAt(t, p, v);
    localStorage.setItem(KEY, JSON.stringify(t));
    bc && bc.postMessage(1);
  });
  return {
    now: () => Date.now(),
    on(path, cb) {
      const l = { path, cb, last: undefined };
      listeners.add(l);
      setTimeout(fire, 0);
      return () => listeners.delete(l);
    },
    async get(path) { return clone(getAt(readAll(), path)); },
    async set(path, v) { writeAll(setAt(readAll(), path, v)); },
    async update(path, obj) {
      const t = readAll();
      for (const [k, v] of Object.entries(obj)) setAt(t, path + '/' + k, v);
      writeAll(t);
    },
    async remove(path) { writeAll(setAt(readAll(), path, null)); },
    async txn(path, fn) {
      const t = readAll();
      const cur = clone(getAt(t, path));
      const nv = fn(cur);
      if (nv === undefined) return { committed: false, value: cur };
      writeAll(setAt(t, path, nv));
      return { committed: true, value: clone(nv) };
    },
    async onDisconnectSet(path, v) { onLeave.push([path, v]); },
    onConnected(cb) { setTimeout(() => cb(true), 0); return () => {}; },
  };
}
