// らくがき伝言：お題 → 絵 → 答え → 絵 … と回して、最後に全員で見る。
// データの置き場所（Firebase Realtime Database）:
//   rooms/{合言葉}/createdAt
//   rooms/{合言葉}/players/{pid}   … {name, online, joinedAt, color}
//   rooms/{合言葉}/settings        … {drawSec, rounds}
//   rooms/{合言葉}/state           … {phase: lobby|play|reveal, host, gid, order, rounds, round, deadline, chain, step}
//   rooms/{合言葉}/games/{gid}/chains/{チェーン番号}/{ターン} … {by, t: text|draw, v}
//   rooms/{合言葉}/games/{gid}/done/{ターン}/{pid} … true
import { randomOdai } from './odai.js';

const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
const SPEED = MOCK && params.has('fast') ? 0.25 : 1;   // テストのときだけ時間を短くする
const PROMPT_SEC = 40, TEXT_SEC = 40, LATE_MS = 4000;
const PAD = 480;
const COLORS = ['#2b2622', '#868e96', '#e03131', '#f76707', '#fcc419', '#2f9e44', '#1971c2', '#7048e8', '#f06595', '#8d5524', '#ffffff'];
const SIZES = [3, 7, 14, 28];
const PLAYER_COLORS = ['#ff6b4a', '#3b82f6', '#2f9e44', '#f59f00', '#7048e8', '#e64980', '#0c8599', '#8d5524'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const $ = id => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
function rid(n) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map(b => a[b % a.length]).join('');
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const safeColor = c => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) ? c : '#999999';

// この端末の参加者ID。テストでは同じブラウザで何人も演じるのでタブごとに分ける。
let pid;
try {
  const idStore = MOCK ? sessionStorage : localStorage;
  pid = idStore.getItem('rakugaki.pid');
  if (!pid) { pid = rid(12); idStore.setItem('rakugaki.pid', pid); }
} catch { pid = rid(12); }

let api = null, code = null, players = {}, state = null, settings = { drawSec: 90, rounds: 0 };
let unsubs = [], doneUnsub = null, doneKey = null, doneMap = {};
let task = null, advancing = false, wasConnected = false;
let revealCache = {}, browseChain = null;

// ---- 画面の切りかえ ----
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 's-' + name));
  const playing = ['text', 'draw', 'wait'].includes(name) && state && state.phase === 'play';
  $('playbar').classList.toggle('show', !!playing);
  $('timeBar').hidden = !playing;
}
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function fail(msg) { $('errorText').textContent = msg; show('error'); }

// ---- 起動 ----
async function boot() {
  try {
    if (MOCK) {
      api = (await import('./net-mock.js')).connectMock();
    } else {
      const { firebaseConfig } = await import('./firebase-config.js');
      if (!firebaseConfig || !firebaseConfig.databaseURL) { show('setup'); return; }
      api = (await import('./net-firebase.js')).connectFirebase(firebaseConfig);
    }
  } catch (e) {
    fail('読み込みに失敗しました。電波のいい場所で開き直してね。（' + (e && e.message || e) + '）');
    return;
  }
  initHome();
  setInterval(tick, 250);
}

function initHome() {
  $('nameIn').value = store.get('rakugaki.name') || '';
  const inv = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (inv.length === 4) {
    $('codeIn').value = inv;
    $('inviteNote').hidden = false;
    $('inviteNote').textContent = `招待された部屋：${inv}　名前を入れて「入る」を押してね`;
  } else {
    $('inviteNote').hidden = true;
  }
  $('headRoom').textContent = '';
  show('home');
}
function getName() {
  const n = $('nameIn').value.trim().slice(0, 10);
  if (!n) { toast('名前を入れてね'); $('nameIn').focus(); return null; }
  store.set('rakugaki.name', n);
  return n;
}
async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } catch (e) { console.warn(e); toast('うまくいきませんでした。電波を確認してね'); }
  finally { btn.disabled = false; }
}
$('createBtn').onclick = () => withBusy($('createBtn'), async () => {
  const n = getName(); if (!n) return;
  await createRoom(n);
});
$('joinBtn').onclick = () => withBusy($('joinBtn'), async () => {
  const n = getName(); if (!n) return;
  const c = $('codeIn').value.toUpperCase().replace(/[^A-Z]/g, '');
  if (c.length !== 4) { toast('合言葉は4文字です'); return; }
  await enterRoom(c, n);
});
$('codeIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('joinBtn').click(); });

// ---- 部屋 ----
async function createRoom(name) {
  for (let i = 0; i < 8; i++) {
    const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const r = await api.txn(`rooms/${c}`, cur => cur === null
      ? { createdAt: api.now(), state: { phase: 'lobby', host: pid }, settings: { drawSec: 90, rounds: 0 } }
      : undefined);
    if (r.committed) return enterRoom(c, name);
  }
  toast('部屋をつくれませんでした。もう一度ためしてね');
}

async function enterRoom(c, name) {
  const created = await api.get(`rooms/${c}/createdAt`);
  if (!created) { toast('その合言葉の部屋は見つかりませんでした'); return; }
  leaveRoom();
  code = c;
  const me = await api.get(`rooms/${c}/players/${pid}`);
  await api.update(`rooms/${c}/players/${pid}`, {
    name, online: true,
    joinedAt: (me && me.joinedAt) || api.now(),
    color: (me && me.color) || await freeColor(c),
  });
  api.onDisconnectSet(`rooms/${c}/players/${pid}/online`, false);
  unsubs.push(api.onConnected(ok => {
    if (ok) wasConnected = true;
    $('netBanner').classList.toggle('show', !ok && wasConnected);
    if (ok && code === c) {
      api.update(`rooms/${c}/players/${pid}`, { online: true }).catch(() => {});
      api.onDisconnectSet(`rooms/${c}/players/${pid}/online`, false);
    }
  }));
  const q = new URLSearchParams({ room: c });
  if (MOCK) q.set('mock', '');
  if (SPEED !== 1) q.set('fast', '');
  history.replaceState(null, '', '?' + q.toString().replace(/=(&|$)/g, '$1'));
  $('headRoom').textContent = c;
  unsubs.push(api.on(`rooms/${c}/players`, v => { players = v || {}; onPlayers(); }));
  unsubs.push(api.on(`rooms/${c}/settings`, v => {
    settings = Object.assign({ drawSec: 90, rounds: 0 }, v || {});
    if (state && state.phase === 'lobby') renderLobby();
  }));
  unsubs.push(api.on(`rooms/${c}/state`, v => { state = v; onState(); }));
}

// まだ誰も使っていない色を選ぶ（全部使われていたらランダム）
async function freeColor(c) {
  const ps = (await api.get(`rooms/${c}/players`)) || {};
  const used = new Set(Object.values(ps).map(p => p && p.color));
  return PLAYER_COLORS.find(x => !used.has(x)) || PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function leaveRoom() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
  stopDone();
  if (code) api.update(`rooms/${code}/players/${pid}`, { online: false }).catch(() => {});
  code = null; state = null; players = {}; task = null; browseChain = null; revealCache = {};
  $('revealList').textContent = ''; delete $('revealList').dataset.key;
}
$('leaveBtn').onclick = () => {
  leaveRoom();
  history.replaceState(null, '', MOCK ? '?mock' : location.pathname);
  initHome();
};

function sortedPlayers() {
  return Object.entries(players || {})
    .map(([id, p]) => ({ id, ...(p || {}) }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || (a.id < b.id ? -1 : 1));
}
// 進行役。作った人がいなくなったら、残っている人の中で一番早く来た人が引きつぐ。
function controllerId() {
  if (!state) return null;
  if (state.host && players[state.host] && players[state.host].online) return state.host;
  const pool = (state.order || []).filter(id => players[id] && players[id].online);
  if (pool.length) return pool[0];
  const on = sortedPlayers().filter(p => p.online);
  return on.length ? on[0].id : null;
}
const isHost = () => controllerId() === pid;
const nameOf = id => (players[id] && players[id].name) || '？';

function onPlayers() {
  if (!state) return;
  if (state.phase === 'lobby') renderLobby();
  else if (state.phase === 'play') { renderWait(); maybeAdvance(); }
  else if (state.phase === 'reveal') renderRevealCtl();
}
function onState() {
  if (!code) return;
  if (!state) { fail('部屋がなくなりました。最初の画面から入り直してね。'); return; }
  if (state.phase === 'lobby') {
    stopDone(); task = null; browseChain = null;
    renderLobby(); show('lobby');
  } else if (state.phase === 'play') {
    enterRound();
  } else if (state.phase === 'reveal') {
    stopDone(); task = null;
    renderReveal();
  }
}

// ---- 待合室 ----
function renderLobby() {
  $('lobbyCode').textContent = code;
  const list = $('playerList'); list.textContent = '';
  const ps = sortedPlayers(), host = controllerId(), me = host === pid;
  for (const p of ps) {
    const li = el('li'); if (!p.online) li.className = 'off';
    const dot = el('span', 'dot'); dot.style.background = safeColor(p.color);
    li.append(dot, el('span', 'name', p.name || '？'));
    if (p.id === pid) li.append(el('span', 'tag me', 'あなた'));
    if (p.id === host) li.append(el('span', 'tag host', 'ホスト'));
    if (!p.online) {
      li.append(el('span', 'tag', 'いない'));
      if (me && p.id !== pid) {
        const x = el('button', 'btn sub small', '外す');
        x.onclick = () => api.remove(`rooms/${code}/players/${p.id}`);
        li.append(x);
      }
    }
    list.append(li);
  }
  const on = ps.filter(p => p.online).length;
  $('countNote').textContent = `${on}人`;
  const sel = $('roundsSel'), prev = String(settings.rounds || 0);
  sel.textContent = '';
  const add = (v, t) => { const o = el('option', null, t); o.value = v; sel.append(o); };
  add('0', `おまかせ（${Math.max(2, Math.min(on, 8))}）`);
  for (let n = 2; n <= Math.max(2, on); n++) add(String(n), `${n}ターン`);
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : '0';
  $('drawSecSel').value = String(settings.drawSec || 90);
  sel.disabled = $('drawSecSel').disabled = !me;
  $('settingsNote').textContent = me
    ? 'ターン数を人数より少なくすると、早く結果発表になります。'
    : '設定はホストが決めます。';
  $('startBtn').hidden = !me;
  $('startBtn').disabled = on < 2;
  $('startNote').textContent = me
    ? (on < 2 ? 'あと1人以上そろうと始められます' : on < 3 ? '3人以上がおすすめ。2人でも遊べます' : 'みんなそろったらスタート！')
    : 'ホストがスタートするのを待っています';
}
$('drawSecSel').onchange = () => api.update(`rooms/${code}/settings`, { drawSec: +$('drawSecSel').value });
$('roundsSel').onchange = () => api.update(`rooms/${code}/settings`, { rounds: +$('roundsSel').value });
$('shareBtn').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + code + (MOCK ? '&mock' : '');
  const text = `らくがき伝言やろう！ 合言葉は ${code}\n${url}`;
  try { if (navigator.share) { await navigator.share({ text }); return; } }
  catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('コピーしました。LINEなどに貼ってね'); }
  catch { toast(text); }
};
$('startBtn').onclick = () => withBusy($('startBtn'), async () => {
  const on = sortedPlayers().filter(p => p.online);
  if (on.length < 2) return;
  const order = shuffle(on.map(p => p.id));
  const N = order.length;
  let R = settings.rounds > 0 ? settings.rounds : Math.min(N, 8);
  R = Math.max(2, Math.min(N, R));
  await api.remove(`rooms/${code}/games`);
  await api.set(`rooms/${code}/state`, {
    phase: 'play', host: (state && state.host) || pid, gid: rid(8), order, rounds: R, round: 0,
    drawSec: +(settings.drawSec || 90), textSec: TEXT_SEC,
    deadline: api.now() + PROMPT_SEC * 1000 * SPEED,
  });
});

// ---- ターン ----
const gamePath = gid => `rooms/${code}/games/${gid}`;
const KIND_LABEL = { prompt: 'お題を書く番', draw: '絵を描く番', guess: '絵を見て当てる番' };

async function enterRound() {
  const s = state;
  watchDone(s.gid, s.round);
  const order = s.order || [];
  const k = order.indexOf(pid);
  if (k < 0) { task = null; show('spectate'); return; }
  const key = s.gid + ':' + s.round;
  if (task && task.key === key) { if (task.submitted) renderWait(); return; }
  const N = order.length;
  const kind = s.round === 0 ? 'prompt' : (s.round % 2 === 1 ? 'draw' : 'guess');
  const chain = ((k - s.round) % N + N) % N;
  const t = task = { key, gid: s.gid, round: s.round, chain, kind, submitted: false, ready: false };
  $('roundLabel').textContent = `ターン ${s.round + 1}/${s.rounds}・${KIND_LABEL[kind]}`;
  const already = await api.get(`${gamePath(s.gid)}/done/${s.round}/${pid}`);
  if (task !== t) return;
  if (already) { t.submitted = true; show('wait'); renderWait(); return; }
  if (kind === 'prompt') { setupText(t, null); return; }
  const src = await loadSource(s.gid, chain, s.round, kind === 'draw' ? 'text' : 'draw');
  if (task !== t) return;
  if (kind === 'draw') setupDraw(t, src); else setupText(t, src);
}

// 前のターンの中身を取る。届いていなければ、同じチェーンをさかのぼって使えるものを探す。
async function loadSource(gid, chain, round, type) {
  const prev = await api.get(`${gamePath(gid)}/chains/${chain}/${round - 1}`);
  if (prev && prev.t === type && usable(prev)) return prev;
  const all = (await api.get(`${gamePath(gid)}/chains/${chain}`)) || {};
  for (let i = round - 1; i >= 0; i--) {
    const e = all[i];
    if (e && e.t === type && usable(e)) return e;
  }
  return null;
}
function usable(e) {
  if (!e || typeof e.v !== 'string' || !e.v) return false;
  return e.t !== 'draw' || parseStrokes(e.v).length > 0;
}

function setupText(t, src) {
  const box = $('textShow'); box.textContent = '';
  $('textIn').value = '';
  if (t.kind === 'prompt') {
    box.hidden = true;
    $('textLabel').textContent = 'お題を書こう（次の人がこれを絵にします）';
    $('textIn').placeholder = '例：空を飛ぶペンギン';
    $('omakaseBtn').hidden = false;
  } else {
    box.hidden = false;
    $('textLabel').textContent = 'この絵は何？ 思ったことを書こう';
    $('textIn').placeholder = '例：おにぎりを食べるクマ';
    $('omakaseBtn').hidden = true;
    if (src) {
      const cv = el('canvas', 'viewpad'); cv.width = cv.height = PAD;
      box.append(cv); drawStrokes(cv, parseStrokes(src.v));
    } else {
      box.append(el('div', 'blank', '前の人の絵が届きませんでした（白紙か時間切れ）。想像で好きに書いてね！'));
    }
  }
  t.ready = true;
  show('text');
}
$('omakaseBtn').onclick = () => { $('textIn').value = randomOdai(); };
$('textSubmit').onclick = () => submit(false);
$('textIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) submit(false); });

function setupDraw(t, src) {
  const p = $('drawPrompt'); p.textContent = '';
  p.append(el('small', null, src ? 'お題' : 'お題が届かなかったので、代わりのお題'));
  p.append(document.createTextNode(src ? src.v : randomOdai()));
  pad.clearAll();
  t.ready = true;
  show('draw');
}
$('drawSubmit').onclick = () => submit(false);

async function submit(auto) {
  const t = task;
  if (!t || t.submitted || !t.ready) return;
  let entry;
  if (t.kind === 'draw') {
    entry = { by: pid, t: 'draw', v: pad.serialize() };
  } else {
    let v = $('textIn').value.trim().slice(0, 40);
    if (!v && t.kind === 'prompt') v = randomOdai();
    if (!v && !auto) { toast('なにか書いてね'); return; }
    entry = { by: pid, t: 'text', v };   // 時間切れで空のときは '' のまま（次の人は前の言葉を使う）
  }
  t.submitted = true;
  show('wait'); renderWait();
  if (auto) toast('時間切れ！ そこまでの内容で送りました');
  try {
    await api.set(`${gamePath(t.gid)}/chains/${t.chain}/${t.round}`, entry);
    await api.set(`${gamePath(t.gid)}/done/${t.round}/${pid}`, true);
  } catch (e) {
    console.warn(e);
    t.submitted = false;
    if (task === t) { show(t.kind === 'draw' ? 'draw' : 'text'); toast('送れませんでした。もう一度押してね'); }
  }
}

function watchDone(gid, round) {
  const key = gid + ':' + round;
  if (doneKey === key) return;
  stopDone();
  doneKey = key; doneMap = {};
  doneUnsub = api.on(`${gamePath(gid)}/done/${round}`, v => {
    if (doneKey !== key) return;
    doneMap = v || {};
    renderWait(); maybeAdvance();
  });
}
function stopDone() {
  if (doneUnsub) { try { doneUnsub(); } catch {} }
  doneUnsub = null; doneKey = null; doneMap = {};
}

function renderWait() {
  if (!state || state.phase !== 'play') return;
  const box = $('waitList'); box.textContent = '';
  const ids = state.order || [];
  let n = 0;
  for (const id of ids) {
    const done = !!doneMap[id]; if (done) n++;
    const off = players[id] && players[id].online === false;
    box.append(el('span', 'chip' + (done ? ' done' : ''), (done ? '✓ ' : '… ') + nameOf(id) + (off ? '（いない）' : '')));
  }
  $('waitLead').textContent = `みんなを待っています（${n}/${ids.length}人）`;
  $('forceBtn').hidden = !isHost();
}
$('forceBtn').onclick = () => { if (confirm('まだの人がいても次へ進みますか？')) maybeAdvance(true); };

// 全員そろったか、時間を過ぎたら次のターンへ。誰が進めても1回だけ進むようトランザクションで守る。
async function maybeAdvance(force) {
  const s = state;
  if (!s || s.phase !== 'play' || advancing || !code) return;
  if (doneKey !== s.gid + ':' + s.round) return;
  if (!force) {
    const need = (s.order || []).filter(id => players[id] && players[id].online);
    const all = need.length > 0 && need.every(id => doneMap[id]);
    const late = api.now() > s.deadline + LATE_MS * SPEED;
    if (!all && !late) return;
  }
  advancing = true;
  try {
    await api.txn(`rooms/${code}/state`, cur => {
      if (cur === null) return null;
      if (cur.phase !== 'play' || cur.gid !== s.gid || cur.round !== s.round) return undefined;
      if (cur.round + 1 >= cur.rounds) return { ...cur, phase: 'reveal', chain: 0, step: 1, deadline: null };
      const next = cur.round + 1;
      const sec = next % 2 === 1 ? cur.drawSec : cur.textSec;
      return { ...cur, round: next, deadline: api.now() + sec * 1000 * SPEED };
    });
  } catch (e) { console.warn(e); }
  finally { advancing = false; }
}

function tick() {
  const s = state;
  if (!s || s.phase !== 'play' || !code) return;
  const leftMs = s.deadline - api.now();
  const total = (s.round === 0 ? PROMPT_SEC : (s.round % 2 === 1 ? s.drawSec : s.textSec)) * 1000 * SPEED;
  const left = Math.max(0, Math.ceil(leftMs / 1000));
  $('timer').textContent = left;
  $('timer').classList.toggle('low', left <= 10);
  $('timeFill').style.width = Math.max(0, Math.min(100, leftMs / total * 100)) + '%';
  if (task && !task.submitted && task.ready && leftMs <= 0) submit(true);
  maybeAdvance();
}

// ---- 結果発表 ----
async function renderReveal() {
  const s = state;
  if (!s || s.phase !== 'reveal') return;
  const order = s.order || [], N = order.length;
  const chainIdx = browseChain !== null ? browseChain : s.chain;
  const step = browseChain !== null ? s.rounds : s.step;
  show('reveal');
  $('revealCount').textContent = `結果発表 ${chainIdx + 1}/${N}`;
  $('revealTitle').textContent = `${nameOf(order[chainIdx])} さんのお題から`;
  renderRevealCtl();
  const key = s.gid + ':' + chainIdx;
  let data = revealCache[key];
  if (!data) {
    data = (await api.get(`${gamePath(s.gid)}/chains/${chainIdx}`)) || {};
    revealCache[key] = data;
  }
  // 待っている間に表示するチェーンが変わっていたら、新しいほうの呼び出しに任せる
  const nowIdx = browseChain !== null ? browseChain : (state && state.chain);
  if (!state || state.phase !== 'reveal' || state.gid !== s.gid || nowIdx !== chainIdx) return;
  const nowStep = browseChain !== null ? state.rounds : state.step;
  renderRevealList(data, chainIdx, nowStep, state, browseChain !== null);
}
function renderRevealList(data, chainIdx, step, s, browsing) {
  const list = $('revealList');
  const key = s.gid + ':' + chainIdx;
  let shown = list.dataset.key === key ? +list.dataset.step : 0;
  if (list.dataset.key !== key) list.textContent = '';
  const N = (s.order || []).length;
  let last = null;
  for (let i = shown; i < step && i < s.rounds; i++) {
    const e = data[i];
    const wrap = el('div', 'entry');
    const author = nameOf((e && e.by) || s.order[(chainIdx + i) % N]);
    const drawTurn = e ? e.t === 'draw' : i % 2 === 1;
    wrap.append(el('div', 'who', i === 0 ? `${author} のお題` : drawTurn ? `${author} が描いた絵` : `${author} の答え`));
    if (!usable(e)) {
      const b = el('div', 'bubble');
      b.append(el('span', 'miss', drawTurn ? '（白紙・時間切れ）' : '（時間切れで書けなかった）'));
      wrap.append(b);
    } else if (e.t === 'draw') {
      const cv = el('canvas', 'viewpad'); cv.width = cv.height = PAD;
      wrap.append(cv);
      animateStrokes(cv, parseStrokes(e.v), browsing ? 0 : 1600);
    } else {
      wrap.append(el('div', 'bubble' + (i === 0 ? ' first' : ''), e.v));
    }
    list.append(wrap);
    last = wrap;
  }
  list.dataset.key = key;
  list.dataset.step = String(Math.max(shown, Math.min(step, s.rounds)));
  if (last && !browsing) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (browsing) window.scrollTo({ top: 0 });
}
function renderRevealCtl() {
  const s = state;
  if (!s || s.phase !== 'reveal') return;
  const N = (s.order || []).length, host = isHost();
  const finished = s.chain >= N - 1 && s.step >= s.rounds;
  const nb = $('nextBtn');
  if (!finished) {
    nb.hidden = !host;
    nb.textContent = s.step < s.rounds ? 'つぎをめくる' : '次の人のお題へ ▶';
    $('revealNote').textContent = host ? '' : 'ホストが順番にめくります';
  } else {
    nb.hidden = true;
    $('revealNote').textContent = 'おしまい！ ほかの人のも見返せます';
  }
  $('browseBox').hidden = !finished;
  $('againBtn').hidden = !(finished && host);
}
$('nextBtn').onclick = () => withBusy($('nextBtn'), async () => {
  const s = state; if (!s || s.phase !== 'reveal') return;
  const N = (s.order || []).length;
  if (s.step < s.rounds) await api.update(`rooms/${code}/state`, { step: s.step + 1 });
  else if (s.chain < N - 1) await api.update(`rooms/${code}/state`, { chain: s.chain + 1, step: 1 });
});
function browse(d) {
  const N = (state.order || []).length;
  browseChain = (((browseChain !== null ? browseChain : state.chain) + d) % N + N) % N;
  renderReveal();
}
$('prevChainBtn').onclick = () => browse(-1);
$('nextChainBtn').onclick = () => browse(1);
$('againBtn').onclick = () => withBusy($('againBtn'), () =>
  api.set(`rooms/${code}/state`, { phase: 'lobby', host: (state && state.host) || pid }));

// ---- 絵 ----
function parseStrokes(v) {
  try {
    const a = JSON.parse(v);
    if (!Array.isArray(a)) return [];
    const out = [];
    for (const s of a.slice(0, 3000)) {
      if (!Array.isArray(s) || s.length < 3 || !Array.isArray(s[2])) continue;
      const c = Math.max(0, Math.min(COLORS.length - 1, s[0] | 0));
      const w = Math.max(0, Math.min(SIZES.length - 1, s[1] | 0));
      let p = s[2].slice(0, 20000).map(n => Math.max(-20, Math.min(PAD + 20, Math.round(+n || 0))));
      if (p.length % 2) p = p.slice(0, -1);
      if (p.length >= 2) out.push({ c, w, p });
    }
    return out;
  } catch { return []; }
}
function penStyle(ctx, s) {
  ctx.strokeStyle = ctx.fillStyle = COLORS[s.c];
  ctx.lineWidth = SIZES[s.w]; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
}
function drawStroke(ctx, s, n = s.p.length / 2) {
  if (n <= 0) return;
  penStyle(ctx, s);
  if (n === 1 || s.p.length === 2) {
    ctx.beginPath(); ctx.arc(s.p[0], s.p[1], SIZES[s.w] / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  ctx.beginPath(); ctx.moveTo(s.p[0], s.p[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(s.p[i * 2], s.p[i * 2 + 1]);
  ctx.stroke();
}
function drawStrokes(cv, strokes, budget = Infinity) {
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, PAD, PAD);
  let left = budget;
  for (const s of strokes) {
    if (left <= 0) break;
    const n = s.p.length / 2;
    drawStroke(ctx, s, Math.min(n, left));
    left -= n;
  }
}
// 描いた順に線を再生する（結果発表の演出）
function animateStrokes(cv, strokes, ms) {
  const total = strokes.reduce((a, s) => a + s.p.length / 2, 0);
  if (!ms || !total) { drawStrokes(cv, strokes); return; }
  const t0 = performance.now();
  const frame = t => {
    const k = Math.min(1, (t - t0) / ms);
    drawStrokes(cv, strokes, Math.ceil(total * k));
    if (k < 1 && cv.isConnected) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

class Pad {
  constructor(cv) {
    this.cv = cv; this.ctx = cv.getContext('2d');
    this.strokes = []; this.cur = null; this.color = 0; this.size = 1;
    cv.addEventListener('pointerdown', e => this.down(e));
    cv.addEventListener('pointermove', e => this.move(e));
    cv.addEventListener('pointerup', e => this.up(e));
    cv.addEventListener('pointercancel', e => this.up(e));
    this.redraw();
  }
  pos(e) {
    const r = this.cv.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) * PAD / r.width), Math.round((e.clientY - r.top) * PAD / r.height)];
  }
  down(e) {
    if (this.cur) return;
    e.preventDefault();
    try { this.cv.setPointerCapture(e.pointerId); } catch {}
    this.pointer = e.pointerId;
    const [x, y] = this.pos(e);
    this.cur = { c: this.color, w: this.size, p: [x, y] };
    this.strokes.push(this.cur);
    drawStroke(this.ctx, this.cur);
  }
  move(e) {
    if (!this.cur || e.pointerId !== this.pointer) return;
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const ev of (evs.length ? evs : [e])) {
      const [x, y] = this.pos(ev), p = this.cur.p;
      const lx = p[p.length - 2], ly = p[p.length - 1];
      if (Math.abs(x - lx) + Math.abs(y - ly) < 2) continue;
      p.push(x, y);
      penStyle(this.ctx, this.cur);
      this.ctx.beginPath(); this.ctx.moveTo(lx, ly); this.ctx.lineTo(x, y); this.ctx.stroke();
    }
  }
  up(e) { if (this.cur && e.pointerId === this.pointer) this.cur = null; }
  undo() { this.cur = null; this.strokes.pop(); this.redraw(); }
  clearAll() { this.cur = null; this.strokes = []; this.redraw(); }
  redraw() { drawStrokes(this.cv, this.strokes); }
  // 送るときの形: [[色, 太さ, [x,y,x,y,...]], ...]。大きすぎたら点を間引く。
  serialize() {
    let strokes = this.strokes.map(s => [s.c, s.w, s.p.slice()]);
    let out = JSON.stringify(strokes);
    for (let i = 0; i < 6 && out.length > 200000; i++) {
      strokes = strokes.map(([c, w, p]) => {
        const q = [];
        for (let j = 0; j < p.length; j += 4) q.push(p[j], p[j + 1]);
        if (p.length >= 4) q.push(p[p.length - 2], p[p.length - 1]);
        return [c, w, q];
      });
      out = JSON.stringify(strokes);
    }
    while (out.length > 200000 && strokes.length) { strokes.pop(); out = JSON.stringify(strokes); }
    return out;
  }
}
const pad = new Pad($('pad'));

(function buildTools() {
  const colorBox = $('colorTools');
  COLORS.forEach((c, i) => {
    const b = el('button', 'sw' + (i === 0 ? ' on' : ''));
    b.style.background = c;
    b.setAttribute('aria-label', i === COLORS.length - 1 ? '消しゴム' : '色');
    if (i === COLORS.length - 1) { b.textContent = '消'; b.style.fontSize = '12px'; b.style.color = '#7a6f63'; }
    b.onclick = () => { pad.color = i; colorBox.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === b)); };
    colorBox.append(b);
  });
  const sizeBox = $('sizeTools');
  SIZES.forEach((s, i) => {
    const b = el('button', 'sz' + (i === 1 ? ' on' : ''));
    b.setAttribute('aria-label', '太さ');
    const dot = el('i'); const d = Math.max(4, Math.min(26, s)); dot.style.width = dot.style.height = d + 'px';
    b.append(dot);
    b.onclick = () => { pad.size = i; sizeBox.querySelectorAll('.sz').forEach(x => x.classList.toggle('on', x === b)); };
    sizeBox.append(b);
  });
  $('undoBtn').onclick = () => pad.undo();
  $('clearBtn').onclick = () => { if (!pad.strokes.length || confirm('ぜんぶ消しますか？')) pad.clearAll(); };
})();

// テスト用の入口（遊ぶ人には関係ない）
window.__rakugaki = {
  get pid() { return pid; },
  get code() { return code; },
  get state() { return state; },
  get task() { return task && { ...task }; },
  get strokes() { return pad.strokes.length; },
};

boot();
