/* ============================================================================
   PIXEL BRAWL - game.js
   ------------------------------------------------------------------------
   HTML5 Canvas + Vanilla JavaScript による対戦アクションゲーム。
   プレイヤー1人 vs CPU3体の4人乱闘(フリーフォーオール)。
   スマホの横持ちタッチ操作 + PCキーボード操作の両対応。

   構成（このファイル内でセクション分けしています）
     1. 基本セットアップ / 定数
     2. ユーティリティ関数
     3. 入力管理(キーボード)
     4. サウンド管理 (Web Audio API)
     5. パーティクル / エフェクト管理
     6. ステージ定義
     7. 技(攻撃)データ定義  ※ここに追加すれば技を増やせる
     8. Fighter 基底クラス（プレイヤー・CPU共通のロジック）
     9. Projectile（飛び道具）クラス
    10. Player クラス（人間操作・画像差し替え対応）
    11. CPU クラス（AI操作・3体それぞれ色違い）
    12. GameManager（状態遷移・UI・メインループ）
    13. 画面サイズ対応(レスポンシブ/横持ち)
    14. タッチ操作(モバイル向け仮想ボタン)
    15. プレイヤー画像設定(差し替え機能)
    16. 起動処理
   ========================================================================== */


/* ============================================================================
   1. 基本セットアップ / 定数
   ========================================================================== */

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false; // ドット絵をぼかさない

const SCREEN_W = canvas.width;   // 960 (内部解像度。表示サイズはCSSで可変)
const SCREEN_H = canvas.height;  // 540

// --- 物理定数 ---------------------------------------------------------------
const GRAVITY = 0.62;          // 重力加速度(px/frame^2)
const MAX_FALL_SPEED = 14;     // 最大落下速度
const MOVE_SPEED = 3.6;        // 通常移動速度
const DASH_SPEED = 6.6;        // ダッシュ移動速度
const AIR_MOVE_SPEED = 3.0;    // 空中制御速度
const JUMP_FORCE = -12.6;      // ジャンプ初速
const GROUND_FRICTION = 0.78;  // 地上摩擦(掛け算)
const AIR_FRICTION = 0.94;     // 空中抵抗(掛け算)

// --- ファイター共通サイズ ------------------------------------------------
const FIGHTER_WIDTH = 42;
const FIGHTER_HEIGHT = 58;

// --- ストック/撃墜関連 ---------------------------------------------------
const START_STOCKS = 3;
const KO_MARGIN = 90;        // この距離だけ画面外に出たら撃墜
const KO_BOTTOM = SCREEN_H + 70; // これより下に落ちたら撃墜
const RESPAWN_INVINCIBLE_FRAMES = 100; // 復帰後の無敵時間(フレーム)

// --- ノックバック/ダメージのバランス調整値 --------------------------------
const KB_HITSTUN_SCALE = 0.42; // ノックバック量→硬直フレームへの変換係数
const KB_HITSTUN_MAX = 75;

// --- ヒットストップ（打撃が当たった瞬間の一瞬の停止演出）------------------
const HITSTOP_NORMAL = 5;
const HITSTOP_STRONG = 9;

// --- 識別カラー -------------------------------------------------------------
const PLAYER_COLOR = '#3f7fdd';


/* ============================================================================
   2. ユーティリティ関数
   ========================================================================== */

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function randRange(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(randRange(min, max + 1)); }
function sign(n) { return n > 0 ? 1 : (n < 0 ? -1 : 0); }
function lerp(a, b, t) { return a + (b - a) * t; }

// 矩形同士の当たり判定(AABB)
function rectsOverlap(a, b) {
  return a.x < b.x + b.w &&
         a.x + a.w > b.x &&
         a.y < b.y + b.h &&
         a.y + a.h > b.y;
}

// 度→ラジアン
function deg2rad(d) { return d * Math.PI / 180; }


/* ============================================================================
   3. 入力管理(キーボード)
   ------------------------------------------------------------------------
   タッチボタンもこの keysDown / keysJustPressed を直接操作することで
   キーボードと全く同じ入力経路をファイターに渡せるようにしている。
   ========================================================================== */

const keysDown = new Set();        // 現在押されているキー
const keysJustPressed = new Set(); // このフレームで押された瞬間のキー

let audioStarted = false;
function ensureAudioStarted() {
  if (!audioStarted) {
    Sound.init();
    audioStarted = true;
  }
}

window.addEventListener('keydown', (e) => {
  if (!keysDown.has(e.code)) keysJustPressed.add(e.code);
  keysDown.add(e.code);

  // ブラウザのスクロール等を防止
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
  ensureAudioStarted();
});

window.addEventListener('keyup', (e) => {
  keysDown.delete(e.code);
});

canvas.addEventListener('pointerdown', ensureAudioStarted);


/* ============================================================================
   4. サウンド管理 (Web Audio API による簡易効果音)
   ========================================================================== */

const Sound = {
  ctx: null,

  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    } catch (e) {
      console.warn('Web Audio API が利用できません', e);
    }
  },

  // 単純なオシレーターでピコピコ音を鳴らす汎用関数
  _tone(freq, duration, type = 'square', volume = 0.18, glideTo = null) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + duration);
    }
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  },

  // ノイズバースト(ヒット音・爆発音向け)
  _noise(duration, volume = 0.2, filterFreq = 1200) {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    noise.connect(filter).connect(gain).connect(this.ctx.destination);
    noise.start();
  },

  attack() { this._tone(320, 0.08, 'square', 0.12, 220); },
  strongAttack() { this._tone(220, 0.14, 'sawtooth', 0.15, 120); },
  special() { this._tone(500, 0.22, 'sine', 0.16, 900); },
  hit() { this._noise(0.12, 0.25, 1800); },
  strongHit() { this._noise(0.2, 0.3, 900); },
  jump() { this._tone(440, 0.12, 'square', 0.1, 700); },
  land() { this._tone(150, 0.06, 'square', 0.08, 90); },
  ko() { this._tone(300, 0.5, 'sawtooth', 0.2, 40); },
  win() { this._tone(523, 0.15, 'square', 0.15, 784); },
};


/* ============================================================================
   5. パーティクル / エフェクト管理
   ========================================================================== */

class Particle {
  constructor(opts) {
    Object.assign(this, {
      x: 0, y: 0, vx: 0, vy: 0,
      life: 30, maxLife: 30,
      size: 4, color: '#fff',
      type: 'circle',   // 'circle' | 'text' | 'spark'
      text: '',
      gravity: 0,
      alphaFade: true,
    }, opts);
  }

  update(step) {
    this.x += this.vx * step;
    this.y += this.vy * step;
    this.vy += this.gravity * step;
    this.life -= step;
  }

  get alpha() {
    return this.alphaFade ? clamp(this.life / this.maxLife, 0, 1) : 1;
  }

  isDead() { return this.life <= 0; }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.alpha;
    if (this.type === 'circle') {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.type === 'spark') {
      // 打撃ヒット時の十字スパーク
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2;
      const s = this.size * this.alpha + 1;
      ctx.beginPath();
      ctx.moveTo(this.x - s, this.y); ctx.lineTo(this.x + s, this.y);
      ctx.moveTo(this.x, this.y - s); ctx.lineTo(this.x, this.y + s);
      ctx.stroke();
    } else if (this.type === 'text') {
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = this.color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText(this.text, this.x, this.y);
      ctx.fillText(this.text, this.x, this.y);
    }
    ctx.restore();
  }
}

const ParticleSystem = {
  list: [],

  spawnHitSpark(x, y, color = '#fff8d0', count = 6) {
    for (let i = 0; i < count; i++) {
      const angle = randRange(0, Math.PI * 2);
      const speed = randRange(1.5, 4);
      this.list.push(new Particle({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: randRange(10, 18), maxLife: 18,
        size: randRange(2, 4),
        color, type: 'circle',
      }));
    }
    // 中央に大きめの十字スパークも追加
    this.list.push(new Particle({
      x, y, vx: 0, vy: 0, life: 12, maxLife: 12, size: 14, color: '#ffffff', type: 'spark',
    }));
  },

  spawnLandingDust(x, y) {
    for (let i = 0; i < 6; i++) {
      this.list.push(new Particle({
        x: x + randRange(-10, 10), y,
        vx: randRange(-1.2, 1.2), vy: randRange(-1.6, -0.4),
        gravity: 0.08,
        life: randRange(14, 22), maxLife: 22,
        size: randRange(2, 3.5),
        color: 'rgba(220,220,220,0.8)',
        type: 'circle',
      }));
    }
  },

  spawnDamageText(x, y, amount, color) {
    this.list.push(new Particle({
      x, y, vx: randRange(-0.3, 0.3), vy: -1.1,
      life: 40, maxLife: 40,
      color, type: 'text', text: `+${amount}%`,
    }));
  },

  spawnProjectileTrail(x, y, color) {
    this.list.push(new Particle({
      x, y, vx: 0, vy: 0,
      life: 12, maxLife: 12, size: 5,
      color, type: 'circle',
    }));
  },

  spawnKoBurst(x, y, color) {
    for (let i = 0; i < 18; i++) {
      const angle = randRange(0, Math.PI * 2);
      const speed = randRange(2, 7);
      this.list.push(new Particle({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        gravity: 0.1,
        life: randRange(20, 40), maxLife: 40,
        size: randRange(2, 5), color, type: 'circle',
      }));
    }
  },

  update(step) {
    this.list.forEach(p => p.update(step));
    this.list = this.list.filter(p => !p.isDead());
  },

  draw(ctx) {
    this.list.forEach(p => p.draw(ctx));
  },
};


/* ============================================================================
   6. ステージ定義
   ========================================================================== */

const Stage = {
  // 地面(足場外に出ると落下してミスになる)
  ground: { x: 60, y: 440, w: 840, h: 100 },

  // 空中に浮かぶ足場(すり抜けは実装せず、上からだけ乗れる単純な当たり判定)
  platforms: [
    { x: 140, y: 330, w: 170, h: 18 },
    { x: 650, y: 330, w: 170, h: 18 },
    { x: 395, y: 205, w: 170, h: 18 },
  ],

  // 全ての足場(地面+プラットフォーム)を1つの配列として返す
  getAllSolids() {
    return [this.ground, ...this.platforms];
  },

  draw(ctx) {
    // --- 背景(レトロな遠景レイヤー) -------------------------------------
    const grad = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
    grad.addColorStop(0, '#1c2b4a');
    grad.addColorStop(0.6, '#2c3f66');
    grad.addColorStop(1, '#3a4f78');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // 遠景の山シルエット(ドット感を出すためカクカクした多角形)
    ctx.fillStyle = '#26355c';
    ctx.beginPath();
    ctx.moveTo(0, 400);
    ctx.lineTo(120, 300); ctx.lineTo(220, 380);
    ctx.lineTo(340, 280); ctx.lineTo(460, 380);
    ctx.lineTo(580, 300); ctx.lineTo(700, 380);
    ctx.lineTo(820, 310); ctx.lineTo(960, 390);
    ctx.lineTo(960, 440); ctx.lineTo(0, 440);
    ctx.closePath();
    ctx.fill();

    // 星(ドット)
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < STAR_POSITIONS.length; i++) {
      const s = STAR_POSITIONS[i];
      ctx.fillRect(s.x, s.y, 2, 2);
    }

    // --- 地面 -------------------------------------------------------------
    drawBlockPlatform(ctx, this.ground, '#4c8f3f', '#3a6b30', '#7fbf5a', true);

    // --- 浮遊足場 ---------------------------------------------------------
    this.platforms.forEach(p => {
      drawBlockPlatform(ctx, p, '#b5763a', '#7c4d24', '#e0a25e', false);
    });
  },
};

// 星の位置はロード時に一度だけランダム生成(毎フレーム再計算しない)
const STAR_POSITIONS = Array.from({ length: 40 }, () => ({
  x: randRange(0, SCREEN_W), y: randRange(0, 260),
}));

// 足場をレトロなブロック模様で描画する共通関数
function drawBlockPlatform(ctx, rect, topColor, sideColor, highlightColor, isGround) {
  const { x, y, w, h } = rect;
  // 側面/土台
  ctx.fillStyle = sideColor;
  ctx.fillRect(x, y, w, h);
  // 上面(草や石畳)
  ctx.fillStyle = topColor;
  ctx.fillRect(x, y, w, 14);
  // ハイライトのドットパターン
  ctx.fillStyle = highlightColor;
  const blockSize = 20;
  for (let bx = x; bx < x + w; bx += blockSize) {
    ctx.fillRect(bx + 2, y + 2, blockSize - 8, 4);
  }
  // 枠線(黒縁でドット絵っぽく)
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, isGround ? 14 : h);
}


/* ============================================================================
   7. 技(攻撃)データ定義
   ------------------------------------------------------------------------
   新しい技を追加したい場合は、この ATTACKS オブジェクトに項目を足すだけで
   Fighter 側のロジックを変更せず利用できるように設計しています。
   ========================================================================== */

const ATTACKS = {
  jab: {
    key: 'jab',
    label: 'ジャブ',
    startup: 5,      // 攻撃発生までのフレーム
    active: 5,        // 判定が出ている時間
    recovery: 12,      // 硬直
    range: 46,         // 攻撃の届く距離(前方)
    height: 18,        // 判定の高さ
    yOffset: -10,       // 中心からの縦オフセット
    damage: 4,
    kbBase: 4,
    kbScale: 0.30,
    angleDeg: 35,       // 吹っ飛ぶ角度(水平からの角度)
    hitstopSelf: HITSTOP_NORMAL,
    sound: 'attack',
    hitSound: 'hit',
    color: '#ffe27a',
  },
  strong: {
    key: 'strong',
    label: '強攻撃',
    startup: 12,
    active: 7,
    recovery: 22,
    range: 60,
    height: 26,
    yOffset: -6,
    damage: 12,
    kbBase: 9,
    kbScale: 0.55,
    angleDeg: 48,
    hitstopSelf: HITSTOP_STRONG,
    sound: 'strongAttack',
    hitSound: 'strongHit',
    color: '#ff8a5a',
  },
  special: {
    key: 'special',
    label: '必殺技(飛び道具)',
    startup: 14,
    active: 4,        // 発射モーション自体の判定時間(近接ではなく発射トリガー)
    recovery: 24,
    damage: 8,
    kbBase: 6,
    kbScale: 0.42,
    angleDeg: 30,
    hitstopSelf: HITSTOP_NORMAL,
    sound: 'special',
    hitSound: 'strongHit',
    color: '#7ad0ff',
    projectileSpeed: 8.2,
    projectileRadius: 9,
    projectileLife: 90,
  },
};


/* ============================================================================
   8. Fighter 基底クラス
   ========================================================================== */

class Fighter {
  constructor(name, spawnX, spawnY, colorTheme) {
    this.name = name;
    this.spawnX = spawnX;
    this.spawnY = spawnY;
    this.colorTheme = colorTheme; // 'player' | 'cpu'
    this.uiColor = '#ffffff';     // UI/エフェクトの識別色(サブクラスで上書き)

    this.width = FIGHTER_WIDTH;
    this.height = FIGHTER_HEIGHT;

    this.x = spawnX;
    this.y = spawnY;
    this.vx = 0;
    this.vy = 0;

    this.facing = (colorTheme === 'player') ? 1 : -1; // 1:右向き, -1:左向き
    this.onGround = false;
    this.wasOnGround = false;

    this.damage = 0;       // ダメージ%
    this.stocks = START_STOCKS;

    this.state = 'idle';   // idle, walk, dash, jump, attack, hitstun, dead
    this.attack = null;    // 現在実行中の攻撃 {def, phase, timer, hitTargets}
    this.attackCooldown = 0;

    this.hitstunTimer = 0;
    this.hitFlashTimer = 0;
    this.invincibleTimer = RESPAWN_INVINCIBLE_FRAMES; // 開始時も少し無敵

    this.dashing = false;
    this.jumpsUsed = 0;
    this.maxJumps = 2; // 二段ジャンプ可能(初心者にも遊びやすいように)

    this.alive = true;
  }

  // ---- 状態リセット(ラウンド開始時) -----------------------------------
  resetForRound() {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.vx = 0; this.vy = 0;
    this.damage = 0;
    this.stocks = START_STOCKS;
    this.state = 'idle';
    this.attack = null;
    this.hitstunTimer = 0;
    this.invincibleTimer = RESPAWN_INVINCIBLE_FRAMES;
    this.jumpsUsed = 0;
    this.alive = true;
  }

  respawn() {
    this.x = this.spawnX;
    this.y = this.spawnY - 40;
    this.vx = 0; this.vy = 0;
    this.damage = 0;
    this.state = 'idle';
    this.attack = null;
    this.hitstunTimer = 0;
    this.invincibleTimer = RESPAWN_INVINCIBLE_FRAMES;
    this.jumpsUsed = 0;
  }

  // ---- ヒットボックス/ハートボックス --------------------------------------
  getHurtbox() {
    return { x: this.x - this.width / 2, y: this.y - this.height, w: this.width, h: this.height };
  }

  getAttackHitbox() {
    if (!this.attack || this.attack.phase !== 'active') return null;
    const def = this.attack.def;
    if (def.key === 'special') return null; // 必殺技は飛び道具側で判定するため近接判定なし
    const range = def.range || 0;
    const centerY = this.y - this.height / 2 + (def.yOffset || 0);
    const boxW = range;
    const boxX = this.facing === 1 ? this.x : this.x - range;
    return { x: boxX, y: centerY - def.height / 2, w: boxW, h: def.height };
  }

  // ---- 入力取得(サブクラスで実装) -----------------------------------------
  getInput() {
    // { left, right, jumpPressed, dashHeld, jabPressed, strongPressed, specialPressed }
    return { left: false, right: false, jumpPressed: false, dashHeld: false,
             jabPressed: false, strongPressed: false, specialPressed: false };
  }

  canAct() {
    return this.state !== 'hitstun' && this.state !== 'dead' && !this.attack;
  }

  // ---- 攻撃開始 -----------------------------------------------------------
  startAttack(key) {
    if (!this.canAct() || this.attackCooldown > 0) return;
    const def = ATTACKS[key];
    if (!def) return;
    this.attack = { def, phase: 'startup', timer: def.startup, hitTargets: new Set() };
    this.state = 'attack';
    this.vx *= 0.4; // 攻撃時は少し減速して踏み込み感を出す
    if (Sound[def.sound]) Sound[def.sound]();
  }

  // ---- メイン更新処理 -------------------------------------------------------
  update(step, game) {
    if (!this.alive) return;

    this.wasOnGround = this.onGround;

    const input = this.getInput(game);

    // --- 硬直/ヒットストップ中でない場合のみ通常の行動処理を行う ----------
    if (this.state !== 'hitstun') {
      this.handleMovement(input, step);
      this.handleJump(input, step);
      this.handleAttackInput(input);
    }

    // --- 攻撃の状態機械を進める(相手は game.fighters から探す) --------------
    this.updateAttackState(step, game);

    // --- 硬直(ヒットストップ)カウントダウン ---------------------------------
    if (this.state === 'hitstun') {
      this.hitstunTimer -= step;
      if (this.hitstunTimer <= 0) {
        this.state = this.onGround ? 'idle' : 'jump';
      }
    }

    // --- クールダウン ----------------------------------------------------
    if (this.attackCooldown > 0) this.attackCooldown -= step;
    if (this.hitFlashTimer > 0) this.hitFlashTimer -= step;
    if (this.invincibleTimer > 0) this.invincibleTimer -= step;

    // --- 物理演算 -----------------------------------------------------------
    this.applyPhysics(step);
    this.resolveCollisions(step);

    // --- 着地エフェクト -------------------------------------------------
    if (!this.wasOnGround && this.onGround) {
      ParticleSystem.spawnLandingDust(this.x, this.y);
      Sound.land();
      this.jumpsUsed = 0;
    }

    // --- 状態文字列の更新(見た目の切り替え用) -------------------------------
    this.updateStateLabel();

    // --- 画面外撃墜判定 -------------------------------------------------
    this.checkKO(game);
  }

  handleMovement(input, step) {
    this.dashing = input.dashHeld && (input.left || input.right);
    const speed = this.onGround
      ? (this.dashing ? DASH_SPEED : MOVE_SPEED)
      : AIR_MOVE_SPEED;

    // 攻撃中は移動入力を大きく抑制(踏み込みのみ)
    const controlFactor = this.attack ? 0.15 : 1;

    if (input.left && !input.right) {
      this.vx -= speed * 0.9 * controlFactor * step;
      this.facing = -1;
    } else if (input.right && !input.left) {
      this.vx += speed * 0.9 * controlFactor * step;
      this.facing = 1;
    }

    // 速度上限
    const maxSpeed = this.onGround ? speed : AIR_MOVE_SPEED * 1.4;
    this.vx = clamp(this.vx, -maxSpeed, maxSpeed);
  }

  handleJump(input, step) {
    if (input.jumpPressed && this.jumpsUsed < this.maxJumps && this.canAct()) {
      this.vy = JUMP_FORCE;
      this.onGround = false;
      this.jumpsUsed++;
      Sound.jump();
    }
  }

  handleAttackInput(input) {
    if (!this.canAct()) return;
    if (input.jabPressed) this.startAttack('jab');
    else if (input.strongPressed) this.startAttack('strong');
    else if (input.specialPressed) this.startAttack('special');
  }

  updateAttackState(step, game) {
    if (!this.attack) return;
    const a = this.attack;
    a.timer -= step;

    if (a.phase === 'startup' && a.timer <= 0) {
      a.phase = 'active';
      a.timer = a.def.active;

      // 必殺技はアクティブフェーズ開始時に飛び道具を発射する
      if (a.def.key === 'special') {
        game.spawnProjectile(this, a.def);
      }
    } else if (a.phase === 'active') {
      // 近接攻撃の判定処理(乱闘なので周囲の全ファイターを対象にする)
      if (a.def.key !== 'special') {
        const hitbox = this.getAttackHitbox();
        if (hitbox) {
          for (const other of game.fighters) {
            if (other === this || !other.alive) continue;
            if (a.hitTargets.has(other)) continue; // 1回のスイングで同じ相手には1回だけ
            if (rectsOverlap(hitbox, other.getHurtbox())) {
              a.hitTargets.add(other);
              game.applyHit(this, other, a.def);
            }
          }
        }
      }
      if (a.timer <= 0) {
        a.phase = 'recovery';
        a.timer = a.def.recovery;
      }
    } else if (a.phase === 'recovery') {
      if (a.timer <= 0) {
        this.attack = null;
        this.attackCooldown = 4;
        this.state = this.onGround ? 'idle' : 'jump';
      }
    }
  }

  applyPhysics(step) {
    // 重力(ヒットストップ中でも呼ばれるがゲーム側でstep=0にして止める)
    this.vy += GRAVITY * step;
    this.vy = clamp(this.vy, -999, MAX_FALL_SPEED);

    // 摩擦(地上でのみ強めに減速)
    if (this.onGround && this.state !== 'hitstun') {
      this.vx *= Math.pow(GROUND_FRICTION, step);
    } else {
      this.vx *= Math.pow(AIR_FRICTION, step);
    }

    this.x += this.vx * step;
    this.y += this.vy * step;
  }

  resolveCollisions(step) {
    this.onGround = false;
    const solids = Stage.getAllSolids();
    const footX = this.x;
    const prevBottom = this.y - this.vy * step; // 移動前のY(足元)概算

    for (const s of solids) {
      const withinX = footX > s.x + 4 && footX < s.x + s.w - 4;
      if (!withinX) continue;

      // 下降中に足場の上面をすり抜けたら着地させる
      if (this.vy >= 0 && prevBottom <= s.y + 2 && this.y >= s.y) {
        this.y = s.y;
        this.vy = 0;
        this.onGround = true;
      }
    }
  }

  updateStateLabel() {
    if (this.state === 'hitstun' || this.state === 'dead' || this.attack) return;
    if (!this.onGround) this.state = 'jump';
    else if (Math.abs(this.vx) > 0.5) this.state = this.dashing ? 'dash' : 'walk';
    else this.state = 'idle';
  }

  // ---- ダメージ/ノックバックを受ける -------------------------------------
  receiveHit(attacker, def) {
    if (this.invincibleTimer > 0) return false; // 無敵中はヒットしない

    this.damage += def.damage;

    const kb = def.kbBase + this.damage * def.kbScale;
    const dirX = sign(this.x - attacker.x) || attacker.facing;
    const rad = deg2rad(def.angleDeg);

    this.vx = Math.cos(rad) * kb * dirX;
    this.vy = -Math.sin(rad) * kb;

    this.hitstunTimer = clamp(kb * KB_HITSTUN_SCALE, 6, KB_HITSTUN_MAX);
    this.state = 'hitstun';
    this.attack = null; // 被弾したら自分の攻撃はキャンセル
    this.hitFlashTimer = 8;
    this.onGround = false;

    return true;
  }

  // ---- 撃墜判定 -----------------------------------------------------------
  checkKO(game) {
    const offLeft = this.x < -KO_MARGIN;
    const offRight = this.x > SCREEN_W + KO_MARGIN;
    const offBottom = this.y > KO_BOTTOM;
    const offTop = this.y < -220;

    if (offLeft || offRight || offBottom || offTop) {
      game.onFighterKO(this);
    }
  }

  // ---- 描画 ---------------------------------------------------------------
  // draw() はサブクラス(Player / CPU)側で実装する。
  // ここでは無敵点滅やダメージフラッシュなど共通の見た目補助を提供する。
  applyCommonRenderStyle(ctx) {
    let alpha = 1;
    if (this.invincibleTimer > 0) {
      alpha = (Math.floor(this.invincibleTimer / 4) % 2 === 0) ? 0.35 : 0.85;
    }
    ctx.globalAlpha = alpha;
  }

  drawHitFlash(ctx) {
    if (this.hitFlashTimer > 0) {
      ctx.save();
      ctx.globalAlpha = clamp(this.hitFlashTimer / 8, 0, 1) * 0.7;
      ctx.fillStyle = '#ffffff';
      const hb = this.getHurtbox();
      ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
      ctx.restore();
    }
  }

  // 攻撃の軌跡(簡易エフェクト)を描く
  drawAttackEffect(ctx) {
    if (!this.attack || this.attack.phase !== 'active') return;
    const hb = this.getAttackHitbox();
    if (!hb) return;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = this.attack.def.color;
    ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
    ctx.restore();
  }
}


/* ============================================================================
   9. Projectile（飛び道具）クラス
   ========================================================================== */

class Projectile {
  constructor(owner, def, x, y) {
    this.owner = owner;
    this.def = def;
    this.x = x;
    this.y = y;
    this.vx = def.projectileSpeed * owner.facing;
    this.vy = 0;
    this.radius = def.projectileRadius;
    this.life = def.projectileLife;
    this.dead = false;
    this.trailTimer = 0;
  }

  update(step, game) {
    this.x += this.vx * step;
    this.y += this.vy * step;
    this.life -= step;

    this.trailTimer -= step;
    if (this.trailTimer <= 0) {
      ParticleSystem.spawnProjectileTrail(this.x, this.y, this.def.color);
      this.trailTimer = 2;
    }

    // 画面外 or 寿命切れで消滅
    if (this.life <= 0 || this.x < -40 || this.x > SCREEN_W + 40) {
      this.dead = true;
      return;
    }

    // 発射者以外の生存中ファイター全員と当たり判定(円と矩形の簡易判定)
    for (const other of game.fighters) {
      if (other === this.owner || !other.alive) continue;
      const hb = other.getHurtbox();
      const closestX = clamp(this.x, hb.x, hb.x + hb.w);
      const closestY = clamp(this.y, hb.y, hb.y + hb.h);
      const dx = this.x - closestX;
      const dy = this.y - closestY;
      if (dx * dx + dy * dy < this.radius * this.radius) {
        game.applyHit(this.owner, other, this.def, true);
        this.dead = true;
        break;
      }
    }
  }

  draw(ctx) {
    ctx.save();
    // 光る球体風エフェクト
    const grad = ctx.createRadialGradient(this.x, this.y, 1, this.x, this.y, this.radius * 1.8);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.4, this.def.color);
    grad.addColorStop(1, 'rgba(122,208,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius * 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}


/* ============================================================================
   10. Player クラス（人間操作）
   ========================================================================== */

class Player extends Fighter {
  constructor(x, y) {
    super('PLAYER', x, y, 'player');
    this.uiColor = PLAYER_COLOR;

    // --- 画像読み込み(assets/player.png を差し替え可能にする) --------------
    this.image = new Image();
    this.imageLoaded = false;
    this.imageFailed = false;
    this.image.onload = () => { this.imageLoaded = true; };
    this.image.onerror = () => { this.imageFailed = true; };
    this.image.src = 'assets/player.png';
  }

  getInput() {
    return {
      left: keysDown.has('ArrowLeft'),
      right: keysDown.has('ArrowRight'),
      jumpPressed: keysJustPressed.has('ArrowUp'),
      dashHeld: keysDown.has('ShiftLeft') || keysDown.has('ShiftRight'),
      jabPressed: keysJustPressed.has('KeyZ'),
      strongPressed: keysJustPressed.has('KeyX'),
      specialPressed: keysJustPressed.has('KeyC'),
    };
  }

  draw(ctx) {
    ctx.save();
    this.applyCommonRenderStyle(ctx);

    const drawW = this.width + 14;
    const drawH = this.height + 10;
    const drawX = this.x - drawW / 2;
    const drawY = this.y - drawH;

    ctx.translate(drawX + drawW / 2, 0);
    ctx.scale(this.facing, 1);
    ctx.translate(-(drawX + drawW / 2), 0);

    if (this.imageLoaded && !this.imageFailed) {
      // ユーザーが差し替えた画像(assets/player.png、または設定ボタンで選んだ画像)を表示
      ctx.drawImage(this.image, drawX, drawY, drawW, drawH);
    } else {
      // 画像が無い場合の仮シルエット(青い人型)を表示
      drawFallbackHumanoid(ctx, drawX, drawY, drawW, drawH, '#3f7fdd', '#1e5fbf');
    }

    ctx.restore();

    this.drawAttackEffect(ctx);
    this.drawHitFlash(ctx);
  }
}

// 画像未読み込み時に表示する仮の人型シルエット
function drawFallbackHumanoid(ctx, x, y, w, h, mainColor, darkColor) {
  ctx.fillStyle = darkColor;
  ctx.fillRect(x, y, w, h); // 影のベース

  ctx.fillStyle = mainColor;
  // 頭
  ctx.fillRect(x + w * 0.28, y, w * 0.44, h * 0.22);
  // 胴体
  ctx.fillRect(x + w * 0.18, y + h * 0.24, w * 0.64, h * 0.4);
  // 腕
  ctx.fillRect(x, y + h * 0.28, w * 0.16, h * 0.32);
  ctx.fillRect(x + w * 0.84, y + h * 0.28, w * 0.16, h * 0.32);
  // 脚
  ctx.fillRect(x + w * 0.2, y + h * 0.66, w * 0.26, h * 0.34);
  ctx.fillRect(x + w * 0.54, y + h * 0.66, w * 0.26, h * 0.34);

  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + w * 0.18, y + h * 0.24, w * 0.64, h * 0.4);
}


/* ============================================================================
   11. CPU クラス（AI操作・見た目はオリジナルの色違いロボット）
   ========================================================================== */

// CPU3体それぞれの見た目バリエーション(色を変えるだけでキャラを増やせる設計)
const CPU_VARIANTS = [
  { label: 'CPU-RED',   body: '#e0403a', dark: '#8f231f', arm: '#b23430', eye: '#ffe37a', metal: '#dcdcdc' },
  { label: 'CPU-GREEN', body: '#3fae5e', dark: '#1f6b38', arm: '#2f8a49', eye: '#ffe37a', metal: '#dcdcdc' },
  { label: 'CPU-PURPLE',body: '#9a5fe0', dark: '#5c2f8f', arm: '#7c46c2', eye: '#ffe37a', metal: '#dcdcdc' },
];

class CPU extends Fighter {
  constructor(x, y, variant) {
    super(variant.label, x, y, 'cpu');
    this.variant = variant;
    this.uiColor = variant.body;

    // --- AI用のパラメータ(初心者向け難易度) ---------------------------------
    this.aiDecisionTimer = randInt(5, 15);
    this.aiMoveDir = 0;
    this.aiWantsJump = false;
    this.aiWantsAttack = null;
    this.aiAttackCooldown = randInt(20, 40);
  }

  resetForRound() {
    super.resetForRound();
    this.aiDecisionTimer = randInt(5, 15);
    this.aiMoveDir = 0;
    this.aiWantsJump = false;
    this.aiWantsAttack = null;
    this.aiAttackCooldown = randInt(20, 40);
  }

  // 生存中の相手の中から一番近いファイターを狙う(プレイヤー・他のCPU問わず)
  findNearestOpponent(game) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const f of game.fighters) {
      if (f === this || !f.alive) continue;
      const d = Math.abs(f.x - this.x);
      if (d < nearestDist) { nearestDist = d; nearest = f; }
    }
    return nearest;
  }

  // CPUは常に狙っている相手の方を向く(移動していない時)
  getInput(game) {
    this.runAI(game);

    return {
      left: this.aiMoveDir < 0,
      right: this.aiMoveDir > 0,
      jumpPressed: this.aiWantsJump,
      dashHeld: false, // 初心者向けなのでダッシュは使わせない
      jabPressed: this.aiWantsAttack === 'jab',
      strongPressed: this.aiWantsAttack === 'strong',
      specialPressed: this.aiWantsAttack === 'special',
    };
  }

  runAI(game) {
    this.aiWantsJump = false;
    this.aiWantsAttack = null;

    if (this.aiAttackCooldown > 0) this.aiAttackCooldown -= 1;

    // --- 反応の遅さを表現するため、数フレームに一度だけ意思決定する -------
    this.aiDecisionTimer -= 1;
    if (this.aiDecisionTimer <= 0) {
      this.aiDecisionTimer = randInt(10, 18); // 反応間隔(初心者向けにやや長め)

      const target = this.findNearestOpponent(game);
      if (!target) { this.aiMoveDir = 0; return; }

      const dx = target.x - this.x;
      const dist = Math.abs(dx);

      // ステージ端に近い場合は中央方向へ強制的に戻る(最優先)
      const g = Stage.ground;
      const nearLeftEdge = this.x < g.x + 60;
      const nearRightEdge = this.x > g.x + g.w - 60;

      if (nearLeftEdge && this.onGround) {
        this.aiMoveDir = 1;
      } else if (nearRightEdge && this.onGround) {
        this.aiMoveDir = -1;
      } else if (dist > 210) {
        // 距離が遠い場合は近づく(たまに反応しない「ミス」を混ぜて易しくする)
        this.aiMoveDir = (Math.random() < 0.85) ? sign(dx) : 0;
      } else if (dist < 85) {
        // 距離が近い場合はその場で様子を見つつ攻撃を狙う
        this.aiMoveDir = (Math.random() < 0.3) ? sign(dx) * -1 : 0; // たまに少し引く
      } else {
        this.aiMoveDir = (Math.random() < 0.5) ? sign(dx) : 0;
      }

      // 攻撃判定(近い時のみ、クールダウンあり、初心者向けに発動率控えめ)
      if (dist < 95 && this.aiAttackCooldown <= 0 && this.canAct()) {
        const roll = Math.random();
        if (roll < 0.35) {
          this.aiWantsAttack = 'jab';
          this.aiAttackCooldown = randInt(35, 55);
        } else if (roll < 0.5) {
          this.aiWantsAttack = 'strong';
          this.aiAttackCooldown = randInt(50, 75);
        }
      } else if (dist >= 95 && dist < 320 && this.aiAttackCooldown <= 0 && Math.random() < 0.10) {
        // 中距離ではたまに飛び道具を撃つ
        this.aiWantsAttack = 'special';
        this.aiAttackCooldown = randInt(70, 110);
      }

      // たまにジャンプ(相手が上にいる、または単純にランダム)
      if (this.onGround) {
        const targetAbove = target.y < this.y - 40;
        if ((targetAbove && dist < 260 && Math.random() < 0.5) || Math.random() < 0.05) {
          this.aiWantsJump = true;
        }
      }

      // 向きを相手に合わせる(移動していない時の見た目のため)
      if (this.aiMoveDir === 0) {
        this.facing = sign(dx) || this.facing;
      }
    }
  }

  draw(ctx) {
    ctx.save();
    this.applyCommonRenderStyle(ctx);

    const w = this.width + 10;
    const h = this.height + 8;
    const x = this.x - w / 2;
    const y = this.y - h;

    ctx.translate(x + w / 2, 0);
    ctx.scale(this.facing, 1);
    ctx.translate(-(x + w / 2), 0);

    drawRobotEnemy(ctx, x, y, w, h, this.onGround ? Math.abs(this.vx) : 0, this.variant);

    ctx.restore();

    this.drawAttackEffect(ctx);
    this.drawHitFlash(ctx);
  }
}

// オリジナルの「ロボット」敵キャラクターを描画(色はvariantで指定)
function drawRobotEnemy(ctx, x, y, w, h, moveSpeed, variant) {
  const bodyColor = variant.body;
  const darkColor = variant.dark;
  const armColor = variant.arm;
  const eyeColor = variant.eye;
  const metal = variant.metal;

  // 脚(移動中は簡易的に上下に揺らす)
  const legOffset = Math.sin(Date.now() / 60) * (moveSpeed > 0.3 ? 3 : 0);
  ctx.fillStyle = darkColor;
  ctx.fillRect(x + w * 0.18, y + h * 0.68 + legOffset, w * 0.22, h * 0.3);
  ctx.fillRect(x + w * 0.58, y + h * 0.68 - legOffset, w * 0.22, h * 0.3);

  // 胴体
  ctx.fillStyle = bodyColor;
  ctx.fillRect(x + w * 0.12, y + h * 0.28, w * 0.76, h * 0.42);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + w * 0.12, y + h * 0.28, w * 0.76, h * 0.42);

  // 胸のパネル(メタル)
  ctx.fillStyle = metal;
  ctx.fillRect(x + w * 0.32, y + h * 0.38, w * 0.36, h * 0.16);
  ctx.fillStyle = eyeColor;
  ctx.fillRect(x + w * 0.44, y + h * 0.41, w * 0.12, h * 0.1);

  // 腕
  ctx.fillStyle = armColor;
  ctx.fillRect(x, y + h * 0.32, w * 0.14, h * 0.3);
  ctx.fillRect(x + w * 0.86, y + h * 0.32, w * 0.14, h * 0.3);

  // 頭部
  ctx.fillStyle = bodyColor;
  ctx.fillRect(x + w * 0.22, y, w * 0.56, h * 0.3);
  ctx.strokeRect(x + w * 0.22, y, w * 0.56, h * 0.3);

  // アンテナ
  ctx.strokeStyle = darkColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.5, y);
  ctx.lineTo(x + w * 0.5, y - h * 0.12);
  ctx.stroke();
  ctx.fillStyle = eyeColor;
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y - h * 0.14, 3, 0, Math.PI * 2);
  ctx.fill();

  // 目(光る一つ目、レトロロボット風)
  ctx.fillStyle = '#2a1a10';
  ctx.fillRect(x + w * 0.3, y + h * 0.1, w * 0.4, h * 0.12);
  ctx.fillStyle = eyeColor;
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.16, w * 0.09, 0, Math.PI * 2);
  ctx.fill();
}


/* ============================================================================
   12. GameManager（状態遷移・UI描画・メインループ）
   ========================================================================== */

const GameState = {
  READY: 'ready',
  FIGHT: 'fight',
  BATTLE: 'battle',
  GAMEOVER: 'gameover',
};

class GameManager {
  constructor() {
    // プレイヤー1体 + CPU3体の4人乱闘(フリーフォーオール)
    this.player = new Player(150, Stage.ground.y);
    this.cpus = [
      new CPU(370, Stage.ground.y, CPU_VARIANTS[0]),
      new CPU(600, Stage.ground.y, CPU_VARIANTS[1]),
      new CPU(830, Stage.ground.y, CPU_VARIANTS[2]),
    ];
    this.fighters = [this.player, ...this.cpus];

    this.projectiles = [];

    this.state = GameState.READY;
    this.stateTimer = 60; // READY表示のフレーム数

    this.hitStopTimer = 0;

    this.resultText = '';
    this.lastTime = performance.now();

    this.restartBlinkTimer = 0;
  }

  // ---- 攻撃ヒット処理(近接・飛び道具共通の入口) --------------------------
  applyHit(attacker, defender, def, isProjectile = false) {
    const applied = defender.receiveHit(attacker, def);
    if (!applied) return;

    const hb = defender.getHurtbox();
    const hitX = isProjectile ? defender.x : (attacker.facing === 1 ? hb.x + 6 : hb.x + hb.w - 6);
    const hitY = hb.y + hb.h * 0.4;

    ParticleSystem.spawnHitSpark(hitX, hitY, def.color);
    ParticleSystem.spawnDamageText(defender.x, hb.y - 4, def.damage, defender.uiColor);

    if (Sound[def.hitSound]) Sound[def.hitSound]();

    // ヒットストップ(両者を一瞬止めて打撃の重みを演出)
    this.hitStopTimer = Math.max(this.hitStopTimer, def.hitstopSelf || HITSTOP_NORMAL);
  }

  spawnProjectile(owner, def) {
    const originX = owner.x + (owner.facing * (owner.width / 2 + 10));
    const originY = owner.y - owner.height / 2 + (def.yOffset || 0);
    this.projectiles.push(new Projectile(owner, def, originX, originY));
  }

  onFighterKO(fighter) {
    if (!fighter.alive) return; // 二重処理防止
    if (fighter.stocks <= 0) return;

    fighter.stocks -= 1;
    Sound.ko();
    ParticleSystem.spawnKoBurst(
      clamp(fighter.x, 20, SCREEN_W - 20),
      clamp(fighter.y, 20, SCREEN_H - 20),
      fighter.uiColor
    );

    if (fighter.stocks <= 0) {
      fighter.alive = false;
      fighter.stocks = 0;

      if (fighter === this.player) {
        this.endGame('lose');
        return;
      }
      // CPUが全滅していればプレイヤーの勝利
      const anyCpuAlive = this.cpus.some(c => c.alive);
      if (!anyCpuAlive && this.player.alive) {
        this.endGame('win');
      }
    } else {
      fighter.respawn();
    }
  }

  endGame(result) {
    if (this.state === GameState.GAMEOVER) return; // 二重発火防止
    this.state = GameState.GAMEOVER;
    this.resultText = result === 'win' ? 'YOU WIN!' : 'YOU LOSE...';
    this.restartBlinkTimer = 0;
    if (result === 'win') Sound.win();
  }

  startRound() {
    this.fighters.forEach(f => f.resetForRound());
    this.projectiles = [];
    ParticleSystem.list = [];
    this.state = GameState.READY;
    this.stateTimer = 60;
  }

  // ---- メイン更新 -----------------------------------------------------------
  update(step) {
    // キー入力での再スタート
    if (this.state === GameState.GAMEOVER) {
      this.restartBlinkTimer += step;
      if (keysJustPressed.has('Space') || keysJustPressed.has('Enter')) {
        this.startRound();
      }
      keysJustPressed.clear();
      return;
    }

    // --- READY / FIGHT 演出の間はキャラクターを動かさない --------------------
    if (this.state === GameState.READY) {
      this.stateTimer -= step;
      if (this.stateTimer <= 0) {
        this.state = GameState.FIGHT;
        this.stateTimer = 40;
      }
      keysJustPressed.clear();
      return;
    }
    if (this.state === GameState.FIGHT) {
      this.stateTimer -= step;
      if (this.stateTimer <= 0) {
        this.state = GameState.BATTLE;
      }
      keysJustPressed.clear();
      return;
    }

    // --- ヒットストップ処理(演出のため一瞬だけ全体の動きを止める) -----------
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= step;
      ParticleSystem.update(step);
      keysJustPressed.clear();
      return;
    }

    // --- 通常更新(全ファイター共通ループ) --------------------------------
    this.fighters.forEach(f => { if (f.alive) f.update(step, this); });

    // 飛び道具の更新
    this.projectiles.forEach(p => p.update(step, this));
    this.projectiles = this.projectiles.filter(p => !p.dead);

    // 単純な押し合い防止(重なりすぎたら少し離す) -- 全ペア総当たり
    this.resolveOverlaps();

    ParticleSystem.update(step);

    keysJustPressed.clear();
  }

  resolveOverlaps() {
    for (let i = 0; i < this.fighters.length; i++) {
      const a = this.fighters[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.fighters.length; j++) {
        const b = this.fighters[j];
        if (!b.alive) continue;
        const dx = b.x - a.x;
        const minDist = (a.width + b.width) / 2 - 6;
        if (Math.abs(dx) < minDist && Math.abs(a.y - b.y) < a.height * 0.6) {
          const push = (minDist - Math.abs(dx)) / 2;
          const d = sign(dx) || 1;
          a.x -= push * d * 0.5;
          b.x += push * d * 0.5;
        }
      }
    }
  }

  // ---- 描画 -----------------------------------------------------------------
  draw(ctx) {
    Stage.draw(ctx);

    // 奥行き簡易ソート(yが小さい=奥のキャラから描画)
    const sorted = [...this.fighters].sort((a, b) => a.y - b.y);
    sorted.forEach(f => { if (f.alive) f.draw(ctx); });

    this.projectiles.forEach(p => p.draw(ctx));

    ParticleSystem.draw(ctx);

    this.drawUI(ctx);
    this.drawCenterMessage(ctx);
  }

  drawUI(ctx) {
    // プレイヤーは左上に大きく表示
    drawPlayerPanel(ctx, this.player, 14, 10, 'left', this.player.uiColor);
    // CPU3体は右上にコンパクトに縦に並べる
    this.cpus.forEach((c, i) => {
      drawCompactPanel(ctx, c, SCREEN_W - 14, 10 + i * 38, c.uiColor);
    });
  }

  drawCenterMessage(ctx) {
    ctx.save();
    ctx.textAlign = 'center';

    if (this.state === GameState.READY) {
      drawBigText(ctx, 'READY?', SCREEN_W / 2, SCREEN_H / 2, '#f4c542');
    } else if (this.state === GameState.FIGHT) {
      const scale = this.stateTimer > 30 ? lerp(2.2, 1, (40 - this.stateTimer) / 10) : 1;
      drawBigText(ctx, 'FIGHT!', SCREEN_W / 2, SCREEN_H / 2, '#ff5a4d', scale);
    } else if (this.state === GameState.GAMEOVER) {
      const color = this.resultText.startsWith('YOU WIN') ? '#7affa0' : '#ff6a6a';
      drawBigText(ctx, this.resultText, SCREEN_W / 2, SCREEN_H / 2 - 20, color);

      if (Math.floor(this.restartBlinkTimer / 20) % 2 === 0) {
        ctx.font = 'bold 16px "Courier New", monospace';
        ctx.fillStyle = '#f2ead8';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.strokeText('TAP OR PRESS SPACE TO RESTART', SCREEN_W / 2, SCREEN_H / 2 + 40);
        ctx.fillText('TAP OR PRESS SPACE TO RESTART', SCREEN_W / 2, SCREEN_H / 2 + 40);
      }
    }
    ctx.restore();
  }
}

// 中央演出用の大きな縁取りテキストを描画
function drawBigText(ctx, text, x, y, color, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.font = '900 48px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#0c0a14';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// 画面左上: プレイヤー用の大きめダメージ%・ストック表示パネル
function drawPlayerPanel(ctx, fighter, edgeX, y, align, color) {
  ctx.save();
  const panelW = 190;
  const x = align === 'left' ? edgeX : edgeX - panelW;

  // パネル背景
  ctx.fillStyle = 'rgba(12,10,20,0.65)';
  ctx.fillRect(x, y, panelW, 56);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, panelW, 56);

  // 名前
  ctx.font = 'bold 12px "Courier New", monospace';
  ctx.fillStyle = '#f2ead8';
  ctx.textAlign = align === 'left' ? 'left' : 'right';
  const nameX = align === 'left' ? x + 10 : x + panelW - 10;
  ctx.fillText(fighter.name, nameX, y + 15);

  // ダメージ%(高いほど赤くなる)
  const dmgColor = damageColor(fighter.damage);
  ctx.font = '900 26px "Courier New", monospace';
  ctx.fillStyle = dmgColor;
  ctx.textAlign = align === 'left' ? 'left' : 'right';
  const dmgX = align === 'left' ? x + 10 : x + panelW - 10;
  ctx.fillText(`${Math.min(999, Math.floor(fighter.damage))}%`, dmgX, y + 42);

  // ストックアイコン(残機を小さなシルエットで表示)
  for (let i = 0; i < START_STOCKS; i++) {
    const filled = i < fighter.stocks;
    const iconX = align === 'left'
      ? x + panelW - 14 - i * 14
      : x + 14 + i * 14;
    drawStockIcon(ctx, iconX, y + 12, filled, color, 5);
  }

  ctx.restore();
}

// 画面右上: CPU用のコンパクトなパネル(3体分並べても収まるサイズ)
function drawCompactPanel(ctx, fighter, rightX, y, color) {
  ctx.save();
  const w = 150, h = 32;
  const x = rightX - w;

  ctx.fillStyle = 'rgba(12,10,20,0.65)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.font = 'bold 9px "Courier New", monospace';
  ctx.fillStyle = '#f2ead8';
  ctx.textAlign = 'left';
  ctx.fillText(fighter.name, x + 6, y + 11);

  ctx.font = '900 15px "Courier New", monospace';
  ctx.fillStyle = damageColor(fighter.damage);
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.min(999, Math.floor(fighter.damage))}%`, x + 6, y + 26);

  for (let i = 0; i < START_STOCKS; i++) {
    const filled = i < fighter.stocks;
    drawStockIcon(ctx, x + w - 11 - i * 11, y + 9, filled, color, 3.4);
  }
  ctx.restore();
}

function damageColor(damage) {
  if (damage < 50) return '#f2ead8';
  if (damage < 100) return '#f4c542';
  if (damage < 150) return '#ff8a5a';
  return '#ff4d4d';
}

function drawStockIcon(ctx, cx, cy, filled, color, radius = 5) {
  ctx.save();
  ctx.fillStyle = filled ? color : 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}


/* ============================================================================
   13. 画面サイズ対応(レスポンシブ/横持ち)
   ------------------------------------------------------------------------
   内部の描画解像度は常に 960x540 に固定し、CSSサイズだけを画面に合わせて
   拡大縮小することでロジックをシンプルに保つ。
   ========================================================================== */

const canvasFrame = document.getElementById('canvas-frame');

function resizeCanvasFrame() {
  if (!canvasFrame) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.max(0.1, Math.min(vw / SCREEN_W, vh / SCREEN_H));
  canvasFrame.style.width = Math.floor(SCREEN_W * scale) + 'px';
  canvasFrame.style.height = Math.floor(SCREEN_H * scale) + 'px';
}

window.addEventListener('resize', resizeCanvasFrame);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvasFrame, 150));
resizeCanvasFrame();


/* ============================================================================
   14. タッチ操作(モバイル向け仮想ボタン)
   ------------------------------------------------------------------------
   画面下部のボタンは keysDown / keysJustPressed を直接操作するので、
   Fighter側のロジックはキーボード入力と全く区別する必要がない。
   ========================================================================== */

const TOUCH_KEY_MAP = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  jump: 'ArrowUp',
  jab: 'KeyZ',
  strong: 'KeyX',
  special: 'KeyC',
  dash: 'ShiftLeft',
};

function bindTouchButton(el) {
  const code = TOUCH_KEY_MAP[el.dataset.key];
  if (!code) return;

  const press = (e) => {
    e.preventDefault();
    if (!keysDown.has(code)) keysJustPressed.add(code);
    keysDown.add(code);
    el.classList.add('active');
    ensureAudioStarted();
  };
  const release = (e) => {
    if (e) e.preventDefault();
    keysDown.delete(code);
    el.classList.remove('active');
  };

  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

document.querySelectorAll('.tc-btn').forEach(bindTouchButton);

// ゲームオーバー画面をタップでも再スタートできるようにする(スマホはSpaceキーが無いため)
canvas.addEventListener('pointerdown', () => {
  if (game.state === GameState.GAMEOVER) {
    game.startRound();
  }
});


/* ============================================================================
   15. プレイヤー画像設定(差し替え機能)
   ------------------------------------------------------------------------
   「画像設定」ボタン → ファイル選択 → 選んだ画像をプレイヤーに反映。
   選択した画像はブラウザのlocalStorageに保存し、次回起動時にも復元する。
   ========================================================================== */

const settingsBtn = document.getElementById('settings-btn');
const playerImageInput = document.getElementById('player-image-input');
const PLAYER_IMAGE_STORAGE_KEY = 'pixelbrawl_player_image';

function applyPlayerImage(src) {
  const img = new Image();
  img.onload = () => {
    game.player.image = img;
    game.player.imageLoaded = true;
    game.player.imageFailed = false;
  };
  img.onerror = () => {
    game.player.imageFailed = true;
  };
  img.src = src;
}

if (settingsBtn && playerImageInput) {
  settingsBtn.addEventListener('click', () => {
    ensureAudioStarted();
    playerImageInput.click();
  });

  playerImageInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      applyPlayerImage(dataUrl);
      try {
        localStorage.setItem(PLAYER_IMAGE_STORAGE_KEY, dataUrl);
      } catch (err) {
        // プライベートモード等でlocalStorageが使えない場合は無視(今回の表示は反映される)
      }
    };
    reader.readAsDataURL(file);
    // 同じファイルを連続で選び直せるように値をリセット
    e.target.value = '';
  });
}

// 前回選択した画像が保存されていれば復元する(なければデフォルトのassets/player.pngのまま)
function restoreSavedPlayerImage() {
  try {
    const saved = localStorage.getItem(PLAYER_IMAGE_STORAGE_KEY);
    if (saved) applyPlayerImage(saved);
  } catch (err) {
    // localStorageが使えない環境では何もしない
  }
}


/* ============================================================================
   16. 起動処理 / メインループ
   ========================================================================== */

const game = new GameManager();
restoreSavedPlayerImage();

function gameLoop(now) {
  // フレーム間の経過時間から「1フレーム(=1/60秒)を1」とした進行係数stepを算出
  // これにより60Hz以外のディスプレイでも物理演算の速度が大きく変わらないようにする
  let delta = now - game.lastTime;
  game.lastTime = now;
  let step = clamp(delta / (1000 / 60), 0, 2.2);

  game.update(step);

  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
  game.draw(ctx);

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame((t) => {
  game.lastTime = t;
  requestAnimationFrame(gameLoop);
});
