/* ====================================================================
   ROBO RUSH - script.js
   HTML/CSS/JavaScript(Canvas) のみで動作するレトロ横スクロール
   ロボットレースゲーム。外部ライブラリは使用していません。

   ファイル構成:
     index.html  ... 画面構造（設定画面 / ゲーム画面 / リザルト画面）
     style.css   ... 見た目
     script.js   ... 本ファイル。ゲームロジック全般。

   パラメータは全て先頭の CONFIG にまとめてあるので、
   数値を変えるだけで難易度・演出強度などを調整できます。
   ==================================================================== */

'use strict';

/* ============================== CONFIG ============================== */
const CONFIG = {
  LANES: 4,                     // レーン数
  LAPS: 3,                      // 周回数
  LAP_LENGTH: 6000,             // 1周の距離（ワールド座標系のピクセル数）

  // ---- 速度関連 ----
  BASE_SPEED: 260,              // 基本速度 (px/sec)
  MAX_SPEED_CPU_VARIANCE: 40,   // CPUごとの速度ばらつき
  TURBO_MULT: 1.9,              // ターボ中の速度倍率
  TURBO_GAUGE_MAX: 100,         // ターボゲージ最大値
  TURBO_FILL_RATE: 55,          // ターボ使用中のゲージ上昇量/秒
  TURBO_COOL_RATE: 30,          // ターボ非使用時のゲージ減少量/秒
  OVERHEAT_STUN_TIME: 2.6,      // オーバーヒート時の停止秒数

  // ---- ジャンプ関連 ----
  JUMP_VELOCITY: 480,           // 手動ジャンプの初速
  GRAVITY: 1500,                // 重力加速度
  RAMP_JUMP_VELOCITY_SMALL: 380,
  RAMP_JUMP_VELOCITY_BIG: 620,

  // ---- レーン移動 ----
  LANE_CHANGE_SPEED: 9,         // レーン変更の補間速度（大きいほど速い）

  // ---- 障害物・アイテム生成 ----
  OBSTACLE_MIN_GAP: 420,        // 障害物同士の最小間隔（同レーン内）
  OBSTACLE_DENSITY: 1 / 260,    // 1pxあたりの障害物発生確率の目安
  ITEM_BOX_GAP: 900,           // アイテムボックスの平均間隔
  MAX_ITEMS: 2,                 // 同時に持てるアイテムの最大数
  SAFE_LANE_GUARANTEE: true,    // 各X位置で必ず1レーンは安全にする

  // ---- CPU AI ----
  CPU_LOOKAHEAD: 340,           // CPUが障害物を認識する距離
  CPU_TURBO_CHANCE: 0.5,        // ゲージに余裕がある時にターボを使う確率係数
  CPU_ITEM_USE_DELAY: [1.0, 3.0], // アイテム取得後、使用までのランダム待機時間

  // ---- 演出 ----
  SCREEN_SHAKE_DECAY: 6,
  HIT_STOP_TIME: 0.12,          // 被弾時のヒットストップ秒数
  STUN_TIME: 1.6,               // 通常の被弾/転倒スタン秒数
  CRATER_STUN_TIME: 2.2,
  INVINCIBLE_TIME: 1.3,         // 被弾後、再度ダメージを受けない無敵時間（秒。スタン終了後からのグレース期間）

  CANVAS_BG_LIST: ['sea', 'city', 'grass', 'mountain'],
};

/* 4色のロボットIDに対応する既定カラー（画像未設定時のプレースホルダー用） */
const DEFAULT_COLORS = ['#ffb930', '#28f2ff', '#ff4fd8', '#63ff8a'];

/* ============================== 外部アセット画像 ==============================
   ここに指定したパスの画像が用意されていれば、ボーガンの矢／ミサイル／トラップの
   描画にそのまま使われます。ファイルが無い、または読み込めない場合は自動的に
   Canvas で描いた代替グラフィックにフォールバックするので、画像が無くても
   ゲームは問題なく動作します。

   用意してもらいたい画像（任意・GitHub Pages上の assets/ フォルダに配置）:
     assets/crossbow_bolt.PNG   ... ボーガンの矢 1本分の画像
     assets/missile_big.PNG     ... 大型ミサイル（1発）の画像
     assets/missile_homing.PNG  ... 追跡ミサイル（1発分）の画像　※無ければ missile_big.PNG を代用
     assets/trap.PNG            ... トラップ（地雷）の画像
     assets/laser_orb.PNG       ... レーザー武器に使う「円形の光の玉」の画像（例：発光する球体）
   推奨サイズ: 横長の乗り物系画像で 64x32px 前後（正方形でも自動調整されます）
   ================================================================================ */
const ASSET_PATHS = {
  crossbow: 'assets/crossbow_bolt.PNG',
  missileBig: 'assets/missile_big.PNG',
  missileHoming: 'assets/missile_homing.PNG',
  trap: 'assets/trap.PNG',
  laserOrb: 'assets/laser_orb.PNG',
};
const assetImages = {};
function loadAssetImage(key, path) {
  const img = new Image();
  img._ready = false;
  img.onload = () => { img._ready = true; };
  img.onerror = () => { img._ready = false; };
  img.src = path;
  assetImages[key] = img;
}
Object.entries(ASSET_PATHS).forEach(([k, p]) => loadAssetImage(k, p));
function assetReady(key) {
  const img = assetImages[key];
  return img && img._ready && img.naturalWidth > 0;
}
/* homing 用画像が無ければ missileBig を代用できるようにするヘルパー */
function homingAssetImage() {
  if (assetReady('missileHoming')) return assetImages.missileHoming;
  if (assetReady('missileBig')) return assetImages.missileBig;
  return null;
}

/* ============================== ユーティリティ ============================== */
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const lerp = (a, b, t) => a + (b - a) * t;

/* 画像未設定時に使う簡易ロボットアイコンを Canvas で生成し dataURL を返す */
function generatePlaceholderRobot(colorHex) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#0b0d14';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = colorHex;
  // 頭
  g.fillRect(18, 6, 28, 20);
  // 目
  g.fillStyle = '#0b0d14';
  g.fillRect(24, 12, 6, 6);
  g.fillRect(34, 12, 6, 6);
  // 胴体
  g.fillStyle = colorHex;
  g.fillRect(14, 28, 36, 22);
  // 腕
  g.fillRect(4, 30, 10, 16);
  g.fillRect(50, 30, 10, 16);
  // 脚
  g.fillRect(18, 50, 10, 12);
  g.fillRect(36, 50, 10, 12);
  return c.toDataURL();
}

/* ============================== サウンド（WebAudioで効果音を自動生成） ==============================
   外部の音声ファイルは使用せず、Web Audio API でその場に効果音を生成しています。
   ブラウザの自動再生制限があるため、最初のユーザー操作（GAME STARTボタン押下等）で
   AudioContext を起動 (ensureAudio) しています。
   ================================================================================================ */
const SFX = (() => {
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  let actx = null;

  function ensureAudio() {
    if (!actx) {
      try { actx = new AudioCtxClass(); } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }

  /* 単純なビープ音（ジャンプ・カウントダウン等に使用） */
  function beep(freq, duration, type = 'square', vol = 0.15, delay = 0, slideTo = null) {
    if (!actx) return;
    const t0 = actx.currentTime + delay;
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain); gain.connect(actx.destination);
    osc.start(t0); osc.stop(t0 + duration + 0.03);
  }

  /* ノイズバースト（爆発・衝突・歓声などに使用） */
  function noiseBurst(duration, vol = 0.2, filterFreq = null) {
    if (!actx) return;
    const bufferSize = Math.floor(actx.sampleRate * duration);
    const buffer = actx.createBuffer(1, bufferSize, actx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = actx.createBufferSource();
    src.buffer = buffer;
    let node = src;
    if (filterFreq) {
      const filt = actx.createBiquadFilter();
      filt.type = 'bandpass'; filt.frequency.value = filterFreq;
      node.connect(filt); node = filt;
    }
    const gain = actx.createGain();
    gain.gain.setValueAtTime(vol, actx.currentTime);
    node.connect(gain); gain.connect(actx.destination);
    src.start();
  }

  return {
    ensureAudio,
    jump() { beep(500, 0.1, 'square', 0.1, 0, 700); },
    hit() { noiseBurst(0.28, 0.3); beep(110, 0.22, 'sawtooth', 0.18, 0, 60); },
    turboStart() { beep(220, 0.35, 'sawtooth', 0.12, 0, 900); },
    overheat() { beep(180, 0.6, 'square', 0.16, 0, 60); noiseBurst(0.3, 0.15); },
    itemGet() { beep(660, 0.08, 'square', 0.14, 0); beep(880, 0.08, 'square', 0.14, 0.08); beep(1180, 0.12, 'square', 0.14, 0.16); },
    fireCrossbow() { for (let i = 0; i < 3; i++) beep(900 - i * 120, 0.06, 'square', 0.08, i * 0.03); },
    fireMissile() { noiseBurst(0.4, 0.2, 300); beep(90, 0.4, 'sawtooth', 0.15, 0, 40); },
    fireHoming() { beep(500, 0.5, 'sawtooth', 0.1, 0, 1400); noiseBurst(0.3, 0.12, 600); },
    fireLaser() { beep(1400, 0.35, 'sawtooth', 0.16, 0, 220); },
    fireTrap() { beep(300, 0.15, 'square', 0.1); },
    explosion(big) { noiseBurst(big ? 0.6 : 0.35, big ? 0.35 : 0.22); beep(80, big ? 0.5 : 0.3, 'sawtooth', 0.2, 0, 30); },
    countdownTick() { beep(440, 0.14, 'square', 0.15); },
    go() { beep(880, 0.35, 'square', 0.22, 0, 1200); },
    lap() { beep(700, 0.1, 'square', 0.15, 0); beep(900, 0.12, 'square', 0.15, 0.1); },
    finish() { [0, 0.12, 0.24, 0.4].forEach((d, i) => beep(520 + i * 140, 0.2, 'square', 0.2, d)); },
    victory() {
      [0, 0.18, 0.36, 0.54, 0.78].forEach((d, i) => beep([523, 659, 784, 1047, 1319][i], 0.28, 'square', 0.2, d));
      noiseBurst(1.2, 0.08, 1500);
    },
  };
})();

/* ============================== 障害物定義 ============================== */
/*
  各障害物タイプは以下を持つ:
    key          : 識別子
    label        : 表示名
    color        : 描画色
    width        : ワールド座標上の当たり判定幅
    needsJump    : true の場合、ジャンプ中でないと効果を受ける
    auto         : true の場合、触れると自動でジャンプ発生（ジャンプ台・坂）
    effect(racer): 効果を racer に適用する関数
*/
const OBSTACLE_TYPES = [
  {
    key: 'jump_pad', label: 'ジャンプ台', color: '#ffb930', width: 46, auto: true,
    effect(r) { doJump(r, CONFIG.RAMP_JUMP_VELOCITY_BIG); r.speedMult = Math.max(r.speedMult, 1.1); }
  },
  {
    key: 'small_hill', label: '小さな坂', color: '#8a6d3b', width: 60, auto: true,
    effect(r) { doJump(r, CONFIG.RAMP_JUMP_VELOCITY_SMALL); }
  },
  {
    key: 'big_hill', label: '大きな坂', color: '#6b4f2a', width: 80, auto: true,
    effect(r) { doJump(r, CONFIG.RAMP_JUMP_VELOCITY_BIG + 60); }
  },
  {
    key: 'grass', label: '草むら', color: '#3fae55', width: 140, needsJump: false, zone: true,
    effect(r) { r.speedMult = Math.min(r.speedMult, 0.55); }
  },
  {
    key: 'rock', label: '岩', color: '#8a8a92', width: 40, needsJump: true,
    effect(r) { stunRacer(r, CONFIG.STUN_TIME, 'fall'); }
  },
  {
    key: 'crater', label: 'クレーター', color: '#211f1f', width: 70, needsJump: true,
    effect(r) { stunRacer(r, CONFIG.CRATER_STUN_TIME, 'fall'); }
  },
  {
    key: 'oil', label: 'オイル', color: '#2b2b3d', width: 60, needsJump: true,
    effect(r) { r.spinTimer = 1.2; r.speedMult = Math.min(r.speedMult, 0.75); }
  },
  {
    key: 'bump', label: '段差', color: '#7d7d55', width: 30, needsJump: true,
    effect(r) { r.speedMult = Math.min(r.speedMult, 0.8); shakeScreen(3); }
  },
  {
    key: 'barricade', label: 'バリケード', color: '#ff3b57', width: 40, needsJump: true,
    effect(r) { stunRacer(r, CONFIG.STUN_TIME + 0.6, 'fall'); r.x -= 30; }
  },
  {
    key: 'broken_road', label: '壊れた道路', color: '#55443a', width: 160, zone: true,
    effect(r) { r.speedMult = Math.min(r.speedMult, 0.7); shakeScreen(1.2); }
  },
];

/* ============================== アイテム(武器)定義 ============================== */
const WEAPON_TYPES = ['crossbow', 'big_missile', 'homing', 'laser', 'trap'];

/* ============================== グローバル状態 ============================== */
const state = {
  entries: [
    { role: 'player', name: 'PLAYER', color: DEFAULT_COLORS[0], img: null },
    { role: 'cpu', name: 'IRON-01', color: DEFAULT_COLORS[1], img: null },
    { role: 'cpu', name: 'HELL DOG', color: DEFAULT_COLORS[2], img: null },
    { role: 'cpu', name: 'MECHA KING', color: DEFAULT_COLORS[3], img: null },
  ],
  racers: [],
  obstacles: [],
  itemBoxes: [],
  projectiles: [],
  particles: [],
  traps: [],
  background: 'sea',
  totalDistance: CONFIG.LAP_LENGTH * CONFIG.LAPS,
  camera: { x: 0, shake: 0 },
  raceStarted: false,
  raceFinished: false,
  countdownValue: 3,
  lastTime: 0,
  hitStopTimer: 0,
  keys: {},
};

/* ============================== 設定画面構築 ============================== */
function buildSettingsUI() {
  const list = document.getElementById('entryList');
  list.innerHTML = '';
  state.entries.forEach((entry, idx) => {
    const card = document.createElement('div');
    card.className = 'entry-card ' + (entry.role === 'player' ? 'player' : 'cpu');

    const label = document.createElement('span');
    label.className = 'entry-label';
    label.textContent = entry.role === 'player' ? 'PLAYER' : `CPU ${idx}`;
    card.appendChild(label);

    // 画像ドロップゾーン（クリックでファイル選択、ドラッグ&ドロップにも対応）
    const dz = document.createElement('div');
    dz.className = 'drop-zone';
    const placeholder = document.createElement('div');
    placeholder.className = 'dz-placeholder';
    placeholder.textContent = 'クリック または 画像をドラッグ＆ドロップ';
    dz.appendChild(placeholder);

    const previewImg = document.createElement('img');
    previewImg.style.display = 'none';
    dz.appendChild(previewImg);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    dz.appendChild(fileInput);

    function applyFile(file) {
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        entry.img = new Image();
        entry.img.src = e.target.result;
        previewImg.src = e.target.result;
        previewImg.style.display = 'block';
        placeholder.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    dz.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => applyFile(e.target.files[0]));
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); dz.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) applyFile(e.dataTransfer.files[0]);
    });

    card.appendChild(dz);

    // 名前入力
    const nameInput = document.createElement('input');
    nameInput.className = 'name-input';
    nameInput.maxLength = 14;
    nameInput.value = entry.name;
    nameInput.addEventListener('input', () => { entry.name = nameInput.value || entry.name; });
    card.appendChild(nameInput);

    list.appendChild(card);
  });
}

document.getElementById('startBtn').addEventListener('click', () => {
  SFX.ensureAudio(); // ユーザー操作のタイミングでAudioContextを起動（自動再生制限対策）
  tryLockLandscape();
  document.getElementById('settingsScreen').classList.add('hidden');
  document.getElementById('gameContainer').classList.remove('hidden');
  initRace();
});

/* 横向き固定のベストエフォート処理。対応ブラウザ・PWA以外では失敗しても無視する */
function tryLockLandscape() {
  try {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {}).then(() => {
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      });
    } else if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  } catch (e) { /* ロックできない環境では無視。CSSのローテート案内で対応 */ }
}

document.getElementById('restartBtn').addEventListener('click', () => {
  document.getElementById('resultScreen').classList.add('hidden');
  document.getElementById('settingsScreen').classList.remove('hidden');
});

/* ============================== Racer クラス ============================== */
class Racer {
  constructor(entry, index, startLane) {
    this.entry = entry;
    this.index = index;
    this.isPlayer = entry.role === 'player';
    this.name = entry.name;
    this.img = entry.img; // 未設定なら null（描画時にプレースホルダーを使用）
    this.color = entry.color;

    this.lane = startLane;
    this.laneVisual = this.lane;   // 描画用（滑らかに補間される値）
    this.x = 0;                    // ワールド座標上の進行距離
    this.speedMult = 1;            // 毎フレームリセットされる速度倍率（障害物用）
    this.baseSpeed = CONFIG.BASE_SPEED + (this.isPlayer ? 0 : rand(-CONFIG.MAX_SPEED_CPU_VARIANCE, CONFIG.MAX_SPEED_CPU_VARIANCE));
    this.currentSpeed = 0;

    this.turboGauge = 0;
    this.overheated = false;
    this.turboActive = false;

    this.z = 0; this.vz = 0; this.jumping = false;
    this.stunTimer = 0;
    this.invincibleTimer = 0;
    this.spinTimer = 0;
    this.hitFlashTimer = 0;

    this.heldItems = [];           // 所持アイテム（最大2個・'crossbow' 等の配列）
    this.cpuItemUseAt = 0;         // CPU用: このタイマーが0になったら使用

    this.finished = false;
    this.finishOrder = null;
    this.rank = null;

    this.cpuTargetLane = this.lane;
    this.cpuRepathTimer = 0;
  }

  get totalProgress() { return this.x; }
  get lap() { return Math.min(CONFIG.LAPS, Math.floor(this.x / CONFIG.LAP_LENGTH) + 1); }
}

/* ============================== ジャンプ／スタン 補助関数 ============================== */
function doJump(racer, velocity) {
  if (racer.jumping) return;
  racer.jumping = true;
  racer.vz = velocity;
  if (racer.isPlayer) SFX.jump();
}
function stunRacer(racer, time, kind) {
  if (racer.stunTimer > 0 || racer.invincibleTimer > 0) return; // スタン中・無敵中は再ダメージを受けない
  racer.stunTimer = time;
  racer.invincibleTimer = time + CONFIG.INVINCIBLE_TIME; // スタン終了後もしばらく無敵が続く
  racer.speedMult = 0;
  racer.hitFlashTimer = 0.5;
  spawnExplosion(racer.x, racer.lane, kind === 'fall' ? 'small' : 'medium');
  triggerHitStop();
  if (racer.isPlayer) SFX.hit();
}
function shakeScreen(amount) { state.camera.shake = Math.max(state.camera.shake, amount); }
function triggerHitStop() { state.hitStopTimer = Math.max(state.hitStopTimer, CONFIG.HIT_STOP_TIME); }

/* ============================== コース生成 ============================== */
function generateTrack() {
  state.obstacles = [];
  state.itemBoxes = [];
  state.background = choice(CONFIG.CANVAS_BG_LIST);

  const totalLen = state.totalDistance;
  // 各レーンごとに、最小間隔を空けながら障害物をランダム配置
  for (let lane = 0; lane < CONFIG.LANES; lane++) {
    let x = rand(500, 900); // スタート直後は少し猶予を持たせる
    while (x < totalLen - 400) {
      x += rand(CONFIG.OBSTACLE_MIN_GAP, CONFIG.OBSTACLE_MIN_GAP * 2.2);
      if (x >= totalLen - 400) break;
      const type = choice(OBSTACLE_TYPES);
      state.obstacles.push({ x, lane, type, cleared: new Set() });
    }
  }

  // SAFE_LANE_GUARANTEE: 同じX付近で全レーンが塞がれないよう、密集エリアをチェックして間引く
  if (CONFIG.SAFE_LANE_GUARANTEE) {
    const sorted = state.obstacles.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      const near = sorted.filter(o => Math.abs(o.x - sorted[i].x) < 90);
      if (near.length >= CONFIG.LANES) {
        // 1つランダムに間引く（安全レーンを確保）
        const remove = near[randInt(0, near.length - 1)];
        const idx = state.obstacles.indexOf(remove);
        if (idx >= 0) state.obstacles.splice(idx, 1);
      }
    }
  }

  // アイテムボックス配置
  let ix = rand(600, 1000);
  while (ix < totalLen - 300) {
    state.itemBoxes.push({ x: ix, lane: randInt(0, CONFIG.LANES - 1), taken: false });
    ix += rand(CONFIG.ITEM_BOX_GAP * 0.6, CONFIG.ITEM_BOX_GAP * 1.4);
  }
}

/* ============================== レース初期化 ============================== */
function initRace() {
  // プレースホルダー画像の割当（未設定のロボット用）
  state.entries.forEach((e) => {
    if (!e.img) {
      const img = new Image();
      img.src = generatePlaceholderRobot(e.color);
      e.img = img;
    }
  });

  // スタート時に各ロボットが同じレーンに重ならないよう、レーン番号をシャッフルして1体ずつ割り当てる
  const shuffledLanes = Array.from({ length: CONFIG.LANES }, (_, i) => i);
  for (let i = shuffledLanes.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [shuffledLanes[i], shuffledLanes[j]] = [shuffledLanes[j], shuffledLanes[i]];
  }
  state.racers = state.entries.map((e, i) => new Racer(e, i, shuffledLanes[i % CONFIG.LANES]));
  state.projectiles = [];
  state.particles = [];
  state.traps = [];
  state.screenFlashes = [];
  state.raceStarted = false;
  state.raceFinished = false;
  state.countdownValue = 3;
  state.finishCounter = 0;
  state._prevPlayerLap = undefined;
  generateTrack();
  resizeCanvas();

  state.countdownEl = document.getElementById('countdown');
  state.countdownEl.classList.remove('hidden');
  runCountdown();

  state.lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

function runCountdown() {
  state.countdownValue = 3;
  state.countdownEl.textContent = state.countdownValue;
  SFX.countdownTick();
  const iv = setInterval(() => {
    state.countdownValue--;
    if (state.countdownValue <= 0) {
      state.countdownEl.textContent = 'GO!';
      SFX.go();
      setTimeout(() => { state.countdownEl.classList.add('hidden'); }, 500);
      state.raceStarted = true;
      clearInterval(iv);
    } else {
      state.countdownEl.textContent = state.countdownValue;
      SFX.countdownTick();
    }
  }, 800);
}

/* ============================== 入力管理 ============================== */
window.addEventListener('keydown', (e) => {
  state.keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });

function bindTouchButton(id, onDown, onUp) {
  const el = document.getElementById(id);
  const down = (e) => { e.preventDefault(); onDown(); };
  const up = (e) => { e.preventDefault(); if (onUp) onUp(); };
  el.addEventListener('touchstart', down, { passive: false });
  el.addEventListener('touchend', up, { passive: false });
  el.addEventListener('mousedown', down);
  el.addEventListener('mouseup', up);
}
bindTouchButton('btnUp', () => state.keys['touchUp'] = true, () => state.keys['touchUp'] = false);
bindTouchButton('btnDown', () => state.keys['touchDown'] = true, () => state.keys['touchDown'] = false);
bindTouchButton('btnJump', () => state.keys['touchJump'] = true, () => state.keys['touchJump'] = false);
bindTouchButton('btnAttack', () => state.keys['touchAttack'] = true, () => state.keys['touchAttack'] = false);
bindTouchButton('btnTurbo', () => state.keys['touchTurbo'] = true, () => state.keys['touchTurbo'] = false);

function readPlayerInput() {
  return {
    up: state.keys['ArrowUp'] || state.keys['touchUp'],
    down: state.keys['ArrowDown'] || state.keys['touchDown'],
    jump: state.keys['Space'] || state.keys['touchJump'],
    attack: state.keys['KeyX'] || state.keys['touchAttack'],
    turbo: state.keys['ShiftLeft'] || state.keys['ShiftRight'] || state.keys['touchTurbo'],
  };
}

/* ============================== キャンバスサイズ ============================== */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
function resizeCanvas() {
  // iOS の visualViewport（実際に見えている領域）を優先的に使う。
  // window.innerWidth/Height だけに頼ると、ホーム画面追加後のスタンドアロン
  // 表示でアドレスバー分の高さがズレて計算され、タップ位置と描画位置が
  // 微妙にズレて見える原因になることがあるため。
  const vv = window.visualViewport;
  canvas.width = vv ? Math.round(vv.width) : window.innerWidth;
  canvas.height = vv ? Math.round(vv.height) : window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resizeCanvas);
}

/* ----------------------------------------------------------------------
   iOSのホーム画面追加(スタンドアロンPWA)モードで発生しやすい
   「実際にタップした位置より少し上(または下)が反応する」ズレ対策。

   主な原因は、ページがゴムのように伸び縮みする"ラバーバンドスクロール"や
   Safariのアドレスバーの出し引きによって、ページ自体が数十px単位で
   スクロールしてしまい、その状態で座標計算がズレることにある。
   そのため、ゲーム画面(タッチ操作エリア)では意図しないスクロール・
   ズームインタラクションを徹底的に無効化し、万一スクロールしてしまっても
   毎回 (0,0) に戻すようにしている。
   ---------------------------------------------------------------------- */
function lockScrollPosition() {
  window.scrollTo(0, 0);
}
window.addEventListener('load', lockScrollPosition);
window.addEventListener('orientationchange', () => {
  setTimeout(() => { lockScrollPosition(); resizeCanvas(); }, 300);
});
window.addEventListener('resize', lockScrollPosition);
document.addEventListener('scroll', lockScrollPosition, { passive: true });

// ゲーム画面・リザルト画面上でのピンチズーム／二本指操作／意図しないスクロールを抑止
// (設定画面は #settingsScreen 側で touch-action: pan-y を許可しているのでここでは除外する)
document.addEventListener('touchmove', (e) => {
  if (e.target.closest('#settingsScreen')) return;
  e.preventDefault();
}, { passive: false });

// ダブルタップによるズームも誤タップ判定の原因になるため防止する
let _lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - _lastTouchEnd <= 350) e.preventDefault();
  _lastTouchEnd = now;
}, { passive: false });

/* レーンのY座標を計算（トラックは画面の中央帯に描画） */
function laneY(laneIndex, h) {
  const trackTop = h * 0.30;
  const trackH = h * 0.46;
  const laneH = trackH / CONFIG.LANES;
  return trackTop + laneH * (laneIndex + 0.5);
}

/* ============================== メインループ ============================== */
function gameLoop(now) {
  let dt = (now - state.lastTime) / 1000;
  state.lastTime = now;
  dt = Math.min(dt, 0.05); // タブ切り替え等での大ジャンプ防止

  if (state.hitStopTimer > 0) {
    state.hitStopTimer -= dt;
    dt *= 0.05; // ヒットストップ中はほぼ静止
  }

  if (state.raceStarted && !state.raceFinished) {
    update(dt);
  } else if (state.racers.length) {
    // レース開始前（カウントダウン中）もカメラ位置だけは正しく保つ。
    // これをしないと「スタート時は画面端にいたのに、GO!の瞬間に中央付近へ
    // ワープする」という見た目のバグが発生する。
    const player = state.racers.find(r => r.isPlayer);
    updateCamera(0, player);
  }
  render();

  if (!state.raceFinished) requestAnimationFrame(gameLoop);
}

/* ============================== 更新処理 ============================== */
function update(dt) {
  const player = state.racers.find(r => r.isPlayer);
  const input = readPlayerInput();

  for (const r of state.racers) {
    r.speedMult = 1; // 障害物効果は毎フレーム再計算
    updateRacerCommon(r, dt);
    if (r.isPlayer) updatePlayerControl(r, input, dt);
    else updateCpuControl(r, dt);
    applyObstacles(r);
    applyItemBoxPickup(r);
    applyTraps(r);
    integrateMovement(r, dt);
  }

  updateProjectiles(dt);
  updateParticles(dt);
  updateCamera(dt, player);
  checkFinish();
}

function updateRacerCommon(r, dt) {
  // ターボゲージ／オーバーヒート
  if (r.turboActive && !r.overheated && r.stunTimer <= 0) {
    if (!r._turboWasActive && r.isPlayer) SFX.turboStart();
    r.turboGauge = clamp(r.turboGauge + CONFIG.TURBO_FILL_RATE * dt, 0, CONFIG.TURBO_GAUGE_MAX);
    if (r.turboGauge >= CONFIG.TURBO_GAUGE_MAX) {
      r.overheated = true;
      r.stunTimer = Math.max(r.stunTimer, CONFIG.OVERHEAT_STUN_TIME);
      if (r.isPlayer) SFX.overheat();
    }
  } else {
    r.turboGauge = clamp(r.turboGauge - CONFIG.TURBO_COOL_RATE * dt, 0, CONFIG.TURBO_GAUGE_MAX);
    if (r.turboGauge <= 0) r.overheated = false;
  }
  r._turboWasActive = r.turboActive && !r.overheated;

  // ジャンプ物理
  if (r.jumping) {
    r.z += r.vz * dt;
    r.vz -= CONFIG.GRAVITY * dt;
    if (r.z <= 0) { r.z = 0; r.vz = 0; r.jumping = false; }
  }

  // スタン／スピン タイマー
  if (r.stunTimer > 0) { r.stunTimer -= dt; if (r.stunTimer < 0) r.stunTimer = 0; }
  if (r.invincibleTimer > 0) { r.invincibleTimer -= dt; if (r.invincibleTimer < 0) r.invincibleTimer = 0; }
  if (r.spinTimer > 0) { r.spinTimer -= dt; }
  if (r.hitFlashTimer > 0) { r.hitFlashTimer -= dt; }

  // レーン位置の滑らかな補間
  r.laneVisual = lerp(r.laneVisual, r.lane, clamp(CONFIG.LANE_CHANGE_SPEED * dt, 0, 1));
}

function integrateMovement(r, dt) {
  if (r.finished) { r.currentSpeed = 0; return; }
  let speed = 0;
  if (r.stunTimer <= 0) {
    speed = r.baseSpeed * r.speedMult;
    if (r.turboActive && !r.overheated) speed *= CONFIG.TURBO_MULT;
    if (r.spinTimer > 0) speed *= 0.5; // オイルでのスピン中は減速
  }
  r.currentSpeed = speed;
  r.x += speed * dt;
  r.x = clamp(r.x, 0, state.totalDistance);

  // ゴール到達時刻を記録する（同着に見える clamp 後の座標ではなく、
  // 「何番目にゴールしたか」で最終順位を決めるためのバグ修正）
  if (r.x >= state.totalDistance && !r.finished) {
    r.finished = true;
    r.finishOrder = ++state.finishCounter;
  }
}

/* ---- プレイヤー操作 ---- */
function updatePlayerControl(r, input, dt) {
  if (r.stunTimer > 0) { r.turboActive = false; return; }

  if (r.spinTimer > 0) {
    // オイルでスピン中はレーンがランダムに揺れて操作しづらくなる
    if (Math.random() < 0.02) r.lane = clamp(r.lane + randInt(-1, 1), 0, CONFIG.LANES - 1);
  } else {
    if (input.up && !r._upLatch) { r.lane = clamp(r.lane - 1, 0, CONFIG.LANES - 1); }
    if (input.down && !r._downLatch) { r.lane = clamp(r.lane + 1, 0, CONFIG.LANES - 1); }
  }
  r._upLatch = input.up; r._downLatch = input.down;

  if (input.jump && !r._jumpLatch) doJump(r, CONFIG.JUMP_VELOCITY);
  r._jumpLatch = input.jump;

  r.turboActive = !!input.turbo && !r.overheated;

  if (input.attack && !r._attackLatch && r.heldItems.length) {
    useItem(r);
  }
  r._attackLatch = input.attack;
}

/* ---- CPU AI ---- */
function updateCpuControl(r, dt) {
  if (r.stunTimer > 0) { r.turboActive = false; return; }

  if (r.spinTimer > 0) return; // スピン中は制御不能

  // 前方の障害物を確認してレーン変更／ジャンプを判断
  const ahead = state.obstacles.filter(o => o.lane === r.lane && o.x > r.x && o.x - r.x < CONFIG.CPU_LOOKAHEAD);
  const nearest = ahead.sort((a, b) => a.x - b.x)[0];
  if (nearest) {
    if (nearest.type.auto) {
      // ジャンプ台/坂はそのまま踏んでOK（自動ジャンプで加速演出になる）
    } else if (nearest.type.needsJump) {
      // ジャンプで回避 or レーン変更で回避、を混合判断
      if (Math.random() < 0.5) {
        doJump(r, CONFIG.JUMP_VELOCITY);
      } else {
        tryLaneChangeAwayFrom(r, nearest.lane);
      }
    } else if (nearest.type.zone) {
      tryLaneChangeAwayFrom(r, nearest.lane);
    }
  }

  // ターボ判断：ゲージに余裕があり、たまに使う
  if (!r.overheated && r.turboGauge < CONFIG.TURBO_GAUGE_MAX * 0.7) {
    r.turboActive = Math.random() < CONFIG.CPU_TURBO_CHANCE * dt * 2;
  } else {
    r.turboActive = false;
  }

  // アイテム使用判断
  if (r.heldItems.length) {
    r.cpuItemUseAt -= dt;
    if (r.cpuItemUseAt <= 0) {
      useItem(r);
      if (r.heldItems.length) r.cpuItemUseAt = rand(CONFIG.CPU_ITEM_USE_DELAY[0], CONFIG.CPU_ITEM_USE_DELAY[1]);
    }
  }
}

function tryLaneChangeAwayFrom(r, badLane) {
  const candidates = [];
  for (let l = 0; l < CONFIG.LANES; l++) {
    if (l === badLane) continue;
    const blocked = state.obstacles.some(o => o.lane === l && Math.abs(o.x - r.x) < 160 && !o.type.auto);
    if (!blocked) candidates.push(l);
  }
  if (candidates.length) {
    // 現在のレーンに一番近い安全レーンを選ぶ
    candidates.sort((a, b) => Math.abs(a - r.lane) - Math.abs(b - r.lane));
    r.lane = candidates[0];
  }
}

/* ============================== 障害物適用 ============================== */
function applyObstacles(r) {
  for (const o of state.obstacles) {
    if (o.lane !== r.lane) continue;
    const halfW = o.type.width / 2;
    if (r.x > o.x - halfW && r.x < o.x + halfW) {
      const overJump = r.jumping && r.z > 18;
      if (o.type.needsJump && overJump) continue; // ジャンプで回避成功
      if (o.type.auto || o.type.zone) {
        // ジャンプ台・坂・草むら・壊れた道路は「衝突ダメージ」ではないので無敵時間に関係なく毎回適用
        o.type.effect(r);
        continue;
      }
      // ここから下は 岩・クレーター・オイル・段差・バリケード等の「衝突ダメージ系」障害物。
      // 無敵時間中は同じ障害物に触れ続けても連続でダメージを受けないようにする。
      if (r.invincibleTimer > 0) continue;
      o.type.effect(r);
    }
  }
}

/* ============================== アイテムボックス ============================== */
function applyItemBoxPickup(r) {
  if (r.heldItems.length >= CONFIG.MAX_ITEMS) return;
  for (const box of state.itemBoxes) {
    if (box.taken || box.lane !== r.lane) continue;
    if (Math.abs(r.x - box.x) < 30) {
      box.taken = true;
      r.heldItems.push(choice(WEAPON_TYPES));
      if (!r.isPlayer && r.heldItems.length === 1) r.cpuItemUseAt = rand(CONFIG.CPU_ITEM_USE_DELAY[0], CONFIG.CPU_ITEM_USE_DELAY[1]);
      spawnItemSparkleBurst(r.x, r.lane);
      if (r.isPlayer) SFX.itemGet();
      if (r.heldItems.length >= CONFIG.MAX_ITEMS) break;
    }
  }
}

/* ============================== トラップ判定 ============================== */
function applyTraps(r) {
  for (const t of state.traps) {
    if (t.triggered || t.lane !== r.lane || t.owner === r) continue;
    if (r.invincibleTimer > 0) continue; // 無敵中はトラップも反応しない
    if (Math.abs(r.x - t.x) < 26) {
      t.triggered = true;
      stunRacer(r, CONFIG.STUN_TIME, 'fall');
      spawnExplosion(t.x, t.lane, 'large');
    }
  }
  state.traps = state.traps.filter(t => !t.triggered || t.age < 0.6);
  state.traps.forEach(t => { if (t.triggered) t.age = (t.age || 0) + (1 / 60); });
}

/* ============================== アイテム使用（武器発動） ============================== */
function useItem(r) {
  if (!r.heldItems.length) return;
  const kind = r.heldItems.shift(); // 古い順（先に取った方）から使用する
  switch (kind) {
    case 'crossbow': fireCrossbow(r); if (r.isPlayer) SFX.fireCrossbow(); break;
    case 'big_missile': fireBigMissile(r); if (r.isPlayer) SFX.fireMissile(); break;
    case 'homing': fireHomingMissiles(r); if (r.isPlayer) SFX.fireHoming(); break;
    case 'laser': fireLaser(r); if (r.isPlayer) SFX.fireLaser(); break;
    case 'trap': placeTrap(r); if (r.isPlayer) SFX.fireTrap(); break;
  }
}

/* 武器発射の瞬間に出す派手なマズルフラッシュ（発射位置から前方に飛び散る火花） */
function spawnMuzzleBurst(x, lane, color, count = 20) {
  for (let i = 0; i < count; i++) {
    state.particles.push({
      kind: 'spark', x: x + rand(0, 20), lane,
      vx: rand(80, 320), vy: rand(-160, 160), life: rand(0.25, 0.55),
      color,
    });
  }
  state.particles.push({ kind: 'flash', x, lane, vx: 0, vy: 0, life: 0.3, maxLife: 0.3, color: '#ffffff' });
}

function fireCrossbow(r) {
  const count = 9;
  for (let i = 0; i < count; i++) {
    const spread = (i - (count - 1) / 2) * 0.55; // 扇状展開（レーンオフセットとして使用）
    state.projectiles.push({
      type: 'crossbow', owner: r, x: r.x, lane: r.lane, laneOffset: spread,
      speed: 900 + rand(-40, 40), life: 0.9, color: '#28f2ff',
    });
  }
  spawnMuzzleBurst(r.x, r.lane, '#28f2ff', 24);
  triggerScreenFlash('#28f2ff', 0.22, 1.4);
  shakeScreen(5);
}
function fireBigMissile(r) {
  state.projectiles.push({
    type: 'big_missile', owner: r, x: r.x, lane: r.lane, laneOffset: 0,
    speed: 560, life: 3.0, color: '#ff3b57', big: true,
  });
  spawnMuzzleBurst(r.x, r.lane, '#ffb930', 30);
  for (let i = 0; i < 14; i++) spawnSmoke(r.x - rand(0, 30), r.lane);
  triggerScreenFlash('#ff3b57', 0.3, 1.1);
  shakeScreen(9);
  triggerHitStop();
}
function fireHomingMissiles(r) {
  const targets = state.racers.filter(o => o !== r);
  for (let i = 0; i < 20; i++) {
    state.projectiles.push({
      type: 'homing', owner: r, x: r.x + rand(-20, 20), lane: r.lane, laneOffset: rand(-0.3, 0.3),
      speed: 620 + rand(-30, 60), life: 2.6, color: '#ffb930',
      target: targets[i % targets.length], smokeTimer: 0,
    });
  }
  spawnMuzzleBurst(r.x, r.lane, '#ffb930', 40);
  triggerScreenFlash('#ffb930', 0.28, 1.2);
  shakeScreen(10);
}
function fireLaser(r) {
  state.projectiles.push({
    type: 'laser', owner: r, x: r.x, lane: r.lane, life: 0.35, color: '#28f2ff', width: 5000,
  });
  // レーザーは即時判定：同レーン + 隣接レーン（反射想定）にいる前方の敵を全てヒット
  for (const o of state.racers) {
    if (o === r || o.invincibleTimer > 0) continue;
    const laneDiff = Math.abs(o.lane - r.lane);
    if (laneDiff <= 1 && o.x > r.x - 40 && o.x < r.x + 2200) {
      stunRacer(o, CONFIG.STUN_TIME, 'fall');
      spawnExplosion(o.x, o.lane, 'large'); // 攻撃命中は必ずはっきり爆発させる
      if (o.isPlayer || r.isPlayer) SFX.explosion(true);
    }
  }
  spawnMuzzleBurst(r.x, r.lane, '#ffffff', 26);
  triggerScreenFlash('#ffffff', 0.4, 1.6);
  shakeScreen(14);
  triggerHitStop();
}
function placeTrap(r) {
  state.traps.push({ x: r.x - 60, lane: r.lane, owner: r, triggered: false });
  // 設置時にも小さな砂煙と閃光を出す
  for (let i = 0; i < 10; i++) spawnSmoke(r.x - 60 + rand(-10, 10), r.lane);
  state.particles.push({ kind: 'flash', x: r.x - 60, lane: r.lane, vx: 0, vy: 0, life: 0.2, maxLife: 0.2, color: '#ff3b57' });
}

/* ============================== 発射物の更新 ============================== */
function updateProjectiles(dt) {
  for (const p of state.projectiles) {
    p.life -= dt;
    if (p.type === 'homing' && p.target) {
      // 目標のレーン・X位置に緩やかに寄っていく
      const desiredLane = p.target.lane;
      p.laneOffset = lerp(p.laneOffset, (desiredLane - p.lane), 4 * dt);
      p.smokeTimer -= dt;
      if (p.smokeTimer <= 0) { spawnSmoke(p.x, p.lane + p.laneOffset); p.smokeTimer = 0.04; }
    }
    p.x += p.speed * dt;

    // 命中判定（自分以外のレーサーと衝突していないかチェック）
    for (const o of state.racers) {
      if (o === p.owner || p.hit) continue;
      if (o.invincibleTimer > 0) continue; // 無敵中はダメージ無視（すり抜ける）
      const effectiveLane = p.lane + (p.laneOffset || 0);
      if (Math.abs(effectiveLane - o.lane) < 0.5 && Math.abs(p.x - o.x) < (p.big ? 70 : 34)) {
        p.hit = true; p.life = 0;
        stunRacer(o, CONFIG.STUN_TIME, 'fall');
        spawnExplosion(o.x, o.lane, p.big ? 'large' : 'medium');
        if (o.isPlayer || p.owner.isPlayer) SFX.explosion(!!p.big);
        if (p.big) {
          // 大型ミサイルは爆風で近隣レーンにも被害
          for (const near of state.racers) {
            if (near === o || near === p.owner) continue;
            if (Math.abs(near.x - o.x) < 130 && Math.abs(near.lane - o.lane) <= 1) {
              stunRacer(near, CONFIG.STUN_TIME, 'fall');
            }
          }
        }
      }
    }
  }
  state.projectiles = state.projectiles.filter(p => p.life > 0 && !p.hit);
}

/* ============================== パーティクル（爆発・煙・花火・紙吹雪） ============================== */
function spawnExplosion(x, lane, size) {
  const n = size === 'large' ? 46 : size === 'medium' ? 30 : 16;
  for (let i = 0; i < n; i++) {
    state.particles.push({
      kind: 'spark', x, lane, y0: 0,
      vx: rand(-220, 220), vy: rand(-320, -60), life: rand(0.35, 0.85),
      color: choice(['#ffb930', '#ff3b57', '#fff2c2', '#28f2ff', '#ff4fd8']),
    });
  }
  for (let i = 0; i < n / 2; i++) {
    state.particles.push({
      kind: 'smoke', x, lane, y0: 0,
      vx: rand(-40, 40), vy: rand(-80, -20), life: rand(0.6, 1.3),
      color: 'rgba(120,120,130,0.65)',
    });
  }
  // 中心に一瞬だけ広がる閃光リング（派手な爆発演出）
  state.particles.push({ kind: 'flash', x, lane, vx: 0, vy: 0, life: size === 'large' ? 0.4 : 0.25, maxLife: size === 'large' ? 0.4 : 0.25, color: size === 'large' ? '#fff2c2' : '#ffffff' });
  if (size === 'large') {
    state.particles.push({ kind: 'flash', x, lane, vx: 0, vy: 0, life: 0.55, maxLife: 0.55, color: '#ff3b57' });
  }
  shakeScreen(size === 'large' ? 16 : size === 'medium' ? 9 : 4);
}
function spawnSmoke(x, lane) {
  state.particles.push({ kind: 'smoke', x, lane, vx: rand(-10, 10), vy: rand(-20, -5), life: 0.4, color: 'rgba(200,200,210,0.5)' });
}
/* アイテムボックスの周りにキラキラ浮かぶ虹色パーティクル（派手な演出用） */
function spawnItemSparkle(x, lane) {
  state.particles.push({
    kind: 'sparkle', x: x + rand(-16, 16), lane,
    vx: rand(-20, 20), vy: rand(-50, -10), life: rand(0.4, 0.8),
    color: `hsl(${randInt(0, 360)}, 100%, 65%)`,
  });
}
/* アイテム取得時の派手な閃光バースト */
function spawnItemSparkleBurst(x, lane) {
  for (let i = 0; i < 18; i++) spawnItemSparkle(x, lane);
  state.particles.push({ kind: 'flash', x, lane, vx: 0, vy: 0, life: 0.25, maxLife: 0.25, color: '#ffffff' });
}
function updateParticles(dt) {
  for (const p of state.particles) {
    p.life -= dt;
    p.x += (p.vx || 0) * dt;
    p.laneOffsetPx = (p.laneOffsetPx || 0) + (p.vy || 0) * dt;
  }
  state.particles = state.particles.filter(p => p.life > 0);
  if (state.camera.shake > 0) state.camera.shake = Math.max(0, state.camera.shake - CONFIG.SCREEN_SHAKE_DECAY * dt * 10);
}

/* ============================== カメラ ============================== */
function updateCamera(dt, player) {
  state.camera.x = player.x - canvas.width * 0.28;
}

/* ============================== 順位・周回・ゴール判定 ============================== */
/*
  重要: ゴールした選手は x が totalDistance で頭打ち（clamp）になるため、
  「x が大きい順」だけで並べると、4位の選手も1位の選手も同じ x 値になり
  同着扱いになってしまう（＝表彰台の順位がおかしくなるバグの原因）。
  そのため、ゴール済みの選手は「何番目にゴールしたか(finishOrder)」を優先し、
  まだ完走していない選手だけを x の大きい順に並べるようにしている。
*/
function computeRanks() {
  const finishedRacers = state.racers.filter(r => r.finished)
    .sort((a, b) => a.finishOrder - b.finishOrder);
  const unfinished = state.racers.filter(r => !r.finished)
    .sort((a, b) => b.x - a.x);
  const ordered = finishedRacers.concat(unfinished);
  ordered.forEach((r, i) => { r.rank = i + 1; });
}
function checkFinish() {
  computeRanks();
  const player = state.racers.find(r => r.isPlayer);
  if (!state.raceFinished && player.finished) {
    state.raceFinished = true;
    computeRanks();
    SFX.finish();
    setTimeout(showResults, 600);
  }
  updateHud(player);
}

/* ============================== HUD 更新 ============================== */
function updateHud(player) {
  if (state._prevPlayerLap === undefined) state._prevPlayerLap = player.lap;
  if (player.lap !== state._prevPlayerLap) {
    state._prevPlayerLap = player.lap;
    if (!state.raceFinished) SFX.lap();
  }
  document.getElementById('hudRank').textContent = `${player.rank}/${state.racers.length}`;
  document.getElementById('hudLap').textContent = `${player.lap}/${CONFIG.LAPS}`;
  document.getElementById('hudSpeed').textContent = String(Math.round(player.currentSpeed)).padStart(3, '0');
  document.getElementById('hudItem').textContent = player.heldItems.length
    ? player.heldItems.map(itemLabel).join(' / ')
    : '--';

  const fill = document.getElementById('turboFill');
  fill.style.width = `${(player.turboGauge / CONFIG.TURBO_GAUGE_MAX) * 100}%`;
  fill.classList.toggle('overheat', player.overheated);
}
function itemLabel(k) {
  return { crossbow: 'ボーガン', big_missile: 'ミサイル', homing: '追跡弾', laser: 'レーザー', trap: 'トラップ' }[k] || k;
}

/* ============================== 描画 ============================== */
function render() {
  const w = canvas.width, h = canvas.height;
  ctx.save();

  // 画面シェイク
  if (state.camera.shake > 0.1) {
    ctx.translate(rand(-state.camera.shake, state.camera.shake), rand(-state.camera.shake, state.camera.shake));
  }

  drawBackground(w, h);
  drawTrack(w, h);
  drawItemBoxesAndTraps(w, h);
  drawObstacles(w, h);
  drawProjectiles(w, h);
  drawRacers(w, h);
  drawParticles(w, h);

  ctx.restore();

  drawPositionOverview(w, h);
  drawScreenFlash(w, h);
}

/* ============================== 位置関係の全容（ミニマップ） ==============================
   画面外にいる他のロボットが、今どれくらい離れているかが分かるように、
   画面上部にレース全体の進行状況を横棒で表示する。
   ================================================================================ */
function drawPositionOverview(w, h) {
  if (!state.racers.length) return;
  const barX = w * 0.28, barW = w * 0.44;
  const barY = h * 0.155, barH = 10;

  // 背景バー
  ctx.fillStyle = 'rgba(11,13,20,0.6)';
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  roundRectPath(ctx, barX, barY, barW, barH, 5);
  ctx.fill(); ctx.stroke();

  // 周回の区切り（1周ごとの目盛り）
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  for (let l = 1; l < CONFIG.LAPS; l++) {
    const lx = barX + (l / CONFIG.LAPS) * barW;
    ctx.beginPath(); ctx.moveTo(lx, barY - 2); ctx.lineTo(lx, barY + barH + 2); ctx.stroke();
  }

  // ゴール表記
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('GOAL', barX + barW + 4, barY + barH - 1);

  // 各ロボットの位置を丸印で表示（プレイヤーは大きめ＆金色の輪で強調）
  const ordered = state.racers.slice().sort((a, b) => a.x - b.x);
  for (const r of ordered) {
    const t = clamp(r.x / state.totalDistance, 0, 1);
    const px = barX + t * barW;
    const py = barY + barH / 2;
    if (r.isPlayer) {
      ctx.strokeStyle = '#ffb930'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = r.color;
    ctx.beginPath(); ctx.arc(px, py, r.isPlayer ? 5.5 : 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.textAlign = 'left';
}

/* 角丸長方形のパスを作る小さなヘルパー */
function roundRectPath(c, x, y, w, h, r) {
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ============================== 画面フラッシュ（アイテム使用時の派手な演出用） ==============================
   武器発動の瞬間に画面全体を一瞬だけ発光させて「使った！」という手応えを強く出す。
   カメラのシェイクとは独立して、常に画面座標（スクリーン全体）に対して描画する。
   ================================================================================================ */
function triggerScreenFlash(color, alpha, decay) {
  state.screenFlashes = state.screenFlashes || [];
  state.screenFlashes.push({ color, alpha, decay, t: 0 });
}
function drawScreenFlash(w, h) {
  if (!state.screenFlashes || !state.screenFlashes.length) return;
  for (const f of state.screenFlashes) {
    f.t += 1 / 60;
    const a = Math.max(0, f.alpha - f.t * f.decay);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = f.color;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  state.screenFlashes = state.screenFlashes.filter(f => f.alpha - f.t * f.decay > 0);
}

function drawBackground(w, h) {
  const bg = state.background;
  const parallax = state.camera.x * 0.15;
  if (bg === 'sea') {
    const g = ctx.createLinearGradient(0, 0, 0, h * 0.3);
    g.addColorStop(0, '#0a2a4a'); g.addColorStop(1, '#155a8a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.3);
    ctx.fillStyle = '#0e4a72';
    for (let i = -1; i < 12; i++) {
      const x = ((i * 220) - (parallax % 220));
      ctx.beginPath(); ctx.arc(x, h * 0.28, 60, Math.PI, 0); ctx.fill();
    }
  } else if (bg === 'city') {
    const g = ctx.createLinearGradient(0, 0, 0, h * 0.3);
    g.addColorStop(0, '#1a1030'); g.addColorStop(1, '#3a1d4a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.3);
    for (let i = -1; i < 14; i++) {
      const x = ((i * 140) - (parallax % 140));
      const bh = 60 + ((i * 37) % 90);
      ctx.fillStyle = '#241238';
      ctx.fillRect(x, h * 0.3 - bh, 90, bh);
      ctx.fillStyle = '#ffcf6b';
      for (let wy = 8; wy < bh - 8; wy += 16) ctx.fillRect(x + 10, h * 0.3 - bh + wy, 8, 8);
    }
  } else if (bg === 'grass') {
    const g = ctx.createLinearGradient(0, 0, 0, h * 0.3);
    g.addColorStop(0, '#8fd6ff'); g.addColorStop(1, '#cdeeff');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.3);
    ctx.fillStyle = '#4caf6b';
    for (let i = -1; i < 10; i++) {
      const x = ((i * 260) - (parallax % 260));
      ctx.beginPath(); ctx.ellipse(x, h * 0.3, 140, 40, 0, 0, Math.PI * 2); ctx.fill();
    }
  } else { // mountain
    const g = ctx.createLinearGradient(0, 0, 0, h * 0.3);
    g.addColorStop(0, '#3a3f55'); g.addColorStop(1, '#6a7086');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.3);
    ctx.fillStyle = '#555c72';
    for (let i = -1; i < 8; i++) {
      const x = ((i * 300) - (parallax % 300));
      ctx.beginPath(); ctx.moveTo(x, h * 0.3); ctx.lineTo(x + 150, h * 0.3 - 130); ctx.lineTo(x + 300, h * 0.3); ctx.fill();
    }
  }
  // 地面
  ctx.fillStyle = '#1a1c26';
  ctx.fillRect(0, h * 0.3, w, h * 0.7);
}

function worldToScreenX(worldX) { return worldX - state.camera.x; }

function drawTrack(w, h) {
  const trackTop = h * 0.30, trackH = h * 0.46;

  // 道路本体：見やすい茶色のアスファルト（縞のグラデーションで軽い質感を出す）
  const roadGrad = ctx.createLinearGradient(0, trackTop, 0, trackTop + trackH);
  roadGrad.addColorStop(0, '#7a5738');
  roadGrad.addColorStop(0.5, '#6b4a30');
  roadGrad.addColorStop(1, '#5e3f28');
  ctx.fillStyle = roadGrad;
  ctx.fillRect(0, trackTop, w, trackH);

  // 走行によるうっすらとしたタイヤ痕（横スクロールに合わせて流れる）
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 3;
  const scrollOffset = state.camera.x % 90;
  for (let i = -1; i < w / 90 + 2; i++) {
    const x = i * 90 - scrollOffset;
    ctx.beginPath(); ctx.moveTo(x, trackTop + 6); ctx.lineTo(x + 30, trackTop + trackH - 6); ctx.stroke();
  }

  // レーンの区切り線（白の破線・視認性重視ではっきり描画）
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  for (let l = 1; l < CONFIG.LANES; l++) {
    const y = laneY(l - 1, h) + (laneY(l, h) - laneY(l - 1, h)) / 2;
    ctx.setLineDash([22, 16]);
    ctx.lineDashOffset = -state.camera.x;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  // コース両端の白い境界線（実線・太め）
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(0, trackTop + 3); ctx.lineTo(w, trackTop + 3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, trackTop + trackH - 3); ctx.lineTo(w, trackTop + trackH - 3); ctx.stroke();

  // ゴールライン（世界座標 totalDistance の位置に描画）
  const gx = worldToScreenX(state.totalDistance);
  if (gx > -40 && gx < w + 40) {
    ctx.save();
    ctx.translate(gx, 0);
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#fff' : '#111';
      ctx.fillRect(-6, trackTop + i * (trackH / 10), 12, trackH / 10);
    }
    ctx.restore();
  }
}

/* ----------------------------------------------------------------------
   障害物の見た目（文字ラベルではなく、種類ごとに実際の形を描画する）
   sx: 画面X座標（中心）  gy: 接地面のY座標（レーン中央 + 16px 相当）
   ---------------------------------------------------------------------- */
const OBSTACLE_DRAWERS = {
  jump_pad(sx, gy) {
    // 黄と黒の縞模様のジャンプ台（右肩上がりのスロープ）
    ctx.fillStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.moveTo(sx - 26, gy); ctx.lineTo(sx + 26, gy);
    ctx.lineTo(sx + 26, gy - 30); ctx.closePath(); ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx - 26, gy); ctx.lineTo(sx + 26, gy); ctx.lineTo(sx + 26, gy - 30); ctx.closePath();
    ctx.clip();
    ctx.fillStyle = '#ffb930';
    for (let i = -30; i < 60; i += 12) {
      ctx.beginPath();
      ctx.moveTo(sx - 26 + i, gy - 30); ctx.lineTo(sx - 26 + i + 6, gy - 30);
      ctx.lineTo(sx - 26 + i + 6 - 30, gy); ctx.lineTo(sx - 26 + i - 30, gy);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx - 26, gy); ctx.lineTo(sx + 26, gy - 30); ctx.stroke();
    // 上向き矢印で「跳ぶ」印象を強調
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(sx + 14, gy - 34); ctx.lineTo(sx + 22, gy - 46); ctx.lineTo(sx + 30, gy - 34); ctx.closePath(); ctx.fill();
  },
  small_hill(sx, gy) {
    const grad = ctx.createRadialGradient(sx, gy, 2, sx, gy, 26);
    grad.addColorStop(0, '#5aa860'); grad.addColorStop(1, '#3d7a44');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(sx, gy, 26, 20, 0, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(sx, gy, 26, 20, 0, Math.PI, Math.PI * 1.5); ctx.stroke();
  },
  big_hill(sx, gy) {
    const grad = ctx.createRadialGradient(sx, gy, 4, sx, gy, 40);
    grad.addColorStop(0, '#4f9a58'); grad.addColorStop(1, '#2c5e33');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(sx, gy, 40, 32, 0, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(sx, gy, 40, 32, 0, Math.PI, Math.PI * 1.4); ctx.stroke();
  },
  grass(sx, gy) {
    ctx.fillStyle = 'rgba(60,140,70,0.35)';
    ctx.fillRect(sx - 60, gy - 10, 120, 20);
    ctx.strokeStyle = '#3fae55'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = -56; i < 56; i += 10) {
      const wob = Math.sin((sx + i) / 14) * 4;
      ctx.beginPath();
      ctx.moveTo(sx + i, gy + 8);
      ctx.quadraticCurveTo(sx + i + wob, gy - 6, sx + i + wob * 1.4, gy - 20);
      ctx.stroke();
    }
  },
  rock(sx, gy) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(sx, gy + 4, 20, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8a8a92';
    ctx.beginPath();
    ctx.moveTo(sx - 18, gy); ctx.lineTo(sx - 20, gy - 14); ctx.lineTo(sx - 6, gy - 26);
    ctx.lineTo(sx + 10, gy - 22); ctx.lineTo(sx + 20, gy - 8); ctx.lineTo(sx + 16, gy);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(sx - 12, gy - 10); ctx.lineTo(sx - 4, gy - 20); ctx.lineTo(sx + 4, gy - 16); ctx.closePath(); ctx.fill();
  },
  crater(sx, gy) {
    ctx.fillStyle = '#4a3a28';
    ctx.beginPath(); ctx.ellipse(sx, gy, 34, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0e0a06';
    ctx.beginPath(); ctx.ellipse(sx, gy, 24, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,140,60,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(sx, gy, 30, 9, 0, 0, Math.PI * 2); ctx.stroke();
  },
  oil(sx, gy) {
    ctx.fillStyle = 'rgba(10,10,18,0.85)';
    ctx.beginPath(); ctx.ellipse(sx, gy, 34, 10, 0, 0, Math.PI * 2); ctx.fill();
    const t = performance.now() / 500;
    const colors = ['rgba(255,80,150,0.35)', 'rgba(80,180,255,0.35)', 'rgba(120,255,150,0.3)'];
    colors.forEach((c, i) => {
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(sx + Math.sin(t + i) * 4, gy, 24 - i * 6, 6 - i * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
  },
  bump(sx, gy) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(sx - 15, gy - 2, 30, 6);
    ctx.fillStyle = '#9a9a68';
    ctx.fillRect(sx - 15, gy - 12, 30, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(sx - 15, gy - 12, 30, 3);
  },
  barricade(sx, gy) {
    // 支柱
    ctx.fillStyle = '#333';
    ctx.fillRect(sx - 22, gy - 4, 6, 16);
    ctx.fillRect(sx + 16, gy - 4, 6, 16);
    // 縞模様のバー本体
    ctx.save();
    ctx.beginPath(); ctx.rect(sx - 26, gy - 30, 52, 18); ctx.clip();
    for (let i = -30; i < 60; i += 10) {
      ctx.fillStyle = (i / 10) % 2 === 0 ? '#ff3b57' : '#fff';
      ctx.beginPath();
      ctx.moveTo(sx - 26 + i, gy - 30); ctx.lineTo(sx - 26 + i + 10, gy - 30);
      ctx.lineTo(sx - 26 + i + 10 - 10, gy - 12); ctx.lineTo(sx - 26 + i - 10, gy - 12);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
    ctx.strokeRect(sx - 26, gy - 30, 52, 18);
  },
  broken_road(sx, gy) {
    ctx.fillStyle = 'rgba(20,16,12,0.55)';
    ctx.fillRect(sx - 80, gy - 10, 160, 20);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2;
    for (let i = -70; i < 70; i += 26) {
      ctx.beginPath();
      ctx.moveTo(sx + i, gy - 9);
      ctx.lineTo(sx + i + 8, gy - 1);
      ctx.lineTo(sx + i - 4, gy + 5);
      ctx.lineTo(sx + i + 10, gy + 9);
      ctx.stroke();
    }
    ctx.fillStyle = '#5a534a';
    for (let i = -60; i < 60; i += 24) {
      ctx.beginPath(); ctx.arc(sx + i, gy + 4, 4, 0, Math.PI * 2); ctx.fill();
    }
  },
};

function drawObstacles(w, h) {
  for (const o of state.obstacles) {
    const sx = worldToScreenX(o.x);
    if (sx < -100 || sx > w + 100) continue;

    const laneTop = laneY(o.lane, h) - (h * 0.46 / CONFIG.LANES) / 2;
    const laneBottom = laneY(o.lane, h) + (h * 0.46 / CONFIG.LANES) / 2;
    const highlightW = Math.max(50, o.type.width * 0.45);

    // どのレーンの障害物かひと目で分かるよう、そのレーンの床全体を
    // 障害物の色でうっすら照らすハイライト帯を先に描く
    ctx.fillStyle = hexToRgba(o.type.color, 0.16);
    ctx.fillRect(sx - highlightW / 2, laneTop + 2, highlightW, laneBottom - laneTop - 4);

    // 接地面は「レーン下端寄りだが、隣のレーンとの境界線には掛からない」高さに固定
    const gy = laneBottom - 12; // 下のレーンにはみ出さないよう余白を広めに取る
    const drawer = OBSTACLE_DRAWERS[o.type.key];
    if (drawer) drawer(sx, gy);
  }
}

/* '#rrggbb' 形式の色を rgba(...) 文字列に変換するヘルパー（レーンハイライト用） */
function hexToRgba(hex, alpha) {
  const h6 = hex.replace('#', '');
  const r = parseInt(h6.substring(0, 2), 16);
  const g = parseInt(h6.substring(2, 4), 16);
  const b = parseInt(h6.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawItemBoxesAndTraps(w, h) {
  const now = performance.now();
  for (const box of state.itemBoxes) {
    if (box.taken) continue;
    const sx = worldToScreenX(box.x);
    if (sx < -100 || sx > w + 100) continue;
    const sy = laneY(box.lane, h);
    const pulse = 1 + Math.sin(now / 160 + box.x) * 0.18;
    const size = 21 * pulse; // サイズは元の大きさに戻す（派手さは使用時のアクション側で表現）

    ctx.save();
    ctx.translate(sx, sy);

    // 背後に回転する光の放射（ド派手な後光演出）
    ctx.save();
    ctx.rotate(-(now / 300) % (Math.PI * 2));
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      ctx.save();
      ctx.rotate(ang);
      const rayGrad = ctx.createLinearGradient(0, 0, 0, -size * 2.2);
      rayGrad.addColorStop(0, `hsla(${(now / 3 + i * 45) % 360},100%,65%,0.55)`);
      rayGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rayGrad;
      ctx.fillRect(-4, -size * 2.2, 8, size * 2.2);
      ctx.restore();
    }
    ctx.restore();

    // 外周のパルスリング
    ctx.strokeStyle = `hsl(${(now / 4) % 360}, 100%, 65%)`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, size * 1.35, 0, Math.PI * 2); ctx.stroke();

    // 本体（虹色グラデーション回転キューブ）
    ctx.shadowBlur = 34;
    ctx.shadowColor = `hsl(${(now / 4) % 360}, 100%, 60%)`;
    ctx.rotate((now / 500) % (Math.PI * 2));
    const grad = ctx.createLinearGradient(-size, -size, size, size);
    grad.addColorStop(0, '#ff3b57');
    grad.addColorStop(0.33, '#ffb930');
    grad.addColorStop(0.66, '#28f2ff');
    grad.addColorStop(1, '#ff4fd8');
    ctx.fillStyle = grad;
    ctx.fillRect(-size, -size, size * 2, size * 2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.strokeRect(-size, -size, size * 2, size * 2);
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(size * 0.9)}px monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', sx, sy + 1);

    // キラキラ粒子を頻繁に放出して目立たせる
    if (Math.random() < 0.35) spawnItemSparkle(box.x, box.lane);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  for (const t of state.traps) {
    const sx = worldToScreenX(t.x);
    if (sx < -60 || sx > w + 60) continue;
    const sy = laneY(t.lane, h);
    if (t.triggered) continue;
    if (assetReady('trap')) {
      drawAssetImage(assetImages.trap, sx, sy + 16, 44);
    } else {
      // 代替描画：点滅する警告地雷
      const blink = Math.sin(now / 150) > 0;
      ctx.fillStyle = blink ? '#ff3b57' : '#7a1020';
      ctx.beginPath(); ctx.arc(sx, sy + 8, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath(); ctx.arc(sx, sy + 8, 13, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        ctx.fillRect(sx + Math.cos(ang) * 12 - 1.5, sy + 8 + Math.sin(ang) * 12 - 1.5, 3, 3);
      }
    }
  }
}

/* 画像アセットを縦横比を保ったまま指定の目標サイズに収めて描画する共通ヘルパー
   (x, groundY) は接地位置（画像下端の中心）を表す */
function drawAssetImage(img, x, groundY, targetSize) {
  const scale = targetSize / Math.max(img.naturalWidth, img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  ctx.drawImage(img, x - dw / 2, groundY - dh, dw, dh);
}

function drawProjectiles(w, h) {
  const now = performance.now();
  for (const p of state.projectiles) {
    const sx = worldToScreenX(p.x);
    if (sx < -80 || sx > w + 80) continue;
    const sy = laneY(p.lane + (p.laneOffset || 0), h);

    if (p.type === 'laser') {
      const laserImg = assetReady('laserOrb') ? assetImages.laserOrb : null;
      const laneList = [p.lane - 1, p.lane, p.lane + 1].filter(l => l >= 0 && l < CONFIG.LANES);
      if (laserImg) {
        // 「円形の光の玉」を連ねてレーザーのように見せる（用意されたPNGを使用）
        const flow = (now / 8) % 50;
        laneList.forEach((l) => {
          const isMain = l === p.lane;
          const orbSize = (isMain ? 66 : 42); // 通常の2倍サイズで迫力を出す
          const spacing = 50;
          const oy = laneY(l, h);
          for (let ox = sx - 20 + flow; ox < w + 60; ox += spacing) {
            if (ox < -60) continue;
            const pulse = 1 + Math.sin(now / 60 + ox) * 0.15;
            ctx.save();
            ctx.globalAlpha = isMain ? 0.95 : 0.5;
            ctx.shadowBlur = 22;
            ctx.shadowColor = `hsl(${(now / 3) % 360}, 100%, 65%)`;
            drawAssetImage(laserImg, ox, oy + (orbSize * pulse) / 2, orbSize * pulse);
            ctx.restore();
          }
        });
        ctx.globalAlpha = 1;
      } else {
        // 画像未用意の場合の代替描画：色が高速で明滅する極太レーザー + グロー
        const hue = (now / 2) % 360;
        ctx.save();
        ctx.shadowBlur = 40;
        ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
        const beamW = 26 + Math.sin(now / 20) * 10;
        const grad = ctx.createLinearGradient(0, laneY(0, h) - 20, 0, laneY(CONFIG.LANES - 1, h) + 20);
        grad.addColorStop(0, `hsl(${hue}, 100%, 70%)`);
        grad.addColorStop(0.5, '#ffffff');
        grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 100%, 70%)`);
        ctx.fillStyle = grad;
        ctx.fillRect(sx - beamW / 2, laneY(0, h) - 20, beamW, laneY(CONFIG.LANES - 1, h) - laneY(0, h) + 40);
        ctx.restore();
      }
      continue;
    }

    // 進行方向に応じて画像を少し傾ける（レーンオフセットの変化速度から角度を推定）
    const angle = Math.atan2((p._prevLaneOffset !== undefined ? (p.laneOffset - p._prevLaneOffset) : 0) * 40, 12);
    p._prevLaneOffset = p.laneOffset || 0;

    if (p.type === 'crossbow') {
      if (assetReady('crossbow')) {
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(angle);
        drawAssetImage(assetImages.crossbow, 0, 16, 68); // 従来の2倍サイズ
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(sx, sy); ctx.rotate(angle);
        ctx.shadowBlur = 20; ctx.shadowColor = '#28f2ff';
        ctx.fillStyle = '#28f2ff';
        ctx.beginPath(); ctx.moveTo(-28, 0); ctx.lineTo(20, -8); ctx.lineTo(20, 8); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
      }
      continue;
    }

    if (p.type === 'big_missile' || p.type === 'homing') {
      const img = p.type === 'big_missile' ? (assetReady('missileBig') ? assetImages.missileBig : null) : homingAssetImage();
      const size = (p.big ? 54 : 30) * 2; // 従来の2倍サイズ
      if (img) {
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(angle);
        drawAssetImage(img, 0, size * 0.3, size);
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(sx, sy); ctx.rotate(angle);
        ctx.shadowBlur = p.big ? 30 : 20;
        ctx.shadowColor = p.color;
        ctx.fillStyle = p.color;
        const r = (p.big ? 16 : 8) * 2;
        ctx.beginPath(); ctx.ellipse(0, 0, r * 1.6, r, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.moveTo(r * 1.4, 0); ctx.lineTo(r * 2.4, -r * 0.6); ctx.lineTo(r * 2.4, r * 0.6); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      continue;
    }

    // その他予期しない種類のフォールバック
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.fill();
  }
}

function drawParticles(w, h) {
  for (const p of state.particles) {
    const sx = worldToScreenX(p.x);
    const sy = laneY(p.lane, h) + (p.laneOffsetPx || 0);
    ctx.globalAlpha = clamp(p.life, 0, 1);
    if (p.kind === 'flash') {
      const maxLife = p.maxLife || 0.25;
      const r = (1 - p.life / maxLife) * 70;
      ctx.strokeStyle = p.color; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.fillStyle = p.color;
    let size = 4;
    if (p.kind === 'smoke') size = 10;
    if (p.kind === 'sparkle') {
      size = 3;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(performance.now() / 120);
      ctx.fillRect(-size, -1, size * 2, 2);
      ctx.fillRect(-1, -size, 2, size * 2);
      ctx.restore();
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawRacers(w, h) {
  // xでソートして奥から手前へ描画（重なりを自然に）
  const ordered = state.racers.slice().sort((a, b) => a.x - b.x);
  for (const r of ordered) {
    const sx = worldToScreenX(r.x);
    if (sx < -80 || sx > w + 80) continue;
    const sy = laneY(r.laneVisual, h) - r.z * 0.35;

    // ターボ中は後方に派手な炎とスピードラインを表示
    if (r.turboActive && !r.overheated && r.stunTimer <= 0) {
      const flameLen = 26 + Math.sin(performance.now() / 40) * 8;
      const grad = ctx.createLinearGradient(sx - 20, sy, sx - 20 - flameLen, sy);
      grad.addColorStop(0, 'rgba(255,185,48,0.9)');
      grad.addColorStop(0.5, 'rgba(255,80,60,0.7)');
      grad.addColorStop(1, 'rgba(255,80,60,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(sx - 18, sy - 10);
      ctx.lineTo(sx - 18 - flameLen, sy);
      ctx.lineTo(sx - 18, sy + 10);
      ctx.closePath(); ctx.fill();
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = `rgba(40,242,255,${0.5 - i * 0.15})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx - 24 - i * 10, sy - 14 + i * 10);
        ctx.lineTo(sx - 40 - i * 10, sy - 14 + i * 10);
        ctx.stroke();
      }
    }

    // ヒットフラッシュ演出（被弾時に明滅）
    ctx.save();
    if (r.hitFlashTimer > 0 && Math.floor(r.hitFlashTimer * 20) % 2 === 0) {
      ctx.filter = 'brightness(2) saturate(0)';
    }
    // 無敵時間中は半透明で点滅させ、連続ダメージを受けない状態だと分かるようにする
    if (r.invincibleTimer > 0 && r.stunTimer <= 0) {
      ctx.globalAlpha = (Math.floor(performance.now() / 90) % 2 === 0) ? 0.4 : 0.85;
    }

    const img = r.img;
    const boxSize = 56;
    if (img && img.complete && img.naturalWidth > 0) {
      // 画像サイズが違っても box に収まるよう縦横比を保って調整
      const scale = Math.min(boxSize / img.naturalWidth, boxSize / img.naturalHeight);
      const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
      ctx.drawImage(img, sx - dw / 2, sy - dh, dw, dh);
    } else {
      ctx.fillStyle = r.color;
      ctx.fillRect(sx - 20, sy - 40, 40, 40);
    }
    ctx.restore();

    // 名前ラベル
    ctx.fillStyle = r.isPlayer ? '#ffb930' : '#28f2ff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(r.name, sx, sy - 46);
    ctx.textAlign = 'left';
  }
}

/* ============================== リザルト／表彰式 ============================== */
function showResults() {
  document.getElementById('gameContainer').classList.add('hidden');
  const resultScreen = document.getElementById('resultScreen');
  resultScreen.classList.remove('hidden');

  const list = document.getElementById('resultList');
  list.innerHTML = '';
  const ranked = state.racers.slice().sort((a, b) => a.rank - b.rank);
  ranked.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="pos">${r.rank}</span><span>${r.name}</span>`;
    list.appendChild(li);
  });

  startPodiumAnimation(ranked);
}

function startPodiumAnimation(ranked) {
  SFX.victory();
  const pc = document.getElementById('podiumCanvas');
  const vv = window.visualViewport;
  pc.width = vv ? Math.round(vv.width) : window.innerWidth;
  pc.height = vv ? Math.round(vv.height) : window.innerHeight;
  const pctx = pc.getContext('2d');
  const top3 = ranked.slice(0, 3);
  const confetti = [];
  for (let i = 0; i < 140; i++) {
    confetti.push({
      x: rand(0, pc.width), y: rand(-pc.height, 0),
      vy: rand(60, 160), vx: rand(-30, 30),
      color: choice(['#ffb930', '#28f2ff', '#ff4fd8', '#63ff8a', '#ff3b57']),
      size: rand(4, 9), rot: rand(0, Math.PI * 2),
    });
  }
  const fireworks = [];
  function spawnFirework() {
    const fx = rand(pc.width * 0.2, pc.width * 0.8);
    const fy = rand(pc.height * 0.15, pc.height * 0.4);
    const parts = [];
    const n = 40;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      parts.push({ x: fx, y: fy, vx: Math.cos(ang) * rand(80, 220), vy: Math.sin(ang) * rand(80, 220), life: 1 });
    }
    fireworks.push({ parts, color: choice(['#ffb930', '#28f2ff', '#ff4fd8', '#63ff8a']) });
  }
  let fwTimer = 0;
  let last = performance.now();

  const podiumHeights = { 1: 130, 2: 90, 3: 60 };
  const podiumOrderX = { 1: 0.5, 2: 0.28, 3: 0.72 }; // 1位中央、2位左、3位右

  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    fwTimer -= dt;
    if (fwTimer <= 0) { spawnFirework(); fwTimer = rand(0.7, 1.4); }

    pctx.clearRect(0, 0, pc.width, pc.height);
    // 背景グラデーション
    const g = pctx.createLinearGradient(0, 0, 0, pc.height);
    g.addColorStop(0, '#0b0d20'); g.addColorStop(1, '#1a1030');
    pctx.fillStyle = g; pctx.fillRect(0, 0, pc.width, pc.height);

    // 花火
    for (const fw of fireworks) {
      for (const p of fw.parts) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 60 * dt; p.life -= dt * 0.6;
        pctx.globalAlpha = clamp(p.life, 0, 1);
        pctx.fillStyle = fw.color;
        pctx.beginPath(); pctx.arc(p.x, p.y, 3, 0, Math.PI * 2); pctx.fill();
      }
    }
    pctx.globalAlpha = 1;
    fireworks.forEach(fw => { fw.parts = fw.parts.filter(p => p.life > 0); });

    // 表彰台
    const baseY = pc.height * 0.78;
    top3.forEach((r) => {
      const px = pc.width * podiumOrderX[r.rank];
      const ph = podiumHeights[r.rank];
      pctx.fillStyle = r.rank === 1 ? '#ffb930' : r.rank === 2 ? '#c9d3e6' : '#d98a4a';
      pctx.fillRect(px - 55, baseY - ph, 110, ph);
      pctx.fillStyle = '#0b0d14';
      pctx.font = 'bold 20px monospace';
      pctx.textAlign = 'center';
      pctx.fillText(String(r.rank), px, baseY - ph / 2 + 8);

      // ロボット画像
      const img = r.img;
      const boxSize = 70;
      if (img && img.complete && img.naturalWidth > 0) {
        const scale = Math.min(boxSize / img.naturalWidth, boxSize / img.naturalHeight);
        const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
        pctx.drawImage(img, px - dw / 2, baseY - ph - dh, dw, dh);
      }
      pctx.fillStyle = '#28f2ff';
      pctx.font = 'bold 13px monospace';
      pctx.fillText(r.name, px, baseY - ph - boxSize - 10);
    });

    // 紙吹雪
    for (const c of confetti) {
      c.y += c.vy * dt; c.x += c.vx * dt; c.rot += dt * 4;
      if (c.y > pc.height) { c.y = -10; c.x = rand(0, pc.width); }
      pctx.save();
      pctx.translate(c.x, c.y); pctx.rotate(c.rot);
      pctx.fillStyle = c.color;
      pctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size);
      pctx.restore();
    }

    if (!document.getElementById('resultScreen').classList.contains('hidden')) {
      requestAnimationFrame(loop);
    }
  }
  requestAnimationFrame(loop);
}

/* ============================== 初期化 ============================== */
buildSettingsUI();
resizeCanvas();
