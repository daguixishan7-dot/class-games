"""ぶらんこジャンプの「クリアできるか」を、ロボットが先読みして調べる。

使い方（class-games フォルダで）:
  python tests/solve_swing.py stages 1 2 3      # ステージ番号を指定
  python tests/solve_swing.py secs              # コースの部品ごとに、むずかしい設定で調べる
やり方: ロープをつけて離すタイミングを何通りも試し、ゴールに着地できる手順を探す（ビーム探索）。
「手順あり」ならクリアできると言える。「なし」は探索が粗いだけのこともあるので、不可能とは言い切れない。
"""
import sys, io, functools, http.server, threading, json, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from playwright.sync_api import sync_playwright
from pathlib import Path
ROOT=str(Path(__file__).resolve().parent.parent)
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message=lambda *a,**k:None
srv=http.server.ThreadingHTTPServer(("127.0.0.1",8792),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
JS="""
(o) => {
  __swing.mute(true);
  if (o.secs) __swing.startCustom(o.secs, o.d, o.seed); else __swing.start('stage', o.n);
  const goalX = __swing.world().goalX;
  const T = (k) => { for (let i=0;i<k && __swing.state.phase==='play';i++) __swing.tick(1); };
  let beam = [__swing.snap()], depth = 0, win = false, best = 0;
  const t0 = Date.now();
  while (beam.length && depth < o.maxDepth && !win && Date.now()-t0 < o.ms){
    const next = new Map();
    for (const snap of beam){
      for (const w of [0, 6, 12, 20, 32, 48]){
        if (win) break;
        __swing.restore(snap);
        if (w > 0){ if (__swing.state.grounded) continue; __swing.release(); T(w); if (__swing.state.phase!=='play') continue; }
        __swing.release();
        if (__swing.aimInfo().st !== 'ok') continue;
        __swing.press();
        for (let k = 1; k <= 160 && !win; k++){
          T(1);
          const s0 = __swing.state;
          if (s0.phase === 'over'){ win = true; break; }
          if (s0.phase !== 'play') break;
          if (k >= 8 && k % 3 === 0 && s0.roped){
            const pre = __swing.snap();
            __swing.release(); T(2);
            const s = __swing.state;
            if (s.phase === 'over'){ win = true; break; }
            if (s.phase === 'play' && !(s.y > 505 && !s.grounded)){
              best = Math.max(best, s.x);
              const key = Math.round(s.x/30)+':'+Math.round(s.y/30)+':'+Math.round(s.vx/90)+':'+Math.round(s.vy/90);
              if (!next.has(key)) next.set(key, {score:s.x + (400 - s.y)*0.7, snap:__swing.snap()});
            }
            __swing.restore(pre);
          }
        }
      }
      if (win) break;
    }
    const arr = [...next.values()].sort((a,b)=>b.score-a.score);
    const top = arr.slice(0, o.beam), rest = arr.slice(o.beam).sort(()=>Math.random()-.5).slice(0, o.extra);
    beam = top.concat(rest).map(x=>x.snap);
    depth++;
  }
  return {win, depth, best: Math.round((best-130)/40), goal: Math.round((goalX-130)/40), ms: Date.now()-t0};
}
"""
args=sys.argv[1:]
with sync_playwright() as p:
    b=p.chromium.launch(channel="msedge",headless=True); pg=b.new_page()
    pg.goto("http://127.0.0.1:8792/swing/")
    base={"maxDepth":60,"beam":70,"extra":30,"ms":90000}
    if args and args[0]=="stages":
        for n in [int(a) for a in args[1:]]:
            r=pg.evaluate(JS,dict(base,n=n)); nm=pg.evaluate(f"__swing.stageDef({n}).name")
            print(f"ステージ{n}「{nm}」: {'クリア手順あり' if r['win'] else 'なし'}  深さ{r['depth']} 到達{r['best']}m/ゴール{r['goal']}m ({r['ms']//1000}秒)", flush=True)
    elif args and args[0]=="secs":
        names=pg.evaluate("__swing.secNames()")
        for nm in names:
            for d in (0.5,1.0):
                oks=[]
                for seed in (1,2,3):
                    r=pg.evaluate(JS,dict(base,secs=['plain',nm,'plain'],d=d,seed=seed,ms=30000)); oks.append(r['win'])
                print(f"部品 {nm:11s} d={d}: " + " ".join('○' if o else '×' for o in oks), flush=True)
    b.close()
