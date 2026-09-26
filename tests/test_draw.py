"""7（らくがき伝言）を、にせのデータベース（?mock）で3人ぶん動かして確かめるテスト。

1回目: 3人が全員まじめに遊ぶ（お題 → 絵 → 答え → 結果発表 → もう一回）
2回目: 1人が時間切れになり、そのあと途中で抜ける
使い方: python tests/test_draw.py  （class-games フォルダで実行）
"""
import functools, http.server, io, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)
PORT = 8766
BASE = f"http://127.0.0.1:{PORT}/draw/"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def active(page, name, timeout=15000):
    page.wait_for_selector(f"#s-{name}.active", timeout=timeout)


def scribble(page, seed):
    box = page.locator("#pad").bounding_box()
    x0, y0, w = box["x"], box["y"], box["width"]
    for k in range(3):
        page.mouse.move(x0 + w * (0.2 + 0.2 * k), y0 + w * (0.2 + 0.05 * seed))
        page.mouse.down()
        for j in range(4):
            page.mouse.move(x0 + w * (0.25 + 0.2 * k + 0.04 * j), y0 + w * (0.3 + 0.14 * j))
        page.mouse.up()


def main():
    srv = serve()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        names = ["あおい", "ひかり", "そうた"]
        pages = []
        for i in range(3):
            pg = ctx.new_page()
            pg.on("pageerror", lambda e, i=i: errors.append(f"[{names[i]}] pageerror: {e}"))
            pg.on("console", lambda m, i=i: m.type == "error" and errors.append(f"[{names[i]}] console: {m.text}"))
            pg.on("dialog", lambda d: d.accept())
            pages.append(pg)
        A, B, C = pages

        # 部屋をつくる・入る
        A.goto(BASE + "?mock&fast")
        active(A, "home")
        A.fill("#nameIn", names[0]); A.click("#createBtn")
        active(A, "lobby")
        code = A.evaluate("__rakugaki.code")
        for pg, nm in [(B, names[1]), (C, names[2])]:
            pg.goto(BASE + f"?room={code}&mock&fast")
            active(pg, "home")
            assert pg.input_value("#codeIn") == code, "招待リンクで合言葉が入っていない"
            pg.fill("#nameIn", nm); pg.click("#joinBtn")
            active(pg, "lobby")
        A.wait_for_function("document.getElementById('countNote').textContent === '3人'")
        A.screenshot(path=str(SHOTS / "draw_lobby.png"))
        host_btn_hidden_for_B = B.evaluate("document.getElementById('startBtn').hidden")
        print(f"[1回目] 合言葉={code} Bにスタートボタンが出ない={host_btn_hidden_for_B}")

        # ===== 1回目: 全員が遊ぶ =====
        A.click("#startBtn")
        prompts = ["空を飛ぶペンギン", "購買のパン争奪戦", "寝ぐせの先生"]
        for pg, t in zip(pages, prompts):
            active(pg, "text"); pg.fill("#textIn", t); pg.click("#textSubmit")
        for i, pg in enumerate(pages):
            try:
                active(pg, "draw")
            except Exception:
                for j, q in enumerate(pages):
                    info = q.evaluate("({screen: document.querySelector('.screen.active')?.id, task: __rakugaki.task, "
                                      "round: __rakugaki.state && __rakugaki.state.round, phase: __rakugaki.state && __rakugaki.state.phase})")
                    print(f"  [{names[j]}] {info}")
                    q.screenshot(path=str(SHOTS / f"debug_{j}.png"))
                raise
            if i == 0:
                prompt_seen = pg.inner_text("#drawPrompt")
            scribble(pg, i)
            if i == 0:
                pg.screenshot(path=str(SHOTS / "draw_drawing.png"))
            info = pg.evaluate("({screen: document.querySelector('.screen.active')?.id, task: __rakugaki.task, "
                               "left: __rakugaki.state && (__rakugaki.state.deadline - Date.now()), strokes: __rakugaki.strokes, "
                               "btn: (() => { const r = document.getElementById('drawSubmit').getBoundingClientRect(); return [r.top, r.height, innerHeight]; })()})")
            print(f"  [{names[i]}] 押す前: {info}")
            pg.click("#drawSubmit", timeout=5000)
        print(f"[1回目] Aが見たお題: {prompt_seen.replace(chr(10), ' / ')}")
        guesses = ["ペンギン？", "パン？", "先生？"]
        for pg, g in zip(pages, guesses):
            active(pg, "text")
            pg.wait_for_selector("#textShow canvas", timeout=5000)
            pg.fill("#textIn", g); pg.click("#textSubmit")
        B.screenshot(path=str(SHOTS / "draw_wait.png"))
        for pg in pages:
            active(pg, "reveal")
        st = A.evaluate("__rakugaki.state")
        rounds, n = st["rounds"], len(st["order"])
        clicks = 0
        while True:
            A.wait_for_selector("#nextBtn", state="attached")
            if A.evaluate("document.getElementById('nextBtn').hidden"):
                break
            A.click("#nextBtn"); clicks += 1
            A.wait_for_timeout(250)
            if clicks > 30:
                raise AssertionError("結果発表が終わらない")
        B.wait_for_timeout(1800)  # 絵の再生アニメーションを待つ
        b_entries = B.locator("#revealList .entry").count()
        B.screenshot(path=str(SHOTS / "draw_reveal.png"), full_page=True)
        again_visible = A.is_visible("#againBtn")
        browse_visible = B.is_visible("#browseBox")
        t1 = B.inner_text("#revealTitle"); B.click("#nextChainBtn"); B.wait_for_timeout(400); t2 = B.inner_text("#revealTitle")
        print(f"[1回目] ターン数={rounds} 人数={n} めくった回数={clicks} Bの画面の項目数={b_entries} "
              f"もう一回ボタン(ホスト)={again_visible} 見返しボタン(B)={browse_visible} 見返しで切りかわる={t1 != t2}")
        A.click("#againBtn")
        for pg in pages:
            active(pg, "lobby")
        print("[1回目] もう一回 → 全員が待合室にもどった")

        # ===== 2回目: 時間切れと途中で抜ける人 =====
        A.click("#startBtn")
        for pg in (A, B):
            active(pg, "text"); pg.fill("#textIn", "テスト"); pg.click("#textSubmit")
        active(C, "text")
        # Cは何もしない → 時間切れで自動送信されるはず
        C.wait_for_selector("#s-wait.active, #s-draw.active", timeout=15000)
        auto_ok = C.evaluate("__rakugaki.task && __rakugaki.task.round >= 0")
        for pg in (A, B):
            active(pg, "draw")
        C.close()  # 描く番の途中で抜ける
        A.wait_for_timeout(300)
        for i, pg in enumerate((A, B)):
            scribble(pg, i); pg.click("#drawSubmit")
        for pg in (A, B):
            active(pg, "text", timeout=20000)
            pg.fill("#textIn", "わからん"); pg.click("#textSubmit")
        for pg in (A, B):
            active(pg, "reveal", timeout=20000)
        clicks = 0
        while not A.evaluate("document.getElementById('nextBtn').hidden"):
            A.click("#nextBtn"); clicks += 1; A.wait_for_timeout(200)
            if clicks > 30:
                raise AssertionError("2回目の結果発表が終わらない")
        misses = []
        for k in range(3):
            A.click("#nextChainBtn"); A.wait_for_timeout(300)
            misses.append(A.locator("#revealList .miss").count())
        A.screenshot(path=str(SHOTS / "draw_reveal_missing.png"), full_page=True)
        print(f"[2回目] Cは時間切れで自動送信された={auto_ok} Cが抜けても最後まで進んだ=True "
              f"チェーンごとの「時間切れ」表示数={misses}")
        browser.close()
    srv.shutdown()
    print("エラー:", errors if errors else "なし")


if __name__ == "__main__":
    main()
