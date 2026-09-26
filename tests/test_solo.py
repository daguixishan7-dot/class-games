"""3（スキマうめ）と4（体育倉庫）を Edge で実際に動かして確かめるテスト。

使い方: python tests/test_solo.py  （class-games フォルダで実行）
スクリーンショットは tests/shots/ に保存される。
"""
import functools, http.server, io, random, sys, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)
PORT = 8765


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def new_page(browser, errors):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    return page


def test_blocks(browser):
    errors = []
    page = new_page(browser, errors)
    page.goto(f"http://127.0.0.1:{PORT}/blocks/")
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "blocks_start.png"))
    box = page.locator("#cv").bounding_box()
    moves = cleared_total = 0
    for _ in range(80):
        st = page.evaluate("__sukima.state")
        if st["over"]:
            break
        g = page.evaluate("__sukima.geom()")
        # 置ける場所を1つ探す（できれば列が消える場所を優先）
        choice = page.evaluate("""() => {
          const s = __sukima.state; let bestMove = null;
          s.tray.forEach((p, i) => { if (!p) return;
            for (let r=0;r<=8-p.rows;r++) for (let c=0;c<=8-p.cols;c++) {
              if (!__sukima.canPlace(p, r, c)) continue;
              const g2 = s.grid.map(row=>row.slice()); for (const [dr,dc] of p.cells) g2[r+dr][c+dc]=1;
              let lines=0; for (let k=0;k<8;k++){ if (g2[k].every(Boolean)) lines++; if (g2.every(row=>row[k])) lines++; }
              if (!bestMove || lines > bestMove.lines) bestMove = {i, r, c, rows:p.rows, cols:p.cols, lines};
            }});
          return bestMove; }""")
        if not choice:
            break
        before = st["score"]
        sx = box["x"] + g["bx"] + g["slotW"] * choice["i"] + g["slotW"] / 2
        sy = box["y"] + g["slotY"] + g["slotH"] / 2
        tx = box["x"] + g["bx"] + choice["c"] * g["cell"] + choice["cols"] * g["cell"] / 2
        ty = box["y"] + g["by"] + choice["r"] * g["cell"] + choice["rows"] * g["cell"] / 2
        page.mouse.move(sx, sy)
        page.mouse.down()
        page.mouse.move((sx + tx) / 2, (sy + ty) / 2, steps=4)
        page.mouse.move(tx, ty, steps=4)
        if moves == 3:
            page.screenshot(path=str(SHOTS / "blocks_dragging.png"))
        page.mouse.up()
        page.wait_for_timeout(60)
        after = page.evaluate("__sukima.state")["score"]
        assert after > before, f"置いたのに点が増えない: {before} -> {after} ({choice})"
        moves += 1
        cleared_total += choice["lines"]
        if moves == 12:
            page.screenshot(path=str(SHOTS / "blocks_mid.png"))
    page.wait_for_timeout(1200)
    st = page.evaluate("__sukima.state")
    over_shown = page.evaluate("document.getElementById('over').classList.contains('show')")
    page.screenshot(path=str(SHOTS / "blocks_end.png"))
    # 再読み込みで続きから遊べるか
    page.reload(); page.wait_for_timeout(400)
    st2 = page.evaluate("__sukima.state")
    print(f"[blocks] 置いた回数={moves} 消した列の合計={cleared_total} 最終スコア={st['score']} "
          f"おしまい表示={over_shown} 再読み込み後スコア={st2['score']}")
    return errors


def test_merge(browser):
    errors = []
    page = new_page(browser, errors)
    page.goto(f"http://127.0.0.1:{PORT}/merge/")
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "merge_start.png"))
    box = page.locator("#cv").bounding_box()
    w = page.evaluate("__soko.world()")
    rnd = random.Random(7)
    drops = 0
    flew = 0  # 枠の上に飛び出したボールを見かけた回数
    for i in range(140):
        st = page.evaluate("__soko.state")
        flew += sum(1 for b in st["balls"] if b["y"] + b["r"] < 0)
        if st["over"]:
            break
        if not st["held"]:
            page.wait_for_timeout(120)
            continue
        wx = rnd.uniform(20, w["W"] - 20)
        sx = box["x"] + w["ox"] + wx * w["scale"]
        sy = box["y"] + w["oy"] + 40 * w["scale"]
        page.mouse.click(sx, sy)
        drops += 1
        page.wait_for_timeout(520)
        if drops == 25:
            page.screenshot(path=str(SHOTS / "merge_mid.png"))
    page.wait_for_timeout(1500)
    st = page.evaluate("__soko.state")
    page.screenshot(path=str(SHOTS / "merge_end.png"))
    # 物理が壊れていないか: 枠の外や重なりすぎがないか
    bad = [b for b in st["balls"] if b["x"] < b["r"] - 1 or b["x"] > w["W"] - b["r"] + 1 or b["y"] > w["H"] - b["r"] + 1]
    overlaps = 0
    bs = st["balls"]
    for a in range(len(bs)):
        for b in range(a + 1, len(bs)):
            A, B = bs[a], bs[b]
            d = ((A["x"] - B["x"]) ** 2 + (A["y"] - B["y"]) ** 2) ** 0.5
            if d < (A["r"] + B["r"]) * 0.85:
                overlaps += 1
    print(f"[merge] 落とした回数={drops} 残りボール={st['n']} スコア={st['score']} "
          f"最大レベル={st['gameMaxLv']} おしまい={st['over']} 枠外={len(bad)} 大きな重なり={overlaps} 飛び出し={flew}")
    return errors


def main():
    srv = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        errs = test_blocks(browser) + test_merge(browser)
        browser.close()
    srv.shutdown()
    print("エラー:", errs if errs else "なし")


if __name__ == "__main__":
    main()
