/* =========================================================================
   ROCK BUSTER AR - script.js
   HTML + CSS + JavaScript のみで動作するレトロARボスバトルゲーム
   MediaPipe Tasks Vision (PoseLandmarker) を使用して姿勢推定を行う
   npm不要。CDN経由でモジュールを読み込むため GitHub Pages でそのまま動作する
   ========================================================================= */

// -------------------------------------------------------------------------
// MediaPipe Tasks Vision を CDN から動的インポート（ESM / npm不要）
// -------------------------------------------------------------------------
import {
  PoseLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// =====================================================================
// デプロイ確認用バージョン表示
// 再デプロイのたびにこの文字列を変更すれば、実機で最新版か一目で確認できる
// =====================================================================
const APP_VERSION = "v1.8.0";
document.getElementById("version-tag").textContent = APP_VERSION;

// =====================================================================
// 0. 定数・DOM要素の取得
// =====================================================================
const video = document.getElementById("camera-video");
const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const frameCanvas = document.getElementById("frame-canvas");
const frameCtx = frameCanvas.getContext("2d");

// 人物セグメンテーション（検知した人だけを青くするための下描き用オフスクリーンキャンバス）
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
let segmentationTintEnabled = true; // 環境非対応で失敗したら以降は自動的に諦める

// 検知した人物の部分だけをうっすら青く光らせる。
// 対応していない/エラーが出た環境では自動的に無効化し、素の映像のまま表示する
function drawPersonTint(mask) {
  if (!segmentationTintEnabled) return;
  try {
    const w = mask.width, h = mask.height;
    const data = mask.getAsFloat32Array(); // 各ピクセルの「人物らしさ」0.0〜1.0
    if (maskCanvas.width !== w || maskCanvas.height !== h) {
      maskCanvas.width = w;
      maskCanvas.height = h;
    }
    const imageData = maskCtx.createImageData(w, h);
    for (let i = 0; i < data.length; i++) {
      const confidence = data[i];
      const idx = i * 4;
      imageData.data[idx] = 90;       // R
      imageData.data[idx + 1] = 180;  // G
      imageData.data[idx + 2] = 255;  // B
      imageData.data[idx + 3] = confidence > 0.5 ? Math.min(255, confidence * 150) : 0;
    }
    maskCtx.putImageData(imageData, 0, 0);

    // カメラ映像はCSSでミラー表示(scaleX(-1))しているため、マスクも同様にミラーして重ねる
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  } catch (e) {
    segmentationTintEnabled = false;
    console.warn("人物セグメンテーションの青み演出はこの環境では利用できないため無効化しました", e);
  }
}

const loadingScreen = document.getElementById("loading-screen");
const loadingDetail = document.getElementById("loading-detail");
const calibrationScreen = document.getElementById("calibration-screen");
const calibBarInner = document.getElementById("calib-bar-inner");
const alignStatus = document.getElementById("align-status");
const startScreen = document.getElementById("start-screen");
const startBtn = document.getElementById("start-btn");
const resultScreen = document.getElementById("result-screen");
const resultTitle = document.getElementById("result-title");
const retryBtn = document.getElementById("retry-btn");

const rotateOverlay = document.getElementById("rotate-overlay");

const hud = document.getElementById("hud");
const playerHpBar = document.getElementById("player-hp-bar");
const bossHpBar = document.getElementById("boss-hp-bar");
const chargeBar = document.getElementById("charge-bar");
const statusText = document.getElementById("status-text");

// ゲーム全体のステート機械: loading -> calibrating -> ready -> playing -> win/lose
let gameState = "loading";

// キャリブレーション（シルエット位置合わせ）用
const ALIGN_FRAMES_NEEDED = 30; // これだけ連続で位置が合っていれば自動スタートへ進む
let alignFrameCount = 0;
let calibFrameCount = 0;
let calibShoulderYSum = 0;
let calibTorsoLenSum = 0;
let baselineShoulderY = null; // 基準時の肩の高さ（画面比率 0〜1）
let baselineTorsoLen = null;  // 基準時の肩〜腰の距離（縦の目安）

// 画面に表示するシルエットの「合わせてほしい位置」（キャンバス比率）
// X: ボスが右端に出るぶん、プレイヤーはやや左寄りに立ってもらう
// Y: 肩の高さの目標位置
const TARGET_SHOULDER_X_RATIO = 0.38;
const TARGET_SHOULDER_Y_RATIO = 0.42;
// 「なんとなく近ければOK」にするための許容範囲（広め）
const ALIGN_TOLERANCE_X_RATIO = 0.16;
const ALIGN_TOLERANCE_Y_RATIO = 0.14;

// =====================================================================
// 1. 8bit風サウンド（Web Audio APIでその場合成。外部音声ファイル不要）
// =====================================================================
const AudioSys = (() => {
  let actx = null;
  function ensure() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    return actx;
  }
  // 単純な矩形波/ノコギリ波のビープ音を鳴らす
  function beep({ freq = 440, duration = 0.1, type = "square", volume = 0.15, slideTo = null, delay = 0 }) {
    try {
      const ac = ensure();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      const t0 = ac.currentTime + delay;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.linearRampToValueAtTime(slideTo, t0 + duration);
      gain.gain.setValueAtTime(volume, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* オーディオ未対応環境は無視 */ }
  }
  return {
    shot: (level) => {
      // チャージ段階に応じて音程・長さが変化
      const params = [
        { freq: 700, slideTo: 1200, duration: 0.08, volume: 0.12 },
        { freq: 400, slideTo: 900, duration: 0.14, volume: 0.16 },
        { freq: 220, slideTo: 700, duration: 0.25, volume: 0.22 }
      ][level - 1] || { freq: 700, slideTo: 1200, duration: 0.08, volume: 0.12 };
      beep({ ...params, type: "square" });
    },
    chargeTick: (level) => beep({ freq: 300 + level * 200, duration: 0.06, type: "triangle", volume: 0.05 }),
    hit: () => beep({ freq: 150, duration: 0.15, type: "sawtooth", volume: 0.2 }),
    enemyShoot: () => beep({ freq: 500, slideTo: 200, duration: 0.12, type: "square", volume: 0.1 }),
    jump: () => beep({ freq: 300, slideTo: 500, duration: 0.1, type: "square", volume: 0.08 }),
    win: () => {
      [523, 659, 784, 1047].forEach((f, i) => beep({ freq: f, duration: 0.18, type: "square", volume: 0.15, delay: i * 0.15 }));
    },
    lose: () => {
      [400, 300, 200, 120].forEach((f, i) => beep({ freq: f, duration: 0.25, type: "sawtooth", volume: 0.18, delay: i * 0.2 }));
    }
  };
})();

// =====================================================================
// 2. プレイヤー状態
// =====================================================================
const PLAYER_MAX_HP = 100;
const player = {
  hp: PLAYER_MAX_HP,
  isJumping: false,
  jumpTimer: 0,
  isDucking: false,
  duckTimer: 0,
  invulnTimer: 0, // 被弾後の無敵時間
  shakeTimer: 0,
  arms: {
    left: { extended: false, chargeStart: 0, chargeLevel: 0, wristPx: null },
    right: { extended: false, chargeStart: 0, chargeLevel: 0, wristPx: null }
  }
};

// エネルギー弾のチャージ段階に必要な時間(ms)
const CHARGE_LV2_MS = 500;
const CHARGE_LV3_MS = 1100;

// =====================================================================
// 3. 敵（ボス）状態
// =====================================================================

// ボスごとの設定。1体倒すと自動的に次のボスとのバトルが始まる。
// 画像は「通常時」「攻撃時」「飛び道具」の3種類を差し替え可能。
// ファイルが用意されていない/読み込めない場合は自動的にドット絵版で代用される。
const BOSS_CONFIGS = [
  {
    name: "BOSS 1",
    maxHp: 100,
    idleSrc: "assets/boss.PNG",
    attackSrc: "assets/boss_attack.PNG",
    projectileSrc: "assets/boss_bullet.PNG"
  },
  {
    name: "BOSS 2",
    maxHp: Math.round(100 * 1.2), // 1体目の1.2倍のHP
    idleSrc: "assets/boss2.PNG",
    attackSrc: "assets/boss2_attack.PNG",
    projectileSrc: "assets/boss2_bullet.PNG"
  }
];

// 画像を1枚読み込むための共通ヘルパー。読み込み状況とアスペクト比を保持する
// 画像の「透明ではない実際の描画範囲」を検出する。
// PNGごとにキャラクター周りの余白量が違っても、後で見た目のサイズを揃えて描画できるようにする
function computeContentBBox(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cctx = c.getContext("2d");
  cctx.drawImage(img, 0, 0);
  const data = cctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  const ALPHA_THRESHOLD = 10;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, w, h }; // 完全に透明な画像だった場合のフォールバック
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function loadBossImageAsset(src) {
  const asset = { img: new Image(), loaded: false, aspect: 1, bbox: null };
  asset.img.onload = () => {
    asset.aspect = asset.img.naturalWidth / asset.img.naturalHeight;
    try {
      asset.bbox = computeContentBBox(asset.img);
    } catch (e) {
      // 何らかの理由で解析できなければ、画像全体をそのまま使う
      asset.bbox = { x: 0, y: 0, w: asset.img.naturalWidth, h: asset.img.naturalHeight };
    }
    asset.loaded = true;
  };
  asset.img.onerror = () => {
    console.warn(`ボス画像の読み込みに失敗しました: ${src}（ドット絵版で代用します）`);
  };
  asset.img.src = src;
  return asset;
}

// 透明な余白を無視して「実際に描かれている部分の高さ」を基準に画像を描画する共通ヘルパー。
// これにより、PNGごとに余白の量が違っても見た目のサイズが揃う。
// verticalAnchor: このアンカー点をY座標の基準にする（"bottom"=足元, "center"=中心, "top"=頭）
function drawTrimmedImage(img, bbox, targetContentHeight, anchorX, anchorY, verticalAnchor) {
  const scale = targetContentHeight / bbox.h;
  const fullW = img.naturalWidth * scale;
  const fullH = img.naturalHeight * scale;
  const drawX = anchorX - (bbox.x + bbox.w / 2) * scale;

  let drawY;
  if (verticalAnchor === "center") {
    drawY = anchorY - (bbox.y + bbox.h / 2) * scale;
  } else if (verticalAnchor === "top") {
    drawY = anchorY - bbox.y * scale;
  } else {
    drawY = anchorY - (bbox.y + bbox.h) * scale; // "bottom"（デフォルト）
  }

  ctx.drawImage(img, drawX, drawY, fullW, fullH);
  return { x: drawX, y: drawY, w: fullW, h: fullH };
}

// 各ボスの「通常」「攻撃」「飛び道具」画像をあらかじめまとめて読み込んでおく
const bossAssets = BOSS_CONFIGS.map((cfg) => ({
  idle: loadBossImageAsset(cfg.idleSrc),
  attack: loadBossImageAsset(cfg.attackSrc),
  projectile: loadBossImageAsset(cfg.projectileSrc)
}));

// 攻撃間隔の調整用定数（値を大きくするほど攻撃の間隔が広がる）
const BOSS_ATTACK_INTERVAL_START = 2600; // 最初の攻撃間隔(ms)
const BOSS_ATTACK_INTERVAL_MIN = 1500;   // どれだけ速くなっても、これより短くはならない
const BOSS_ATTACK_INTERVAL_DECAY = 18;   // 1回攻撃するごとに間隔が縮む量(ms)
const BOSS_ATTACK_POSE_MS = 550;         // 攻撃ポーズの画像を表示しておく時間(ms)
const BOSS_TRANSITION_MS = 1700;         // 1体目を倒してから2体目が出てくるまでの間(ms)

// ボスのジャンプ（縦の動き）に関する調整用定数
const BOSS_JUMP_INTERVAL_MIN = 2200; // 次のジャンプまでの間隔（最短）
const BOSS_JUMP_INTERVAL_MAX = 4200; // 次のジャンプまでの間隔（最長）
const BOSS_JUMP_DURATION = 900;      // ジャンプ1回分の時間(ms)
const BOSS_JUMP_HEIGHT_RATIO = 0.34; // ジャンプの高さ（画面の高さに対する割合）

const boss = {
  index: 0,          // 現在何体目のボスと戦っているか（0始まり）
  hp: 0,
  maxHp: 0,
  screenY: 0,        // 現在の画面上の高さ（地面 or ジャンプ中の高さ）
  jumping: false,    // ジャンプ中かどうか
  jumpStartTime: 0,
  jumpTimer: 0,      // 次のジャンプを始める時刻
  attackTimer: 0,
  attackInterval: BOSS_ATTACK_INTERVAL_START,
  lastAttackType: null, // 直前の攻撃タイプ（同じ攻撃が連続しすぎないようにするため記録）
  hitFlash: 0,
  dead: false,
  isAttacking: false,   // 攻撃ポーズの画像を表示中かどうか
  attackPoseUntil: 0,
  transitioning: false  // 次のボスへの切り替え演出中かどうか
};

// 指定したボスとのバトルを開始する（ゲーム開始時、および1体目撃破後の2体目開始時に使用）
function startBossBattle(index) {
  const cfg = BOSS_CONFIGS[index];
  const now = performance.now();
  boss.index = index;
  boss.maxHp = cfg.maxHp;
  boss.hp = cfg.maxHp;
  boss.screenY = bossGroundY();
  boss.jumping = false;
  boss.jumpTimer = now + BOSS_JUMP_INTERVAL_MIN + Math.random() * (BOSS_JUMP_INTERVAL_MAX - BOSS_JUMP_INTERVAL_MIN);
  boss.attackInterval = BOSS_ATTACK_INTERVAL_START;
  boss.lastAttackType = null;
  boss.hitFlash = 0;
  boss.dead = false;
  boss.isAttacking = false;
  boss.attackPoseUntil = 0;
  boss.transitioning = false;
  boss.attackTimer = now + 1800;
  enemyProjectiles = [];
  updateHpBars();

  statusText.textContent = `${cfg.name} APPEARED!`;
  setTimeout(() => { if (statusText.textContent.includes("APPEARED")) statusText.textContent = ""; }, 1200);
}

// ボスは常に画面右下のブロックの上に足をつけて立つ（横持ち前提のレイアウト）
// canvasの幅・高さから毎回計算することで、回転・リサイズ後も右端に追従する
function bossX() { return canvas.width * 0.88; }
function bossGroundY() { return canvas.height - getFrameThickness() - 4; } // 地面（枠のすぐ上、足がつく高さ）
function bossY() { return boss.screenY; } // 現在の実際の高さ（ジャンプ中は上がる）
// 当たり判定・パーティクル用：足元(bossY)ではなく、キャラクターの胴体中央あたりの高さ
function bossHitCenterY() { return bossY() - canvas.height * 0.16; }

// プレイヤー / 敵の弾丸リスト
let playerBolts = [];   // {x,y,vx,level,w,h}
let enemyProjectiles = []; // {x,y,vx,type:'ground'|'air', warned}

// 画面演出用パーティクル
let particles = [];
let screenShake = 0;

// =====================================================================
// 4. 初期化フロー
// =====================================================================
async function main() {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  try {
    await startCamera();
  } catch (err) {
    loadingDetail.textContent = "カメラを起動できませんでした。権限を許可してください。";
    console.error(err);
    return;
  }

  loadingDetail.textContent = "姿勢推定モデルを読み込み中...";
  const poseLandmarker = await createPoseLandmarker();
  loadingDetail.textContent = "準備完了";

  loadingScreen.classList.add("hidden");
  calibrationScreen.classList.remove("hidden");
  gameState = "calibrating";

  requestAnimationFrame(() => gameLoop(poseLandmarker));
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  frameCanvas.width = window.innerWidth;
  frameCanvas.height = window.innerHeight;
  drawPixelFrame();
}

// ロックマン風ボス部屋のような、ドット絵ブロックの枠を画面の四辺に描画する
// （純粋な装飾。ゲームロジックの座標系には影響しない）
// 枠のタイルサイズ・厚みを計算する（drawPixelFrame と、ボスの地面位置計算の両方で使う）
const FRAME_ROWS = 2; // 枠の厚み（タイル何個分か）
function getFrameTileSize() {
  return Math.max(14, Math.min(24, Math.floor(Math.min(canvas.width, canvas.height) / 26)));
}
function getFrameThickness() {
  return getFrameTileSize() * FRAME_ROWS;
}

function drawPixelFrame() {
  frameCtx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);

  const TILE = getFrameTileSize();
  const ROWS = FRAME_ROWS;

  function drawTile(x, y) {
    frameCtx.fillStyle = "#26313f";
    frameCtx.fillRect(x, y, TILE, TILE);
    frameCtx.fillStyle = "#4a5f74"; // 左上ハイライト
    frameCtx.fillRect(x, y, TILE, 2);
    frameCtx.fillRect(x, y, 2, TILE);
    frameCtx.fillStyle = "#121a22"; // 右下シャドウ
    frameCtx.fillRect(x, y + TILE - 2, TILE, 2);
    frameCtx.fillRect(x + TILE - 2, y, 2, TILE);
    frameCtx.fillStyle = "#0a0f14"; // 中央のリベット
    frameCtx.fillRect(x + TILE / 2 - 1, y + TILE / 2 - 1, 2, 2);
  }

  // 上下の帯
  for (let x = 0; x < frameCanvas.width; x += TILE) {
    for (let r = 0; r < ROWS; r++) {
      drawTile(x, r * TILE);
      drawTile(x, frameCanvas.height - TILE * (r + 1));
    }
  }
  // 左右の帯
  for (let y = 0; y < frameCanvas.height; y += TILE) {
    for (let c = 0; c < ROWS; c++) {
      drawTile(c * TILE, y);
      drawTile(frameCanvas.width - TILE * (c + 1), y);
    }
  }
}

// ---------------------------------------------------------------------
// 横持ち専用オーバーレイ制御
// 横向きでない間は「回転してください」画面を表示し、ゲームを一時停止する
// ---------------------------------------------------------------------
function isLandscape() {
  return window.innerWidth >= window.innerHeight;
}

function updateOrientationUI() {
  if (isLandscape()) {
    rotateOverlay.classList.add("hidden");
  } else {
    rotateOverlay.classList.remove("hidden");
  }
}

// 端末が対応していれば横向き固定を試みる（iOS Safariは非対応のためベストエフォート）
async function tryLockLandscape() {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("landscape").catch(() => {});
    }
  } catch (e) { /* 非対応環境では無視して縦横案内オーバーレイに任せる */ }
}

window.addEventListener("resize", updateOrientationUI);
window.addEventListener("orientationchange", updateOrientationUI);
updateOrientationUI();

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await new Promise((resolve) => { video.onloadedmetadata = () => resolve(); });
  await video.play();
}

async function createPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  return await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numPoses: 1,
    outputSegmentationMasks: true
  });
}

// スタート処理を共通化（タップ開始／自動開始の両方から呼べるようにする）
let autoStartTimer = null;

function beginPlaying() {
  clearTimeout(autoStartTimer);
  startScreen.classList.add("hidden");
  hud.classList.remove("hidden");
  gameState = "playing";
  startBossBattle(0); // 1体目のボスからスタート
}

// シルエットへの位置合わせが完了したら、タップしなくても少し待つと自動でスタートする
// （早くプレイしたい人はタップすればすぐ開始できる）
function scheduleAutoStart() {
  clearTimeout(autoStartTimer);
  autoStartTimer = setTimeout(() => {
    if (gameState === "ready-wait") {
      tryLockLandscape();
      beginPlaying();
    }
  }, 1800);
}

// スタートボタン（タップした場合は待たずに即開始）
startBtn.addEventListener("click", () => {
  tryLockLandscape(); // ユーザー操作のタイミングでないと許可されないブラウザが多いためここで試みる
  beginPlaying();
});

retryBtn.addEventListener("click", () => {
  resetGame();
  resultScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
  scheduleAutoStart(); // リトライ時もタップ不要で自動的にスタートする
});

function resetGame() {
  player.hp = PLAYER_MAX_HP;
  playerBolts = [];
  enemyProjectiles = [];
  particles = [];
  gameState = "ready-wait"; // スタートボタン待ち（start-screenはretryBtn側で表示済み）
  // ボスの状態はbeginPlaying()内のstartBossBattle(0)で1体目からリセットされる
}

// =====================================================================
// 5. メインループ
// =====================================================================
let lastVideoTime = -1;

function gameLoop(poseLandmarker) {
  requestAnimationFrame(() => gameLoop(poseLandmarker));

  // 縦持ちの間は姿勢推定・当たり判定・描画をすべて止めて一時停止する
  if (!isLandscape()) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ロックマン風ボス部屋の枠を毎フレーム描き写す（別レイヤーのスタッキングに頼らず、常に確実に表示する）
  ctx.drawImage(frameCanvas, 0, 0);

  // --- 姿勢推定（動画フレームが更新された時だけ実行し負荷を抑える） ---
  let landmarks = null;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    if (result.landmarks && result.landmarks.length > 0) {
      landmarks = result.landmarks[0];
    }
    // 検知した人物の部分だけを青く光らせる（対応していない環境では自動的に諦めて素の映像のまま）
    if (result.segmentationMasks && result.segmentationMasks.length > 0) {
      drawPersonTint(result.segmentationMasks[0]);
      if (typeof result.segmentationMasks[0].close === "function") {
        result.segmentationMasks[0].close();
      }
    }
  }

  if (gameState === "calibrating") {
    const aligned = handleCalibration(landmarks);
    drawSilhouetteGuide(aligned);
  } else if (gameState === "playing") {
    if (landmarks) updatePlayerFromPose(landmarks);
    updateBoss();
    updateProjectiles();
    checkCollisions();
    drawSkeletonHint(landmarks);
  }

  drawEnemy();
  drawProjectiles();
  drawParticles();
  applyScreenShakeDecay();

  if (gameState === "playing") {
    updateHud();
  }
}

// =====================================================================
// 6. キャリブレーション（シルエットへの位置合わせ＋基準姿勢の取得）
// =====================================================================
function computeShoulderScreenPos(landmarks) {
  const ls = landmarks[11], rs = landmarks[12];
  if (!ls || !rs) return null;
  const lsPx = toScreenPx(ls);
  const rsPx = toScreenPx(rs);
  return { x: (lsPx.x + rsPx.x) / 2, y: (lsPx.y + rsPx.y) / 2 };
}

function handleCalibration(landmarks) {
  if (!landmarks) {
    alignStatus.textContent = "画面内に上半身を映してください";
    alignStatus.classList.remove("ok");
    return false;
  }

  const shoulderPos = computeShoulderScreenPos(landmarks);
  if (!shoulderPos) return false;

  const targetX = canvas.width * TARGET_SHOULDER_X_RATIO;
  const targetY = canvas.height * TARGET_SHOULDER_Y_RATIO;
  const tolX = canvas.width * ALIGN_TOLERANCE_X_RATIO;
  const tolY = canvas.height * ALIGN_TOLERANCE_Y_RATIO;

  // X軸の開始位置・Y軸の高さが、どちらもだいたい目標範囲に収まっていればOK
  const aligned =
    Math.abs(shoulderPos.x - targetX) < tolX &&
    Math.abs(shoulderPos.y - targetY) < tolY;

  if (aligned) {
    alignStatus.textContent = "OK! そのまま少し待ってください";
    alignStatus.classList.add("ok");
    alignFrameCount++;

    // 位置が合っている間の姿勢を基準（ベースライン）として蓄積する
    const ls = landmarks[11], rs = landmarks[12];
    const lh = landmarks[23], rh = landmarks[24];
    const shoulderYNorm = (ls.y + rs.y) / 2;
    const hipYNorm = lh && rh ? (lh.y + rh.y) / 2 : shoulderYNorm + 0.25;
    calibShoulderYSum += shoulderYNorm;
    calibTorsoLenSum += Math.abs(hipYNorm - shoulderYNorm) || 0.25;
    calibFrameCount++;
  } else {
    alignStatus.textContent = "位置を合わせています...";
    alignStatus.classList.remove("ok");
    // 外れても即リセットはせず、少しずつ巻き戻すだけにして負担を減らす
    alignFrameCount = Math.max(0, alignFrameCount - 2);
  }

  calibBarInner.style.width = `${Math.min(100, (alignFrameCount / ALIGN_FRAMES_NEEDED) * 100)}%`;

  if (alignFrameCount >= ALIGN_FRAMES_NEEDED && calibFrameCount > 0) {
    baselineShoulderY = calibShoulderYSum / calibFrameCount;
    baselineTorsoLen = calibTorsoLenSum / calibFrameCount;
    calibrationScreen.classList.add("hidden");
    startScreen.classList.remove("hidden");
    gameState = "ready-wait";
    scheduleAutoStart(); // タップしなくても少し待てば自動的にスタートする
  }

  return aligned;
}

// プレイヤーに合わせてほしい「お手本シルエット」を描画する
// 頭・肩・胴体・腕を単純な線画で表現（既存キャラクター素材は使用しない自作図形）
function drawSilhouetteGuide(aligned) {
  const targetX = canvas.width * TARGET_SHOULDER_X_RATIO;
  const targetY = canvas.height * TARGET_SHOULDER_Y_RATIO;
  const scale = canvas.height * 0.011;

  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = aligned ? "#4dff8f" : "rgba(127,220,255,0.75)";
  ctx.shadowColor = aligned ? "#4dff8f" : "#7fdcff";
  ctx.shadowBlur = aligned ? 26 : 10;

  // 頭
  const headR = scale * 9;
  ctx.beginPath();
  ctx.arc(targetX, targetY - headR * 2.6, headR, 0, Math.PI * 2);
  ctx.stroke();

  // 肩ライン
  const shoulderHalfW = scale * 20;
  ctx.beginPath();
  ctx.moveTo(targetX - shoulderHalfW, targetY);
  ctx.lineTo(targetX + shoulderHalfW, targetY);
  ctx.stroke();

  // 胴体（肩幅→腰幅の台形）
  const hipHalfW = scale * 14;
  const hipY = targetY + scale * 34;
  ctx.beginPath();
  ctx.moveTo(targetX - shoulderHalfW, targetY);
  ctx.lineTo(targetX - hipHalfW, hipY);
  ctx.lineTo(targetX + hipHalfW, hipY);
  ctx.lineTo(targetX + shoulderHalfW, targetY);
  ctx.closePath();
  ctx.stroke();

  // 腕（軽く外側に下ろした自然なポーズ）
  ctx.beginPath();
  ctx.moveTo(targetX - shoulderHalfW, targetY);
  ctx.lineTo(targetX - shoulderHalfW - scale * 5, targetY + scale * 22);
  ctx.moveTo(targetX + shoulderHalfW, targetY);
  ctx.lineTo(targetX + shoulderHalfW + scale * 5, targetY + scale * 22);
  ctx.stroke();

  ctx.restore();
}

// =====================================================================
// 7. プレイヤーの姿勢からゲーム内アクションを判定
// =====================================================================
function toScreenPx(landmark) {
  // カメラ映像はCSSでミラー表示(scaleX(-1))しているため、
  // 描画座標もミラーして実際の見た目と一致させる
  return {
    x: canvas.width - landmark.x * canvas.width,
    y: landmark.y * canvas.height
  };
}

function angleAtJoint(a, b, c) {
  // 点bを頂点とする角a-b-cの角度（度）を求める
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAB = Math.hypot(ab.x, ab.y);
  const magCB = Math.hypot(cb.x, cb.y);
  if (magAB === 0 || magCB === 0) return 180;
  const cos = Math.min(1, Math.max(-1, dot / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function updatePlayerFromPose(landmarks) {
  const now = performance.now();

  // ---- ジャンプ / しゃがみ判定（肩の高さの変化で判定） ----
  const ls = landmarks[11], rs = landmarks[12];
  if (ls && rs) {
    const shoulderY = (ls.y + rs.y) / 2;
    const deltaY = baselineShoulderY - shoulderY; // 正なら上に動いた＝ジャンプ

    if (deltaY > baselineTorsoLen * 0.35) {
      player.isJumping = true;
      player.jumpTimer = now + 400;
    }
    if (-deltaY > baselineTorsoLen * 0.28) {
      player.isDucking = true;
      player.duckTimer = now + 400;
    }
  }
  if (player.jumpTimer && now > player.jumpTimer) player.isJumping = false;
  if (player.duckTimer && now > player.duckTimer) player.isDucking = false;

  // ---- 両腕それぞれについて「伸ばす→肘を曲げる」を判定 ----
  processArm("left", landmarks[11], landmarks[13], landmarks[15], landmarks[23]);
  processArm("right", landmarks[12], landmarks[14], landmarks[16], landmarks[24]);
}

function processArm(side, shoulderLm, elbowLm, wristLm, hipLm) {
  if (!shoulderLm || !elbowLm || !wristLm) return;
  const arm = player.arms[side];
  const now = performance.now();

  const shoulder = toScreenPx(shoulderLm);
  const elbow = toScreenPx(elbowLm);
  const wrist = toScreenPx(wristLm);
  arm.wristPx = wrist;

  const elbowAngle = angleAtJoint(shoulder, elbow, wrist);
  const armLen = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y);
  const torsoLenPx = baselineTorsoLen * canvas.height;
  const isStraightAndReaching = elbowAngle > 150 && armLen > torsoLenPx * 0.85;

  if (isStraightAndReaching && !arm.extended) {
    // 腕を伸ばし始めた瞬間
    arm.extended = true;
    arm.chargeStart = now;
    arm.chargeLevel = 0;
  } else if (isStraightAndReaching && arm.extended) {
    // 伸ばし続けている → チャージ継続
    const elapsed = now - arm.chargeStart;
    const newLevel = elapsed > CHARGE_LV3_MS ? 3 : elapsed > CHARGE_LV2_MS ? 2 : 1;
    if (newLevel !== arm.chargeLevel) {
      arm.chargeLevel = newLevel;
      AudioSys.chargeTick(newLevel);
      spawnChargeParticles(wrist, newLevel);
    }
  } else if (!isStraightAndReaching && arm.extended && elbowAngle < 110) {
    // 伸ばした状態から肘を曲げた瞬間 → 発射！
    fireBolt(wrist, shoulder, Math.max(1, arm.chargeLevel));
    arm.extended = false;
    arm.chargeLevel = 0;
  } else if (!isStraightAndReaching && elbowAngle > 150) {
    // 単に腕を戻しただけ（伸びていない）
    arm.extended = false;
    arm.chargeLevel = 0;
  }
}

// =====================================================================
// 8. 攻撃：プレイヤーのエネルギー弾
// =====================================================================
function fireBolt(wristPx, shoulderPx, level) {
  const dirX = wristPx.x - shoulderPx.x;
  const dirY = wristPx.y - shoulderPx.y;
  const mag = Math.hypot(dirX, dirY) || 1;
  // 常に画面右方向（ボスの方向）へ飛ばす。縦方向のみ腕の向きを反映
  const vx = 9 + level * 2;
  const vy = (dirY / mag) * 2;

  const sizeByLevel = [0, 10, 18, 30];
  playerBolts.push({
    x: wristPx.x, y: wristPx.y,
    vx, vy,
    level,
    r: sizeByLevel[level]
  });
  AudioSys.shot(level);
  statusText.textContent = level === 3 ? "MAX CHARGE SHOT!!" : "SHOT!";
  setTimeout(() => { if (statusText.textContent.includes("SHOT")) statusText.textContent = ""; }, 500);
}

function spawnChargeParticles(pos, level) {
  for (let i = 0; i < level * 3; i++) {
    particles.push({
      x: pos.x + (Math.random() - 0.5) * 20,
      y: pos.y + (Math.random() - 0.5) * 20,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      life: 20,
      color: level === 3 ? "#ffe66d" : "#7fdcff",
      size: 3 + level
    });
  }
}

// =====================================================================
// 9. 敵（ボス）AI
// =====================================================================
function updateBoss() {
  if (boss.dead || boss.transitioning) return;
  const now = performance.now();

  // --- ジャンプの管理：普段は地面に足をつけて立ち、時々ジャンプする ---
  if (boss.jumping) {
    const elapsed = now - boss.jumpStartTime;
    const p = Math.min(1, elapsed / BOSS_JUMP_DURATION);
    const jumpOffset = Math.sin(p * Math.PI) * (canvas.height * BOSS_JUMP_HEIGHT_RATIO);
    boss.screenY = bossGroundY() - jumpOffset;
    if (p >= 1) {
      boss.jumping = false;
      boss.screenY = bossGroundY();
      boss.jumpTimer = now + BOSS_JUMP_INTERVAL_MIN + Math.random() * (BOSS_JUMP_INTERVAL_MAX - BOSS_JUMP_INTERVAL_MIN);
    }
  } else {
    boss.screenY = bossGroundY(); // 地面にしっかり足をつけて立つ
    if (now > boss.jumpTimer) {
      boss.jumping = true;
      boss.jumpStartTime = now;
    }
  }

  if (now > boss.attackTimer) {
    launchEnemyAttack();
    boss.attackInterval = Math.max(BOSS_ATTACK_INTERVAL_MIN, boss.attackInterval - BOSS_ATTACK_INTERVAL_DECAY);
    boss.attackTimer = now + boss.attackInterval;
  }
  // 攻撃ポーズの画像を一定時間表示したら通常画像に戻す
  if (boss.isAttacking && now > boss.attackPoseUntil) {
    boss.isAttacking = false;
  }
  if (boss.hitFlash > 0) boss.hitFlash--;
}

// 敵の飛び道具の移動速度（値を小さくするほどゆっくりになる）
const ENEMY_PROJECTILE_SPEED = 3.2;

function launchEnemyAttack() {
  // 攻撃タイプは「敵が今どこにいるか」で決まる：
  // 地面に立っていれば地上攻撃、ジャンプ中なら空中攻撃を、実際の高さから発射する
  const type = boss.jumping ? "air" : "ground";
  boss.lastAttackType = type;
  AudioSys.enemyShoot();

  // 攻撃の瞬間だけ「攻撃時PNG」に切り替え、一定時間後に通常PNGへ戻す
  boss.isAttacking = true;
  boss.attackPoseUntil = performance.now() + BOSS_ATTACK_POSE_MS;

  const y = bossY(); // 敵の現在の縦位置からそのまま発射する
  enemyProjectiles.push({
    x: bossX(),
    y,
    vx: -ENEMY_PROJECTILE_SPEED,
    type,
    warned: false
  });
  statusText.textContent = type === "ground" ? "GROUND ATTACK! (ジャンプで回避)" : "AIR ATTACK! (しゃがみで回避)";
  setTimeout(() => { if (statusText.textContent.includes("ATTACK")) statusText.textContent = ""; }, 700);
}

// =====================================================================
// 10. 弾の移動更新
// =====================================================================
const HIT_LINE_X_RATIO = 0.22; // この位置まで来たプレイヤー弾/敵弾を判定する

function updateProjectiles() {
  playerBolts.forEach(b => { b.x += b.vx; b.y += b.vy; });
  playerBolts = playerBolts.filter(b => b.x < canvas.width + 40);

  enemyProjectiles.forEach(p => { p.x += p.vx; });
  enemyProjectiles = enemyProjectiles.filter(p => p.x > -40);

  particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.life--; });
  particles = particles.filter(p => p.life > 0);
}

// =====================================================================
// 11. 当たり判定
// =====================================================================
function checkCollisions() {
  const now = performance.now();

  // --- プレイヤー弾 vs ボス ---
  if (!boss.dead && !boss.transitioning) {
    playerBolts.forEach(b => {
      const dx = b.x - bossX();
      const dy = b.y - bossHitCenterY();
      if (Math.hypot(dx, dy) < 55 + b.r * 0.3) {
        const dmg = [0, 8, 16, 32][b.level] || 8;
        boss.hp = Math.max(0, boss.hp - dmg);
        boss.hitFlash = 10;
        b.x = 99999; // 消去マーク
        spawnHitParticles(bossX(), bossHitCenterY(), "#ff6b6b");
        AudioSys.hit();
        screenShake = 6;
        if (boss.hp <= 0) triggerWin();
      }
    });
    playerBolts = playerBolts.filter(b => b.x < 99000);
  }

  // --- 敵弾 vs プレイヤー（ヒットラインに到達した時点で回避成功/失敗を判定） ---
  const hitLineX = canvas.width * HIT_LINE_X_RATIO;
  enemyProjectiles.forEach(p => {
    if (p.warned) return;
    if (p.x <= hitLineX) {
      p.warned = true;
      const avoided =
        (p.type === "ground" && player.isJumping) ||
        (p.type === "air" && player.isDucking);

      if (!avoided && player.invulnTimer < now) {
        player.hp = Math.max(0, player.hp - 12);
        player.invulnTimer = now + 700;
        player.shakeTimer = now + 300;
        screenShake = 14;
        spawnHitParticles(hitLineX, p.y, "#ff4d4d");
        AudioSys.hit();
        if (player.hp <= 0) triggerLose();
      }
    }
  });
}

function spawnHitParticles(x, y, color) {
  for (let i = 0; i < 14; i++) {
    const angle = (Math.PI * 2 * i) / 14;
    particles.push({
      x, y,
      vx: Math.cos(angle) * 4,
      vy: Math.sin(angle) * 4,
      life: 22,
      color,
      size: 4
    });
  }
}

function applyScreenShakeDecay() {
  if (screenShake > 0) {
    const dx = (Math.random() - 0.5) * screenShake;
    const dy = (Math.random() - 0.5) * screenShake;
    canvas.style.transform = `translate(${dx}px, ${dy}px)`;
    screenShake *= 0.85;
    if (screenShake < 0.5) { screenShake = 0; canvas.style.transform = ""; }
  }
}

// =====================================================================
// 12. 勝敗処理
// =====================================================================
function triggerWin() {
  if (gameState !== "playing" || boss.transitioning) return;

  const isFinalBoss = boss.index >= BOSS_CONFIGS.length - 1;
  boss.dead = true;

  // 撃破エフェクトは共通（爆発パーティクル＋撃破音）
  AudioSys.hit();
  screenShake = 10;
  for (let i = 0; i < 40; i++) {
    particles.push({
      x: bossX() + (Math.random() - 0.5) * 80,
      y: bossHitCenterY() + (Math.random() - 0.5) * 80,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 8,
      life: 40,
      color: ["#ffe66d", "#ff6b6b", "#7fdcff"][i % 3],
      size: 5
    });
  }

  if (!isFinalBoss) {
    // まだ次のボスが残っている場合は、少し間を置いて2体目のバトルを始める
    boss.transitioning = true;
    playerBolts = [];
    enemyProjectiles = [];
    statusText.textContent = "BOSS DEFEATED! NEXT BOSS...";
    setTimeout(() => {
      startBossBattle(boss.index + 1);
      statusText.textContent = "";
    }, BOSS_TRANSITION_MS);
    return;
  }

  // 最終ボスを倒した場合のみ、本当のゲームクリア演出に入る
  gameState = "win";
  AudioSys.win();
  setTimeout(() => showResult(true), 900);
}

function triggerLose() {
  if (gameState !== "playing") return;
  gameState = "lose";
  AudioSys.lose();
  setTimeout(() => showResult(false), 900);
}

function showResult(won) {
  hud.classList.add("hidden");
  resultTitle.textContent = won ? "YOU WIN!" : "GAME OVER";
  resultTitle.style.color = won ? "#ffe66d" : "#ff6b6b";
  resultScreen.classList.remove("hidden");
}

// =====================================================================
// 13. 描画関連
// =====================================================================

// プレイヤーの腕の状態を軽くハイライト（骨格全体は映像で見えているので最小限に）
function drawSkeletonHint(landmarks) {
  ["left", "right"].forEach(side => {
    const arm = player.arms[side];
    if (arm.extended && arm.wristPx) {
      const level = arm.chargeLevel;
      const radius = 8 + level * 6;
      const color = level === 3 ? "#ffe66d" : level === 2 ? "#7fffd4" : "#7fdcff";
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(arm.wristPx.x, arm.wristPx.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  });

  // ジャンプ／しゃがみのステータス表示（デバッグ兼演出）
  if (player.isJumping || player.isDucking) {
    ctx.save();
    ctx.font = "10px 'Press Start 2P'";
    ctx.fillStyle = "#ffe66d";
    ctx.textAlign = "center";
    ctx.fillText(player.isJumping ? "JUMP!" : "DUCK!", canvas.width / 2, canvas.height * 0.15);
    ctx.restore();
  }
}

// ボスのスプライトを描画する。
// 現在のボス(boss.index)・攻撃中かどうか(boss.isAttacking)に応じて
// 「通常画像」「攻撃時画像」を自動的に切り替える。読み込めていない場合はドット絵版で代用する
function drawEnemy() {
  if (gameState === "loading" || gameState === "calibrating") return;
  if (boss.transitioning) return; // 次のボスに切り替わる演出中は何も表示しない

  const bx = bossX();
  const by = bossY();
  const flash = boss.hitFlash > 0;
  const assets = bossAssets[boss.index];
  const activeAsset = boss.isAttacking && assets.attack.loaded ? assets.attack : assets.idle;

  ctx.save();
  ctx.translate(bx, by);
  if (boss.dead) ctx.globalAlpha = 0.4;

  if (activeAsset.loaded) {
    // 透明な余白を無視し、「実際に描かれているキャラクター部分」の高さを基準に揃えて描画する
    // （PNGごとに余白の量が違っても、通常時と攻撃時でキャラクターの見た目サイズが揃うようにする）
    const targetContentHeight = canvas.height * 0.32;
    const bbox = activeAsset.bbox || { x: 0, y: 0, w: activeAsset.img.naturalWidth, h: activeAsset.img.naturalHeight };
    const feetY = 2; // 足元の位置（地面のすぐ上に来るよう、ごくわずかなオフセットのみ）
    const rect = drawTrimmedImage(activeAsset.img, bbox, targetContentHeight, 0, feetY, "bottom");

    if (flash) {
      // 画像の不透明部分だけに白を重ねて被弾フラッシュを表現する
      ctx.save();
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }
  } else {
    drawEnemyFallbackSprite(flash);
  }

  ctx.restore();
}

// 画像読み込み前・失敗時のフォールバック用ドット絵シェフロボット
// （既存キャラクター素材は使用しない自作図形）
function drawEnemyFallbackSprite(flash) {
  const px = 8; // 1ドットのピクセルサイズ
  const grid = [
    "...HHHHHH...",
    "..HHHHHHHH..",
    ".HHHHHHHHHH.",
    ".hhhhhhhhhh.",
    "..FFFFFFFF..",
    ".FFFFFFFFFF.",
    "FFFEFFFFEFFF",
    "FFFFFFFFFFFF",
    ".FTTTTTTTTF.",
    "..FFFFFFFF..",
    "GBBBBBBBBBBG",
    "GBBBBBBBBBBG",
    "GBBBBBBBBBBG",
    ".AAAAAAAAAA.",
    "..AAAAAAAA..",
    "..KK....KK.."
  ];

  const colorFor = (ch) => {
    if (flash) return "#ffffff";
    switch (ch) {
      case "H": return "#f5f5f5"; // コック帽（白）
      case "h": return "#c9c9c9"; // 帽子バンドの影
      case "F": return "#e8792a"; // 顔（オレンジ）
      case "E": return "#1a1a1a"; // 目
      case "T": return "#fff8e8"; // 歯・笑顔
      case "B": return "#c0392b"; // ボディアーマー（赤）
      case "G": return "#9aa0a6"; // 露出した金属アーム
      case "A": return "#f5f0e6"; // エプロン（クリーム色）
      case "K": return "#141414"; // ブーツ
      default: return "#ffffff";
    }
  };

  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[row].length; col++) {
      const ch = grid[row][col];
      if (ch === ".") continue;
      ctx.fillStyle = colorFor(ch);
      ctx.fillRect((col - 5.5) * px, (row - 8) * px, px, px);
    }
  }

  // 片手に持たせたお玉（レードル）
  const handleX = (-1 - 5.5) * px;
  const handleY = (11 - 8) * px;
  ctx.fillStyle = flash ? "#ffffff" : "#8d8d8d";
  ctx.fillRect(handleX - px * 0.5, handleY, px * 0.6, px * 2.2);
  ctx.beginPath();
  ctx.fillStyle = flash ? "#ffffff" : "#d8d8d8";
  ctx.arc(handleX - px * 0.2, handleY + px * 2.7, px * 1.05, 0, Math.PI * 2);
  ctx.fill();
}

function drawProjectiles() {
  // プレイヤーのエネルギー弾
  playerBolts.forEach(b => {
    const colors = ["", "#7fdcff", "#7fffd4", "#ffe66d"];
    ctx.save();
    ctx.shadowColor = colors[b.level];
    ctx.shadowBlur = 18;
    ctx.fillStyle = colors[b.level];
    ctx.beginPath();
    ctx.arc(b.x, b.y, Math.max(6, b.r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // 敵の弾（現在のボスの「飛び道具PNG」があればそれを使用。なければ色付きの丸で代用）
  const projectileAsset = bossAssets[boss.index] ? bossAssets[boss.index].projectile : null;
  enemyProjectiles.forEach(p => {
    ctx.save();
    if (projectileAsset && projectileAsset.loaded) {
      const bbox = projectileAsset.bbox || { x: 0, y: 0, w: projectileAsset.img.naturalWidth, h: projectileAsset.img.naturalHeight };
      drawTrimmedImage(projectileAsset.img, bbox, 30, p.x, p.y, "center");
    } else {
      const color = p.type === "ground" ? "#ff8c42" : "#c86bff";
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  });
}

function drawParticles() {
  particles.forEach(p => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life / 24);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size);
    ctx.restore();
  });
}

// =====================================================================
// 14. HUD更新
// =====================================================================
function updateHpBars() {
  playerHpBar.style.width = `${(player.hp / PLAYER_MAX_HP) * 100}%`;
  bossHpBar.style.width = `${(boss.hp / boss.maxHp) * 100}%`;
}

function updateHud() {
  updateHpBars();
  const maxCharge = Math.max(player.arms.left.chargeLevel, player.arms.right.chargeLevel);
  chargeBar.style.width = `${(maxCharge / 3) * 100}%`;
}

// =====================================================================
// 起動
// =====================================================================
main();
