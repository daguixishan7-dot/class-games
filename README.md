# クラスのゲーム

クラスメートがスマホのブラウザで遊べるゲーム3つ。登録もダウンロードもいらない。

| フォルダ | ゲーム | 人数 | 必要なもの |
|---|---|---|---|
| `blocks/` | スキマうめ（ブロックを置いて列を消す） | 1人 | なし |
| `merge/` | 体育倉庫（同じボールをぶつけて合体） | 1人 | なし |
| `draw/` | らくがき伝言（お題 → 絵 → 答え…の伝言ゲーム） | 2人〜 | Firebase（無料） |

スコアやベスト記録は、それぞれのスマホの中（localStorage）にだけ保存される。

## 自分のPCで試す

```
cd class-games
python -m http.server 8000
```

ブラウザで http://localhost:8000/ を開く。

らくがき伝言は、Firebase の設定がなくても `http://localhost:8000/draw/?mock` で動きを試せる。
同じブラウザでタブを何枚か開くと、タブ同士が別の参加者になる（テスト用のにせデータベース）。

## テスト

Edge を自動で動かして確かめる。Playwright を入れた Python で実行する。

```
C:\Users\81909\.venvs\class-games\Scripts\python.exe tests\test_solo.py   # スキマうめ・体育倉庫
C:\Users\81909\.venvs\class-games\Scripts\python.exe tests\test_draw.py   # らくがき伝言（3人ぶん）
```

画面の写真は `tests/shots/` に保存される（git には入れない）。

## らくがき伝言を動かす準備（Firebase）

みんなのスマホをつなぐために Firebase Realtime Database を使う。
無料プラン（Spark）で、支払い方法の登録はいらない。
上限は同時接続100人・保存1GB・ダウンロード月10GB（https://firebase.google.com/pricing ）。

Firebase の画面のボタン名は変わることがあるので、下の名前は目安。

1. https://console.firebase.google.com を Google アカウントで開き、プロジェクトを作る（Google アナリティクスはオフでよい）
2. 左のメニューの「Realtime Database」→「データベースを作成」
   - 場所は **シンガポール（asia-southeast1）** が日本から一番近い。あとから変えられない
   - 「ロックモード」で始めてよい（次の手順でルールを入れる）
3. 「ルール」タブを開き、中身を `database.rules.json` の中身に置きかえて「公開」
4. プロジェクトの設定（歯車）→「マイアプリ」→ ウェブ（`</>`）のアプリを追加
5. 表示された `firebaseConfig = { ... }` の中身を、`draw/firebase-config.js` の `null` と置きかえる
   - `databaseURL` が入っていることを確かめる。無ければ Realtime Database の画面の上に出ている URL を足す

Firebase の API キーは秘密にしなくてよい（公式: https://firebase.google.com/docs/projects/api-keys ）。
データを守るのはルール（`database.rules.json`）の役目。

### データの片づけ

部屋のデータは `rooms/合言葉` の下にたまっていく。
容量が気になったら、Firebase の画面の「データ」タブで `rooms` を消せば全部消える。
ゲーム中の部屋も消えるので、誰も遊んでいないときに消すこと。

## 公開（GitHub Pages）

このフォルダを GitHub の公開リポジトリに入れて、Pages を main ブランチの `/`（ルート）から公開する。
URL は `https://<GitHubのユーザー名>.github.io/<リポジトリ名>/` になる。
