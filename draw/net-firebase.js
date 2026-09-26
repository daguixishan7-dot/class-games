// Firebase Realtime Database とのやりとり。app.js からはこの関数群だけを使う。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getDatabase, ref, onValue, get, set, update, remove, runTransaction, onDisconnect,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

export function connectFirebase(config) {
  const app = initializeApp(config);
  const db = getDatabase(app);
  let offset = 0;
  onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  return {
    // サーバーの時計に合わせた現在時刻（全員の制限時間をそろえるため）
    now: () => Date.now() + offset,
    on(path, cb) {
      return onValue(ref(db, path), s => cb(s.val()), err => console.warn('読み込めません', path, err));
    },
    async get(path) { return (await get(ref(db, path))).val(); },
    set: (path, v) => set(ref(db, path), v),
    update: (path, v) => update(ref(db, path), v),
    remove: path => remove(ref(db, path)),
    async txn(path, fn) {
      const r = await runTransaction(ref(db, path), fn);
      return { committed: r.committed, value: r.snapshot.val() };
    },
    onDisconnectSet: (path, v) => onDisconnect(ref(db, path)).set(v),
    onConnected(cb) { return onValue(ref(db, '.info/connected'), s => cb(!!s.val())); },
  };
}
