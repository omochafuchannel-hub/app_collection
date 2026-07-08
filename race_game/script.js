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

  CANVAS_BG_LIST: ['sea', 'city', 'grass', 'mountain'],
};

/* 4色のロボットIDに対応する既定カラー（画像未設定時のプレースホルダー用） */
const DEFAULT_COLORS = ['#ffb930', '#28f2ff', '#ff4fd8', '#63ff8a'];

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
  document.getElementById('settingsScreen').classList.add('hidden');
  document.getElementById('gameContainer').classList.remove('hidden');
  initRace();
});

document.getElementById('restartBtn').addEventListener('click', () => {
  document.getElementById('resultScreen').classList.add('hidden');
  document.getElementById('settingsScreen').classList.remove('hidden');
});

/* ============================== Racer クラス ============================== */
class Racer {
  constructor(entry, index) {
    this.entry = entry;
    this.index = index;
    this.isPlayer = entry.role === 'player';
    this.name = entry.name;
    this.img = entry.img; // 未設定なら null（描画時にプレースホルダーを使用）
    this.color = entry.color;

    this.lane = randInt(0, CONFIG.LANES - 1);
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
    this.spinTimer = 0;
    this.hitFlashTimer = 0;

    this.heldItem = null;          // 所持アイテム（'crossbow' 等）
    this.cpuItemUseAt = 0;         // CPU用: このタイマーが0になったら使用

    this.finished = false;
    this.finishTime = null;
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
}
function stunRacer(racer, time, kind) {
  if (racer.stunTimer > 0) return; // 既にスタン中は重複させない
  racer.stunTimer = time;
  racer.speedMult = 0;
  racer.hitFlashTimer = 0.5;
  spawnExplosion(racer.x, racer.lane, kind === 'fall' ? 'small' : 'medium');
  triggerHitStop();
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

  state.racers = state.entries.map((e, i) => new Racer(e, i));
  state.projectiles = [];
  state.particles = [];
  state.traps = [];
  state.raceStarted = false;
  state.raceFinished = false;
  state.countdownValue = 3;
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
  const iv = setInterval(() => {
    state.countdownValue--;
    if (state.countdownValue <= 0) {
      state.countdownEl.textContent = 'GO!';
      setTimeout(() => { state.countdownEl.classList.add('hidden'); }, 500);
      state.raceStarted = true;
      clearInterval(iv);
    } else {
      state.countdownEl.textContent = state.countdownValue;
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
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);

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
    r.turboGauge = clamp(r.turboGauge + CONFIG.TURBO_FILL_RATE * dt, 0, CONFIG.TURBO_GAUGE_MAX);
    if (r.turboGauge >= CONFIG.TURBO_GAUGE_MAX) {
      r.overheated = true;
      r.stunTimer = Math.max(r.stunTimer, CONFIG.OVERHEAT_STUN_TIME);
    }
  } else {
    r.turboGauge = clamp(r.turboGauge - CONFIG.TURBO_COOL_RATE * dt, 0, CONFIG.TURBO_GAUGE_MAX);
    if (r.turboGauge <= 0) r.overheated = false;
  }

  // ジャンプ物理
  if (r.jumping) {
    r.z += r.vz * dt;
    r.vz -= CONFIG.GRAVITY * dt;
    if (r.z <= 0) { r.z = 0; r.vz = 0; r.jumping = false; }
  }

  // スタン／スピン タイマー
  if (r.stunTimer > 0) { r.stunTimer -= dt; if (r.stunTimer < 0) r.stunTimer = 0; }
  if (r.spinTimer > 0) { r.spinTimer -= dt; }
  if (r.hitFlashTimer > 0) { r.hitFlashTimer -= dt; }

  // レーン位置の滑らかな補間
  r.laneVisual = lerp(r.laneVisual, r.lane, clamp(CONFIG.LANE_CHANGE_SPEED * dt, 0, 1));
}

function integrateMovement(r, dt) {
  if (r.finished) return;
  let speed = 0;
  if (r.stunTimer <= 0) {
    speed = r.baseSpeed * r.speedMult;
    if (r.turboActive && !r.overheated) speed *= CONFIG.TURBO_MULT;
    if (r.spinTimer > 0) speed *= 0.5; // オイルでのスピン中は減速
  }
  r.currentSpeed = speed;
  r.x += speed * dt;
  r.x = clamp(r.x, 0, state.totalDistance);
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

  if (input.attack && !r._attackLatch && r.heldItem) {
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
  if (r.heldItem) {
    r.cpuItemUseAt -= dt;
    if (r.cpuItemUseAt <= 0) useItem(r);
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
      if (o.type.needsJump === false || o.type.zone || o.type.auto || !overJump) {
        o.type.effect(r);
      }
    }
  }
}

/* ============================== アイテムボックス ============================== */
function applyItemBoxPickup(r) {
  if (r.heldItem) return;
  for (const box of state.itemBoxes) {
    if (box.taken || box.lane !== r.lane) continue;
    if (Math.abs(r.x - box.x) < 30) {
      box.taken = true;
      r.heldItem = choice(WEAPON_TYPES);
      if (!r.isPlayer) r.cpuItemUseAt = rand(CONFIG.CPU_ITEM_USE_DELAY[0], CONFIG.CPU_ITEM_USE_DELAY[1]);
      spawnExplosion(r.x, r.lane, 'spark');
    }
  }
}

/* ============================== トラップ判定 ============================== */
function applyTraps(r) {
  for (const t of state.traps) {
    if (t.triggered || t.lane !== r.lane || t.owner === r) continue;
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
  const kind = r.heldItem;
  r.heldItem = null;
  switch (kind) {
    case 'crossbow': fireCrossbow(r); break;
    case 'big_missile': fireBigMissile(r); break;
    case 'homing': fireHomingMissiles(r); break;
    case 'laser': fireLaser(r); break;
    case 'trap': placeTrap(r); break;
  }
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
}
function fireBigMissile(r) {
  state.projectiles.push({
    type: 'big_missile', owner: r, x: r.x, lane: r.lane, laneOffset: 0,
    speed: 560, life: 3.0, color: '#ff3b57', big: true,
  });
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
}
function fireLaser(r) {
  state.projectiles.push({
    type: 'laser', owner: r, x: r.x, lane: r.lane, life: 0.35, color: '#28f2ff', width: 5000,
  });
  // レーザーは即時判定：同レーン + 隣接レーン（反射想定）にいる前方の敵を全てヒット
  for (const o of state.racers) {
    if (o === r) continue;
    const laneDiff = Math.abs(o.lane - r.lane);
    if (laneDiff <= 1 && o.x > r.x - 40 && o.x < r.x + 2200) {
      stunRacer(o, CONFIG.STUN_TIME, 'fall');
    }
  }
  shakeScreen(6);
}
function placeTrap(r) {
  state.traps.push({ x: r.x - 60, lane: r.lane, owner: r, triggered: false });
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
      const effectiveLane = p.lane + (p.laneOffset || 0);
      if (Math.abs(effectiveLane - o.lane) < 0.5 && Math.abs(p.x - o.x) < (p.big ? 70 : 34)) {
        p.hit = true; p.life = 0;
        stunRacer(o, CONFIG.STUN_TIME, 'fall');
        spawnExplosion(o.x, o.lane, p.big ? 'large' : 'medium');
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
  const n = size === 'large' ? 26 : size === 'medium' ? 16 : 8;
  for (let i = 0; i < n; i++) {
    state.particles.push({
      kind: 'spark', x, lane, y0: 0,
      vx: rand(-140, 140), vy: rand(-220, -40), life: rand(0.3, 0.7),
      color: choice(['#ffb930', '#ff3b57', '#fff2c2']),
    });
  }
  for (let i = 0; i < n / 2; i++) {
    state.particles.push({
      kind: 'smoke', x, lane, y0: 0,
      vx: rand(-30, 30), vy: rand(-60, -20), life: rand(0.6, 1.1),
      color: 'rgba(120,120,130,0.6)',
    });
  }
  shakeScreen(size === 'large' ? 10 : size === 'medium' ? 6 : 3);
}
function spawnSmoke(x, lane) {
  state.particles.push({ kind: 'smoke', x, lane, vx: rand(-10, 10), vy: rand(-20, -5), life: 0.4, color: 'rgba(200,200,210,0.5)' });
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
function computeRanks() {
  const sorted = state.racers.slice().sort((a, b) => b.x - a.x);
  sorted.forEach((r, i) => { r.rank = i + 1; });
}
function checkFinish() {
  computeRanks();
  const player = state.racers.find(r => r.isPlayer);
  if (!state.raceFinished && player.x >= state.totalDistance) {
    state.raceFinished = true;
    computeRanks();
    setTimeout(showResults, 600);
  }
  updateHud(player);
}

/* ============================== HUD 更新 ============================== */
function updateHud(player) {
  document.getElementById('hudRank').textContent = `${player.rank}/${state.racers.length}`;
  document.getElementById('hudLap').textContent = `${player.lap}/${CONFIG.LAPS}`;
  document.getElementById('hudSpeed').textContent = String(Math.round(player.currentSpeed)).padStart(3, '0');
  document.getElementById('hudItem').textContent = player.heldItem ? itemLabel(player.heldItem) : '--';

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
  ctx.fillStyle = '#26283a';
  ctx.fillRect(0, h * 0.30, w, h * 0.46);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  for (let l = 1; l < CONFIG.LANES; l++) {
    const y = laneY(l - 1, h) + (laneY(l, h) - laneY(l - 1, h)) / 2;
    ctx.setLineDash([16, 14]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // ゴールライン（世界座標 totalDistance の位置に描画）
  const gx = worldToScreenX(state.totalDistance);
  if (gx > -40 && gx < w + 40) {
    ctx.save();
    ctx.translate(gx, 0);
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#fff' : '#111';
      ctx.fillRect(-6, h * 0.30 + i * (h * 0.46 / 10), 12, h * 0.46 / 10);
    }
    ctx.restore();
  }
}

function drawObstacles(w, h) {
  for (const o of state.obstacles) {
    const sx = worldToScreenX(o.x);
    if (sx < -100 || sx > w + 100) continue;
    const sy = laneY(o.lane, h);
    ctx.fillStyle = o.type.color;
    const wpx = Math.max(18, o.type.width * 0.4);
    ctx.fillRect(sx - wpx / 2, sy - 16, wpx, 32);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.font = '9px monospace';
    ctx.fillText(o.type.label, sx - wpx / 2, sy + 26);
  }
}

function drawItemBoxesAndTraps(w, h) {
  for (const box of state.itemBoxes) {
    if (box.taken) continue;
    const sx = worldToScreenX(box.x);
    if (sx < -60 || sx > w + 60) continue;
    const sy = laneY(box.lane, h);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(performance.now() / 400 % (Math.PI * 2) * 0.3);
    ctx.fillStyle = '#ffb930';
    ctx.fillRect(-14, -14, 28, 28);
    ctx.fillStyle = '#0b0d14';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', 0, 1);
    ctx.restore();
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  for (const t of state.traps) {
    const sx = worldToScreenX(t.x);
    const sy = laneY(t.lane, h);
    ctx.fillStyle = t.triggered ? 'rgba(255,80,80,0.2)' : '#ff3b57';
    ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.fill();
  }
}

function drawProjectiles(w, h) {
  for (const p of state.projectiles) {
    const sx = worldToScreenX(p.x);
    if (sx < -60 || sx > w + 60) continue;
    const sy = laneY(p.lane + (p.laneOffset || 0), h);
    if (p.type === 'laser') {
      ctx.fillStyle = 'rgba(40,242,255,0.85)';
      ctx.fillRect(sx - 10, laneY(0, h) - 20, 20, laneY(CONFIG.LANES - 1, h) - laneY(0, h) + 40);
      continue;
    }
    ctx.fillStyle = p.color;
    const r = p.big ? 16 : (p.type === 'homing' ? 8 : 6);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
  }
}

function drawParticles(w, h) {
  for (const p of state.particles) {
    const sx = worldToScreenX(p.x);
    const sy = laneY(p.lane, h) + (p.laneOffsetPx || 0);
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    const size = p.kind === 'smoke' ? 10 : 4;
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

    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(sx, laneY(r.laneVisual, h) + 22, 22, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // ヒットフラッシュ演出（被弾時に明滅）
    ctx.save();
    if (r.hitFlashTimer > 0 && Math.floor(r.hitFlashTimer * 20) % 2 === 0) {
      ctx.filter = 'brightness(2) saturate(0)';
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
  const pc = document.getElementById('podiumCanvas');
  pc.width = window.innerWidth; pc.height = window.innerHeight;
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
