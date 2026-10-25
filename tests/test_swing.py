"""5（ぶらんこジャンプ）を Edge で実際に動かして確かめるテスト。

使い方: python tests/test_swing.py  （class-games フォルダで実行）
確かめること:
  1. 実際のマウス操作（おす→はなす）でロープがのびて、ぶら下がり、外れるか
  2. ロープがのびる道すじに岩があると、使えなくなるか
  3. 島（ジャンプ台）をふむと上にはねるか
  4. ステージ1〜30がぜんぶ作れて、ゴールがあるか（部品の数・島の数も表示）
  5. エンドレスを自動プレイで長く動かして、エラーが出ないか
「クリアできるか」の確認は tests/solve_swing.py（時間がかかる）でやる。
スクリーンショットは tests/shots/ に保存される。
"""
import functools, http.server, io, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)
PORT = 8791

CHECKS = """
() => {
  __swing.mute(true); const out = {};
  // 2) 道すじに岩
  __swing.startCustom(['plain'], 0.1, 1);
  const W = __swing.world(), s = __swing.state;
  W.blocks.push({x: s.x + 120, y: 60, w: 40, h: 250});
  out.blockedAim = __swing.aimInfo().st;
  __swing.press(); let f = 0; while (__swing.state.shooting && f < 60) { __swing.tick(1); f++; }
  out.blockedRoped = __swing.state.roped;
  // 3) ジャンプ台
  __swing.startCustom(['plain', 'pad', 'plain'], 0.1, 1);
  const pad = __swing.world().plats.find(p => p.kind === 'pad');
  __swing.restore(JSON.stringify({P:{x:pad.x+80, y:pad.top-120, vx:0, vy:200, grounded:false}, platIdx:-1, blockIdx:-1,
    rope:null, t:0, phase:'play', maxX:300, holding:false, pressTimer:0, deadTimer:0}));
  let minY = 1e9, bounced = false, pv = null;
  for (let i = 0; i < 120; i++) { __swing.tick(1); const q = __swing.state; if (pv !== null && pv > 0 && q.vy < -500) bounced = true; pv = q.vy; minY = Math.min(minY, q.y); }
  out.padBounced = bounced; out.padApex = Math.round(minY); out.padTop = pad.top;
  // 4) ステージ1〜30
  out.stages = [];
  for (let n = 1; n <= 30; n++) {
    __swing.start('stage', n); const w = __swing.world();
    out.stages.push({n, name: __swing.stageDef(n).name, goal: Math.round((w.goalX-130)/40), pads: w.plats.filter(p=>p.kind==='pad').length,
      spikes: w.spikes.length, blocks: w.blocks.length, gaps: w.gaps.length});
  }
  return out;
}
"""

# 自動プレイ: 高い所に来たらロープ、前に振れたら離す
BOT = """
(o) => {
  __swing.mute(true); __swing.start('endless');
  let f = 0, ropeF = 0, rel = 0.5;
  while (f < o.frames && __swing.state.phase === 'play') {
    const s = __swing.state;
    if (!s.roped && !s.shooting && (s.grounded || (s.vy > -50 && s.y > 120 && s.y < 340)) && __swing.aimInfo().st === 'ok') __swing.press();
    else if (s.roped) { ropeF++; if ((s.x - s.ax > s.ropeL * rel && s.vy < 0) || ropeF > 120) { __swing.release(); ropeF = 0; rel = 0.2 + Math.random() * 0.5; } }
    __swing.tick(1);
    if (!__swing.state.roped && !__swing.state.shooting) __swing.release();
    f++;
  }
  return {frames: f, dist: __swing.state.dist, phase: __swing.state.phase};
}
"""


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    srv = serve()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
        page.goto(f"http://127.0.0.1:{PORT}/swing/")
        page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / "swing_menu.png"))

        # 1. 実際の操作
        page.click("#endlessBtn")
        page.wait_for_timeout(200)
        box = page.locator("#cv").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.wait_for_timeout(450)
        held = page.evaluate("__swing.state")
        page.screenshot(path=str(SHOTS / "swing_roped.png"))
        page.mouse.up()
        page.wait_for_timeout(100)
        released = page.evaluate("__swing.state")
        print(f"[操作] おして0.45秒後 roped={held['roped']}  はなした後 roped={released['roped']}")
        assert held["roped"] and not released["roped"], "おす→ロープ、はなす→外れ、になっていない"

        # 2〜4
        c = page.evaluate(CHECKS)
        print(f"[岩] 道すじに岩 → ねらいの判定={c['blockedAim']}  ロープがついた={c['blockedRoped']}")
        assert c["blockedAim"] == "blocked" and not c["blockedRoped"], "岩にふさがれてもロープが使えてしまう"
        print(f"[島] ジャンプ台ではねた={c['padBounced']}  いちばん高い所 y={c['padApex']}（島のてっぺん y={c['padTop']}）")
        assert c["padBounced"] and c["padApex"] < c["padTop"] - 150, "島をふんでもはねない"
        for s in c["stages"]:
            assert s["goal"] > 0, f"ステージ{s['n']}にゴールがない"
        print("[ステージ] 番号 名前 ゴールまでm 島 トゲ 岩 穴")
        for s in c["stages"][:14]:
            print(f"   {s['n']:>2} {s['name']:<8} {s['goal']:>4}m 島{s['pads']} トゲ{s['spikes']} 岩{s['blocks']} 穴{s['gaps']}")
        print(f"   …ステージ30まで作成できた（ゴール {c['stages'][-1]['goal']}m）")

        # 5. エンドレスの自動プレイ
        res = [page.evaluate(BOT, {"frames": 60 * 150}) for _ in range(6)]
        print("[エンドレス自動プレイ] " + " / ".join(f"{r['dist']}m({r['phase']})" for r in res))

        # 画面の写真
        page.evaluate("__swing.start('stage', 8)")
        page.evaluate("__swing.tick(30)")
        page.wait_for_timeout(100)
        page.screenshot(path=str(SHOTS / "swing_stage8.png"))
        page.evaluate("__swing.start('stage', 5)")
        page.evaluate("__swing.tick(5)")
        page.wait_for_timeout(100)
        page.screenshot(path=str(SHOTS / "swing_stage5.png"))
        browser.close()
    srv.shutdown()
    print("エラー:", errors if errors else "なし")


if __name__ == "__main__":
    main()
