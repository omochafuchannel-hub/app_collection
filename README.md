# PIXEL TOWN

「街そのものがメニューになっているゲーム風ホームページ」

HTML / CSS / JavaScript（ES6+）のみで動作する、ビルド不要のゲーム風ホームページです。
Canvasで描かれたドット絵風の街を歩き回り、5つの建物のドアに近づいてクリック（タップ）すると、
ゲーム風の確認ウィンドウが開き、「はい」を選ぶと対応するURLへ移動します。

GitHub Pagesにそのままアップロードするだけで動作します（Node.js / ビルド不要）。

---

## 遊び方

- **PC**: `W A S D` または矢印キーで移動。建物のドアに近づくと画面左上のヒントが変わります。
  ドアをクリック、または `Enter` / `Space` / `E` キーで会話ウィンドウを開きます。
- **スマホ**: 画面左下の仮想スティックで移動。ドアに近づくと「ドアをタップ」と表示されるので、
  ドアをタップしてください。
- タイトル画面では街をゆっくり横移動するデモが流れます。キー操作・タップ・クリックのいずれかで
  ゲームが始まります。

---

## リンク先の変更方法

`script.js` の先頭にある5つの変数を書き換えるだけで、各建物の遷移先を変更できます。

```js
const softwareURL = "https://example.com/software"; // ①ソフトウェアエンジニアリング
const musicURL    = "https://example.com/music";    // ②音楽
const toyURL      = "https://example.com/toys";     // ③ブロック（おもちゃ）
const podcastURL  = "https://example.com/podcast";  // ④ポッドキャスト
const gameURL      = "https://example.com/games";    // ⑤ゲーム
```

画面下部の「アクセシビリティ用フォールバックリンク（`#building-links`）」も、この変数から
自動的にURLが設定されるため、修正箇所は上記5つの変数だけで済みます。

---

## ファイル構成

```
townsite/
├── index.html          # エントリーポイント（Canvas / UI要素 / a11yフォールバック）
├── style.css            # 見た目（レトロJRPG風UI、レスポンシブ対応）
├── script.js            # ゲーム本体（下記「コード設計」を参照）
├── README.md
└── assets/
    ├── images/
    │   ├── sprites/      # 今後、プレイヤーやNPCの画像スプライトを追加する場合はここに
    │   ├── tiles/         # 道路・地面などのタイル画像
    │   ├── buildings/     # 建物の画像素材
    │   ├── vehicles/      # 車・バスの画像素材
    │   ├── characters/    # NPC・動物の画像素材
    │   └── effects/       # パーティクル・エフェクト用画像
    │   └── ui/            # ダイアログ枠やアイコンなどのUI画像
    ├── bgm/               # BGM（mp3等）を配置。AudioManager.loadBGM() で読み込み
    └── se/                # 効果音を配置。AudioManager.loadSE() で読み込み
```

> 現バージョンは、画像アセットを使わずCanvasの図形描画のみで
> ドット絵風の街・建物・キャラクターを表現しています。
> 上記フォルダに画像を追加し、`Image` オブジェクトで読み込むよう
> 各 `draw()` メソッドを差し替えれば、スプライト画像を使った表現に拡張できます。

---

## コード設計（クラス構成）

ゲームエンジン的な構成でクラス分けしています（`script.js` 内、上から順に定義）。

| クラス | 役割 |
|---|---|
| `Utils` | 汎用関数（clamp, lerp, rand, 当たり判定など） |
| `AudioManager` | BGM / SE の再生管理。ファイルが無くてもエラーにならず無音で動作 |
| `InputManager` | キーボード・マウス・タッチ・仮想スティックの入力を統合 |
| `Camera` | ワールド座標→スクリーン座標の変換、プレイヤー追従、タイトルのデモ移動 |
| `Building` | 5つの建物（ビル・ライブハウス・ゲーセン・ラジオ局・おもちゃ屋）の描画とドア演出 |
| `Player` | プレイヤーキャラクターの移動・向き・アニメーション |
| `NPC` | 通行人・犬・猫のランダム移動AI |
| `Vehicle` | 車・バスの往復移動（道路上のみ） |
| `CloudField` / `BirdFlock` | 雲・鳥のパーティクル |
| `CollisionManager` | プレイヤーと建物の当たり判定（軸ごとに移動を試すスライド式） |
| `Dialog` | ドアクリック時のゲーム風確認ウィンドウ（はい/いいえ、キーボード操作対応） |
| `World` | 街のレイアウトデータ（道路・公園・街灯・木など）と全エンティティの更新/描画の統括 |
| `Game` | 状態管理（loading → title → playing）とメインループ、リサイズ処理 |

### 描画方式

内部解像度（`canvas.width/height`）を画面サイズより低く保ち（例: 高さ220前後）、
CSSで拡大表示することでドット絵らしい荒いピクセル感を出しています
（`image-rendering: pixelated` と `imageSmoothingEnabled = false` を併用）。
内部解像度は常に実際の画面アスペクト比に合わせて再計算されるため、
スマホ・PC・回転（縦横）のどの状態でも絵が歪みません。

キャラクターや建物、木などは `y座標`（画面上の奥行き）でソートしてから描画する
「疑似奥行き（Y-sort）」方式のため、前後関係が自然に表現されます。

---

## 拡張のヒント

- **昼夜切替 / 天候**: `World` に `timeOfDay` や `weather` の状態を持たせ、
  `drawSky()` のグラデーションや `_drawLamp()` の輝度、雨/雪の `Particle` クラスを
  追加するだけで対応できます。
- **建物追加**: `World` コンストラクタの `this.buildings` 配列に `Building` を1件追加し、
  `Building.draw()` 内の `switch` に描画パターンを追加してください。
- **NPC追加**: `this.npcs` の生成数（`Array.from({ length: 13 }, ...)`）を増やすだけです。
- **ミニゲーム / イベント**: `Game.state` に新しい状態（例: `"minigame"`）を追加し、
  `_update()` / `_draw()` に分岐を足す形で拡張できます。
- **BGM / 効果音**: `assets/bgm` と `assets/se` にファイルを置き、
  `Game` コンストラクタ内のコメントアウトされている
  `this.audio.loadBGM(...)` / `this.audio.loadSE(...)` の行を有効にしてください。

---

## GitHub Pagesへのアップロード

1. このフォルダの中身（`index.html` / `style.css` / `script.js` / `assets/` など）を
   リポジトリの直下（またはお好みのサブフォルダ）にそのままコミットします。
2. リポジトリの Settings → Pages で公開ブランチ・フォルダを指定します。
3. ビルドは不要です。公開されたURLにアクセスするとそのまま動作します。

---

## 対応環境

- 最新のChrome / Safari / Firefox / Edge（PC・スマホ）
- Canvas 2D APIが使用できる環境であれば動作します。
- `prefers-reduced-motion` に対応し、アニメーションを抑える設定にも配慮しています。
