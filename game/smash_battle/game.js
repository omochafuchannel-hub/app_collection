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

// --- Safari(特にiOS)のピンチズーム/ダブルタップズーム対策 -------------------
// viewportメタタグの user-scalable=no だけでは、iOS Safariはアクセシビリティ上の
// 理由からピンチズームを許可してしまうことがある。ズームしたまま戻せなくなる
// (操作ボタンが押せなくなる)事故を防ぐため、JS側でも二重に無効化しておく。
(function preventMobileZoom() {
  // 2本指ジェスチャー(ピンチズーム)そのものを無効化(Safari固有のイベント)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
  document.addEventListener('gestureend', (e) => e.preventDefault());

  // 2本指以上でのtouchmove(ピンチ操作の実体)を無効化
  document.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // ダブルタップズームを無効化(短時間に連続したタップの2回目をキャンセル)
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 350) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false, capture: true });
})();

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

// --- ステージギミック関連 ---------------------------------------------------
// バトル開始(FIGHT表示が終わってから)何フレーム後に浮遊足場が動き出すか。
// 60fps換算で 60秒 = 3600フレーム。
const PLATFORM_MOVE_START_FRAMES = 3600;

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

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault(); // Safariでのダブルタップズーム等の誤操作を防ぐ
  ensureAudioStarted();
});


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
  pickup() { this._tone(660, 0.08, 'square', 0.12, 880); },
  throwItem() { this._tone(400, 0.09, 'triangle', 0.12, 250); },
  heal() { this._tone(320, 0.28, 'sine', 0.16, 760); },
  ultimate() { this._tone(150, 0.5, 'sawtooth', 0.22, 700); this._noise(0.4, 0.28, 2500); },
  explosion() { this._noise(0.35, 0.3, 700); this._tone(90, 0.3, 'sawtooth', 0.18, 40); },
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
    } else if (this.type === 'ring') {
      // 超必殺技・爆発用の拡大していく衝撃波リング
      const progress = 1 - this.alpha; // 0(発生直後)→1(消える直前)
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * progress, 0, Math.PI * 2);
      ctx.stroke();
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

  // 回復量の表示(エネルギータンク使用時など)。緑文字でマイナス表記にする。
  spawnHealText(x, y, amount, color = '#7affa0') {
    this.list.push(new Particle({
      x, y, vx: 0, vy: -1.1,
      life: 46, maxLife: 46,
      color, type: 'text', text: `-${amount}%`,
    }));
  },

  // アイテム取得時の小さなキラキラ演出
  spawnPickupSparkle(x, y, color) {
    for (let i = 0; i < 8; i++) {
      const angle = randRange(0, Math.PI * 2);
      const speed = randRange(1, 2.6);
      this.list.push(new Particle({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1,
        gravity: 0.05,
        life: randRange(14, 24), maxLife: 24,
        size: randRange(1.5, 3), color, type: 'circle',
      }));
    }
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

  // 超必殺技・爆弾の爆発などに使う大きな衝撃波演出
  spawnBigBurst(x, y, color, particleCount = 40) {
    for (let r = 0; r < 3; r++) {
      this.list.push(new Particle({
        x, y, vx: 0, vy: 0,
        life: 22 + r * 6, maxLife: 22 + r * 6,
        size: 24 + r * 34, color, type: 'ring',
      }));
    }
    for (let i = 0; i < particleCount; i++) {
      const angle = randRange(0, Math.PI * 2);
      const speed = randRange(3, 9);
      this.list.push(new Particle({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        gravity: 0.05,
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
  // baseX: 動き出す前の基準位置 / moveAmp・moveSpeed・movePhase: 左右移動のサイン波パラメータ
  platforms: [
    { x: 140, y: 330, w: 170, h: 18, baseX: 140, moveAmp: 70, moveSpeed: 0.018, movePhase: 0 },
    { x: 650, y: 330, w: 170, h: 18, baseX: 650, moveAmp: 70, moveSpeed: 0.015, movePhase: Math.PI },
    { x: 395, y: 205, w: 170, h: 18, baseX: 395, moveAmp: 110, moveSpeed: 0.021, movePhase: Math.PI / 2 },
  ],

  // 浮遊足場が動き始めているかどうか(バトル開始から一定時間経過でtrueになる)
  platformsMoving: false,
  platformMoveClock: 0,

  // 全ての足場(地面+プラットフォーム)を1つの配列として返す
  getAllSolids() {
    return [this.ground, ...this.platforms];
  },

  // 浮遊足場をサイン波でゆっくり左右に動かす(地面は動かさない)
  updatePlatforms(step) {
    this.platformMoveClock += step;
    this.platforms.forEach((p) => {
      p.x = p.baseX + Math.sin(this.platformMoveClock * p.moveSpeed + p.movePhase) * p.moveAmp;
    });
  },

  // ラウンド開始時に足場の位置と動き出しフラグをリセットする
  resetPlatforms() {
    this.platforms.forEach((p) => { p.x = p.baseX; });
    this.platformMoveClock = 0;
    this.platformsMoving = false;
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

// --- 装備品による技の強化(item側からatttack名を指定するだけで拡張できる設計) ---
// 新しい装備品が「ジャブや強攻撃を強化する」場合はここに項目を足すだけでよい。
const ITEM_MODIFIED_ATTACKS = {
  sword: {
    jab: { ...ATTACKS.jab, range: Math.round(ATTACKS.jab.range * 1.7), color: '#d8ecff' },
    strong: { ...ATTACKS.strong, range: Math.round(ATTACKS.strong.range * 1.55), color: '#d8ecff' },
  },
};

// --- 超必殺技(超必殺技オーブを持っている時にCボタンで発動する、自分中心の全方位大技) ---
const ULTIMATE_ATTACK = {
  key: 'ultimate',
  label: '超必殺技',
  startup: 20,       // 溜め(この間に発動を見て相手は避けられる)
  active: 14,         // 爆発が持続する時間
  recovery: 34,       // 大技なので隙も大きい
  radius: 230,        // 自分を中心とした爆発半径
  damage: 26,
  kbBase: 15,
  kbScale: 0.6,
  angleDeg: 45,
  hitstopSelf: 16,
  sound: 'ultimate',
  hitSound: 'ultimate',
  color: '#fff6c9',
};


/* ============================================================================
   7.5 アイテムデータ定義
   ------------------------------------------------------------------------
   ・ボール    : 装備品。Z/Xの性能に影響しない。Cで投げられるだけ。
   ・剣        : 装備品。持っているとZ/Xの射程が伸びる(上のITEM_MODIFIED_ATTACKS参照)。
   ・エネルギータンク: 回復アイテム。触れると即座にダメージ%が50減少して消える。
   ・超必殺技オーブ  : 装備品。持っている間はCボタンが光り、Cを押すと巨大な範囲攻撃(ULTIMATE_ATTACK)を放つ。
                       フィールドに同時に1個までしか出現しない。
   新しいアイテムは、この ITEM_DEFS に追加するだけで出現するようになる。
   ========================================================================== */

const ITEM_DEFS = {
  ball: {
    label: 'ボール', shortLabel: '球', color: '#f2ead8', radius: 10,
    damage: 5, kbBase: 4, kbScale: 0.25, angleDeg: 35,
    hitSound: 'hit', hitstopSelf: HITSTOP_NORMAL,
  },
  sword: {
    label: '剣', shortLabel: '剣', color: '#cfd8e0', radius: 11,
    damage: 9, kbBase: 6, kbScale: 0.40, angleDeg: 40,
    hitSound: 'strongHit', hitstopSelf: HITSTOP_STRONG,
  },
  energyTank: {
    label: 'エネルギータンク', shortLabel: '回復', color: '#57e08a', radius: 12,
    healAmount: 50, // 触れた瞬間にダメージ%をこれだけ減少させる
  },
  ultimate: {
    label: '超必殺技オーブ', shortLabel: '超', color: '#fff6c9', radius: 13,
    isUltimate: true, // 拾うとCボタンで超必殺技(ULTIMATE_ATTACK)が撃てるようになる
  },
};

// アイテムの出現しやすさの重み(値が大きいほど出やすい)。超必殺技オーブはレア枠。
const ITEM_SPAWN_WEIGHTS = { ball: 3, sword: 3, energyTank: 2, ultimate: 1 };


/* ============================================================================
   7.6 フィールド天災(爆弾・矢・レーザー)データ定義
   ------------------------------------------------------------------------
   約10秒に1回、ランダムな種類・ランダムなX座標で「予告(warn)」→「発生(active)」の
   順に発生する範囲攻撃。プレイヤー・CPUを問わず巻き込まれるとダメージを受ける。
   ========================================================================== */

const HAZARD_DEFS = {
  bomb: {
    label: '爆弾', warnFrames: 55, fuseFrames: 5, explodeRadius: 95,
    damage: 18, kbBase: 11, kbScale: 0.50, angleDeg: 60,
    color: '#ff8a5a', warnColor: 'rgba(255,90,60,0.35)',
    hitSound: 'strongHit', hitstopSelf: HITSTOP_STRONG,
  },
  arrow: {
    label: '矢', warnFrames: 34, strikeFrames: 7, strikeWidth: 26,
    damage: 12, kbBase: 8, kbScale: 0.40, angleDeg: 20,
    color: '#e8e2d0', warnColor: 'rgba(232,226,208,0.30)',
    hitSound: 'hit', hitstopSelf: HITSTOP_NORMAL,
  },
  laser: {
    label: 'レーザー', warnFrames: 62, beamFrames: 26, beamWidth: 46, tickInterval: 10,
    damage: 7, kbBase: 5, kbScale: 0.35, angleDeg: 15,
    color: '#7ad0ff', warnColor: 'rgba(122,208,255,0.30)',
    hitSound: 'hit', hitstopSelf: HITSTOP_NORMAL,
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

    this.heldItem = null; // 現在持っている装備品('ball' | 'sword' | null)

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
    this.heldItem = null;
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
    this.heldItem = null; // 撃墜されると持っていたアイテムは失う
  }

  // ---- ヒットボックス/ハートボックス --------------------------------------
  getHurtbox() {
    return { x: this.x - this.width / 2, y: this.y - this.height, w: this.width, h: this.height };
  }

  getAttackHitbox() {
    if (!this.attack || this.attack.phase !== 'active') return null;
    const def = this.attack.def;
    if (def.key === 'special' || def.key === 'ultimate') return null; // 必殺技・超必殺技は別方式で判定するため近接矩形判定なし
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
    let def = ATTACKS[key];
    if (!def) return;

    // 装備品を持っている場合、技データを差し替えて性能を変化させる(例: 剣で射程UP)
    const itemMod = this.heldItem && ITEM_MODIFIED_ATTACKS[this.heldItem];
    if (itemMod && itemMod[key]) def = itemMod[key];

    this.beginAttackWithDef(def);
  }

  // 超必殺技オーブを持っている時にCボタンで発動する巨大な範囲攻撃
  startUltimate() {
    if (!this.canAct() || this.attackCooldown > 0) return false;
    this.heldItem = null; // オーブを消費
    this.beginAttackWithDef(ULTIMATE_ATTACK);
    return true;
  }

  // 技データ(def)から実際に攻撃状態へ入る共通処理
  beginAttackWithDef(def) {
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
      this.handleAttackInput(input, game);
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

  handleAttackInput(input, game) {
    if (!this.canAct()) return;

    // 装備品を持っていない時、Z/Xの入力は「近くにアイテムがあれば拾う」を優先する
    if (!this.heldItem && (input.jabPressed || input.strongPressed) && game) {
      const item = game.findPickupableItemNear(this);
      if (item) {
        game.pickupItem(this, item);
        return; // この入力は拾い専用として消費し、同フレームでは攻撃しない
      }
    }

    if (input.jabPressed) this.startAttack('jab');
    else if (input.strongPressed) this.startAttack('strong');
    else if (input.specialPressed) {
      if (this.heldItem === 'ultimate') {
        // 超必殺技オーブを持っている時のCは巨大な範囲攻撃
        this.startUltimate();
      } else if (this.heldItem && game) {
        // それ以外の装備品(ボール・剣)を持っている時のCは投げる
        game.throwItem(this);
      } else {
        this.startAttack('special');
      }
    }
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
      // 超必殺技はアクティブフェーズ開始時に爆発演出(画面揺れ等)を発生させる
      if (a.def.key === 'ultimate') {
        game.triggerUltimateFx(this, a.def);
      }
    } else if (a.phase === 'active') {
      if (a.def.key === 'ultimate') {
        // 超必殺技: 自分を中心とした全方位の範囲攻撃
        for (const other of game.fighters) {
          if (other === this || !other.alive) continue;
          if (a.hitTargets.has(other)) continue;
          const dx = other.x - this.x;
          const dy = (other.y - other.height / 2) - (this.y - this.height / 2);
          if (dx * dx + dy * dy < a.def.radius * a.def.radius) {
            a.hitTargets.add(other);
            game.applyHit(this, other, a.def);
          }
        }
      } else if (a.def.key !== 'special') {
        // 近接攻撃の判定処理(乱闘なので周囲の全ファイターを対象にする)
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

  // 持っている装備品を手元に小さく描画する
  drawHeldItem(ctx) {
    if (!this.heldItem) return;
    const def = ITEM_DEFS[this.heldItem];
    const hx = this.x + this.facing * (this.width / 2 + 4);
    const hy = this.y - this.height * 0.55;

    ctx.save();
    if (this.heldItem === 'ball') {
      ctx.fillStyle = def.color;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a83a3a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (this.heldItem === 'sword') {
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hx - this.facing * 4, hy + 10);
      ctx.lineTo(hx + this.facing * 15, hy - 10);
      ctx.stroke();
      ctx.strokeStyle = '#8a6a3a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(hx - this.facing * 2, hy + 7);
      ctx.lineTo(hx + this.facing * 5, hy + 3);
      ctx.stroke();
    } else if (this.heldItem === 'ultimate') {
      const grad = ctx.createRadialGradient(hx, hy, 1, hx, hy, 12);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.6, def.color);
      grad.addColorStop(1, 'rgba(255,246,201,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(hx, hy, 12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 攻撃の軌跡(簡易エフェクト)を描く
  drawAttackEffect(ctx) {
    if (!this.attack || this.attack.phase !== 'active') return;

    // 超必殺技は自分を中心にした円形の爆発エフェクトを表示
    if (this.attack.def.key === 'ultimate') {
      ctx.save();
      const cx = this.x;
      const cy = this.y - this.height / 2;
      const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, this.attack.def.radius);
      grad.addColorStop(0, 'rgba(255,255,255,0.7)');
      grad.addColorStop(0.5, 'rgba(255,246,201,0.35)');
      grad.addColorStop(1, 'rgba(255,246,201,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, this.attack.def.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

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
   9.5 Item（アイテム)クラス
   ------------------------------------------------------------------------
   フィールドに落ちている/落下中/投げられて飛んでいる、の3状態を1クラスで表現する。
     - 通常状態: 重力で落下し、足場に着地するとその場に留まる(拾える)
     - thrown=true: 投げられて飛んでいる間。ファイターに当たるとダメージを与えて消える
     - 着地するとthrown=falseに戻り、再び「拾える」状態になる
   ========================================================================== */

class Item {
  constructor(type, x, y, opts = {}) {
    this.type = type;
    this.def = ITEM_DEFS[type];
    this.x = x;
    this.y = y;
    this.vx = opts.vx || 0;
    this.vy = opts.vy || 0;
    this.onGround = false;
    this.thrown = !!opts.thrown;
    this.owner = opts.owner || null;   // 投げた本人(投げた直後に自分へ当たらないようにする)
    this.hitTargets = new Set();       // 飛行中にヒット済みの相手(1回だけ当てる)
    this.dead = false;
    this.spinAngle = 0;
  }

  update(step, game) {
    if (!this.onGround) {
      this.vy = clamp(this.vy + GRAVITY * step, -999, MAX_FALL_SPEED);
      this.x += this.vx * step;
      this.y += this.vy * step;
      this.spinAngle += 0.25 * step;
    }

    // --- 足場との当たり判定(ファイターと同じ足場リストを利用した簡易版) -----
    if (this.vy >= 0) {
      for (const s of Stage.getAllSolids()) {
        const within = this.x > s.x + 2 && this.x < s.x + s.w - 2;
        if (!within) continue;
        const prevY = this.y - this.vy * step;
        if (prevY <= s.y + 2 && this.y >= s.y) {
          this.y = s.y;
          this.vx = 0; this.vy = 0;
          this.onGround = true;
          this.thrown = false; // 着地したら再び拾えるアイテムに戻る
          this.owner = null;
          this.hitTargets.clear();
          break;
        }
      }
    }

    // --- 投げられて飛んでいる間はファイターとの当たり判定を行う -------------
    if (this.thrown) {
      for (const f of game.fighters) {
        if (!f.alive || f === this.owner || this.hitTargets.has(f)) continue;
        const hb = f.getHurtbox();
        const cx = clamp(this.x, hb.x, hb.x + hb.w);
        const cy = clamp(this.y, hb.y, hb.y + hb.h);
        const dx = this.x - cx, dy = this.y - cy;
        if (dx * dx + dy * dy < this.def.radius * this.def.radius) {
          this.hitTargets.add(f);
          if (this.type !== 'energyTank') {
            game.applyHit(this.owner, f, this.def, true);
          }
          this.dead = true; // 命中したアイテムは消える
          break;
        }
      }
    }

    // --- 画面外/ステージ下に落ちたら消滅 -----------------------------------
    if (this.x < -60 || this.x > SCREEN_W + 60 || this.y > KO_BOTTOM) {
      this.dead = true;
    }
  }

  draw(ctx) {
    ctx.save();

    // 落下中はやや目立つよう光彩を先に描く
    if (!this.onGround) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.def.radius + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // 地面に置かれている時は影を落とす
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(this.x, this.y + 2, 10, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.translate(this.x, this.y);
    if (this.thrown) ctx.rotate(this.spinAngle);

    if (this.type === 'ball') {
      ctx.fillStyle = this.def.color;
      ctx.beginPath();
      ctx.arc(0, 0, this.def.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a83a3a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-this.def.radius, 0); ctx.lineTo(this.def.radius, 0);
      ctx.moveTo(0, -this.def.radius); ctx.lineTo(0, this.def.radius);
      ctx.stroke();
    } else if (this.type === 'sword') {
      ctx.fillStyle = this.def.color;
      ctx.fillRect(-2, -15, 4, 20);          // 刀身
      ctx.fillStyle = '#8a6a3a';
      ctx.fillRect(-8, 4, 16, 4);            // 鍔
      ctx.fillRect(-2, 8, 4, 8);             // 柄
    } else if (this.type === 'energyTank') {
      ctx.fillStyle = '#2c6b46';
      ctx.fillRect(-9, -13, 18, 26);
      ctx.fillStyle = this.def.color;
      ctx.fillRect(-6, -9, 12, 18);
      ctx.fillStyle = '#eafff0';
      ctx.font = 'bold 13px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', 0, 1);
    } else if (this.type === 'ultimate') {
      // 超必殺技オーブ: 光る球体(特別感を出すため常に脈動させる)
      const pulse = 1 + Math.sin(Date.now() / 140) * 0.15;
      const r = this.def.radius * 1.7 * pulse;
      const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, r);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.45, this.def.color);
      grad.addColorStop(1, 'rgba(255,246,201,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff6c9';
      ctx.beginPath();
      ctx.arc(0, 0, this.def.radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}


/* ============================================================================
   9.6 Hazard（フィールド天災: 爆弾・矢・レーザー)クラス
   ------------------------------------------------------------------------
   約10秒に1回、ランダムな種類・ランダムなX座標で発生する範囲攻撃。
   「予告(warn)」で発生位置を示してから実際にダメージが出るので、
   プレイヤー・CPUともに見てから避けられるようになっている。
   ========================================================================== */

class Hazard {
  constructor(type, x) {
    this.type = type;
    this.def = HAZARD_DEFS[type];
    this.x = x;
    this.y = -30;      // 爆弾の落下開始位置
    this.vy = 0;
    this.phase = 'warn'; // bomb: warn→fall→explode / arrow: warn→strike / laser: warn→beam
    this.timer = this.def.warnFrames;
    this.tickTimer = 0;  // レーザーの継続ダメージ間隔用
    this.explosionRadius = 0; // 爆発演出の広がり具合
    this.exploded = false;
    this.dead = false;
  }

  update(step, game) {
    this.timer -= step;

    if (this.type === 'bomb') {
      if (this.phase === 'warn') {
        if (this.timer <= 0) { this.phase = 'fall'; }
      } else if (this.phase === 'fall') {
        this.vy = clamp(this.vy + GRAVITY * 1.4 * step, -999, 16);
        this.y += this.vy * step;
        for (const s of Stage.getAllSolids()) {
          const within = this.x > s.x && this.x < s.x + s.w;
          if (within && this.y >= s.y) {
            this.y = s.y;
            this.phase = 'explode';
            this.timer = this.def.fuseFrames;
            break;
          }
        }
        if (this.y > KO_BOTTOM) this.dead = true;
      } else if (this.phase === 'explode') {
        if (this.timer <= 0 && !this.exploded) {
          this.exploded = true;
          game.applyHazardExplosion(this);
        }
        if (this.exploded) {
          this.explosionRadius += 14 * step;
          if (this.explosionRadius > this.def.explodeRadius + 20) this.dead = true;
        }
      }
    } else if (this.type === 'arrow') {
      if (this.phase === 'warn' && this.timer <= 0) {
        this.phase = 'strike';
        this.timer = this.def.strikeFrames;
        game.applyHazardLineHit(this);
      } else if (this.phase === 'strike' && this.timer <= 0) {
        this.dead = true;
      }
    } else if (this.type === 'laser') {
      if (this.phase === 'warn' && this.timer <= 0) {
        this.phase = 'beam';
        this.timer = this.def.beamFrames;
        this.tickTimer = 0;
      } else if (this.phase === 'beam') {
        this.tickTimer -= step;
        if (this.tickTimer <= 0) {
          this.tickTimer = this.def.tickInterval;
          game.applyHazardLineHit(this);
        }
        if (this.timer <= 0) this.dead = true;
      }
    }
  }

  draw(ctx) {
    const def = this.def;

    if (this.type === 'bomb') {
      if (this.phase === 'warn') {
        const blink = Math.floor(this.timer / 6) % 2 === 0;
        if (blink) {
          ctx.save();
          ctx.strokeStyle = def.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(this.x, Stage.ground.y, 18, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(this.x - 22, Stage.ground.y); ctx.lineTo(this.x + 22, Stage.ground.y);
          ctx.moveTo(this.x, Stage.ground.y - 22); ctx.lineTo(this.x, Stage.ground.y + 4);
          ctx.stroke();
          ctx.restore();
        }
      } else if (this.phase === 'fall') {
        ctx.save();
        ctx.fillStyle = '#2a2a2a';
        ctx.beginPath();
        ctx.arc(this.x, this.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = '#ff5a4d';
        ctx.beginPath();
        ctx.moveTo(this.x, this.y - 10); ctx.lineTo(this.x + 4, this.y - 17);
        ctx.stroke();
        ctx.restore();
      } else if (this.phase === 'explode' && this.exploded) {
        ctx.save();
        ctx.globalAlpha = clamp(1 - this.explosionRadius / (def.explodeRadius + 20), 0.15, 1);
        const grad = ctx.createRadialGradient(this.x, this.y, 1, this.x, this.y, Math.max(1, this.explosionRadius));
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.5, def.color);
        grad.addColorStop(1, 'rgba(255,90,60,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(this.x, this.y, Math.max(1, this.explosionRadius), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else if (this.type === 'arrow') {
      if (this.phase === 'warn') {
        const blink = Math.floor(this.timer / 4) % 2 === 0;
        ctx.save();
        ctx.fillStyle = def.warnColor;
        ctx.fillRect(this.x - def.strikeWidth / 2, 0, def.strikeWidth, SCREEN_H);
        if (blink) {
          ctx.strokeStyle = def.color;
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.moveTo(this.x, 0); ctx.lineTo(this.x, SCREEN_H);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      } else if (this.phase === 'strike') {
        ctx.save();
        ctx.globalAlpha = clamp(this.timer / def.strikeFrames, 0.15, 1);
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(this.x, 0); ctx.lineTo(this.x, SCREEN_H);
        ctx.stroke();
        ctx.restore();
      }
    } else if (this.type === 'laser') {
      if (this.phase === 'warn') {
        const blink = Math.floor(this.timer / 5) % 2 === 0;
        ctx.save();
        ctx.fillStyle = def.warnColor;
        ctx.fillRect(this.x - def.beamWidth / 2, 0, def.beamWidth, SCREEN_H);
        if (blink) {
          ctx.strokeStyle = def.color;
          ctx.lineWidth = 2;
          ctx.strokeRect(this.x - def.beamWidth / 2, 0, def.beamWidth, SCREEN_H);
        }
        ctx.restore();
      } else if (this.phase === 'beam') {
        ctx.save();
        const grad = ctx.createLinearGradient(this.x - def.beamWidth / 2, 0, this.x + def.beamWidth / 2, 0);
        grad.addColorStop(0, 'rgba(122,208,255,0)');
        grad.addColorStop(0.5, def.color);
        grad.addColorStop(1, 'rgba(122,208,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(this.x - def.beamWidth / 2, 0, def.beamWidth, SCREEN_H);
        ctx.restore();
      }
    }
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

    this.drawHeldItem(ctx);
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

  // 生存中の相手の中から「残機が最も多い」ファイターを狙う(プレイヤー・他のCPU問わず)。
  // 残機が同じ場合は距離が近い方を優先する。
  findPriorityTarget(game) {
    let best = null;
    let bestStocks = -1;
    let bestDist = Infinity;
    for (const f of game.fighters) {
      if (f === this || !f.alive) continue;
      const d = Math.abs(f.x - this.x);
      if (f.stocks > bestStocks || (f.stocks === bestStocks && d < bestDist)) {
        best = f; bestStocks = f.stocks; bestDist = d;
      }
    }
    return best;
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

      // --- アイテムが近くにあれば優先的に拾いに行く(持っていない時だけ) ------
      if (!this.heldItem) {
        const nearItem = game.findNearestGroundItem(this, 220);
        if (nearItem && Math.random() < 0.6) {
          const dx2 = nearItem.x - this.x;
          this.aiMoveDir = Math.abs(dx2) < 24 ? 0 : sign(dx2);
          if (Math.abs(dx2) < 40) this.aiWantsAttack = 'jab'; // 近ければ拾いに行く(拾える距離ならjabが自動的にpickupになる)
          if (this.aiMoveDir === 0) this.facing = sign(dx2) || this.facing;
          return;
        }
      } else if (this.aiAttackCooldown <= 0 && Math.random() < 0.08) {
        // --- 装備品を持っている時、まれに相手へ向けて投げる ---------------
        const throwTarget = this.findPriorityTarget(game);
        if (throwTarget) {
          this.facing = sign(throwTarget.x - this.x) || this.facing;
          this.aiMoveDir = 0;
          this.aiWantsAttack = 'special'; // アイテムを持っている時のspecialは「投げる」になる
          this.aiAttackCooldown = randInt(60, 100);
          return;
        }
      }

      // 残機が最も多い相手(=一番狙う価値のある相手)を優先して追いかける
      const target = this.findPriorityTarget(game);
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

    this.drawHeldItem(ctx);
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
    this.items = [];
    this.itemSpawnTimer = randInt(180, 260); // 最初のアイテム出現までのフレーム数

    this.hazards = [];
    this.hazardSpawnTimer = randInt(420, 600); // 最初の天災までのフレーム数(開始直後の猶予)

    this.screenShakeTimer = 0; // 超必殺技・爆発時の画面揺れ演出
    this.screenShakeMag = 0;

    this.battleTimer = 0; // BATTLE状態になってからの経過フレーム数(浮遊足場の動き出し等に使用)

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

  // 超必殺技発動時の演出(爆発エフェクト+画面揺れ+効果音)
  triggerUltimateFx(fighter, def) {
    ParticleSystem.spawnBigBurst(fighter.x, fighter.y - fighter.height / 2, def.color, 46);
    this.screenShakeTimer = 20;
    this.screenShakeMag = 10;
    Sound.ultimate();
  }

  // ---- 天災(爆弾・矢・レーザー)関連 -----------------------------------

  updateHazardSpawning(step) {
    this.hazardSpawnTimer -= step;
    if (this.hazardSpawnTimer <= 0) {
      this.hazardSpawnTimer = randInt(540, 660); // 次回まで約9〜11秒
      this.spawnRandomHazard();
    }
  }

  spawnRandomHazard() {
    if (this.hazards.length >= 3) return; // 出しすぎない安全弁
    const types = Object.keys(HAZARD_DEFS);
    const type = types[randInt(0, types.length - 1)];
    const g = Stage.ground;
    const x = randRange(g.x + 50, g.x + g.w - 50);
    this.hazards.push(new Hazard(type, x));
  }

  // 爆弾の爆発: 中心から半径内にいる全ファイターにダメージを与える
  applyHazardExplosion(hazard) {
    const def = hazard.def;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      const dx = f.x - hazard.x;
      const dy = (f.y - f.height / 2) - hazard.y;
      if (dx * dx + dy * dy < def.explodeRadius * def.explodeRadius) {
        this.applyEnvironmentalHit(f, def, hazard.x);
      }
    }
    ParticleSystem.spawnBigBurst(hazard.x, hazard.y, def.color, 30);
    this.screenShakeTimer = Math.max(this.screenShakeTimer, 16);
    this.screenShakeMag = Math.max(this.screenShakeMag, 7);
    Sound.explosion();
  }

  // 矢・レーザーの直撃判定: 指定X座標付近の帯にいる全ファイターにダメージを与える
  applyHazardLineHit(hazard) {
    const def = hazard.def;
    const halfWidth = (def.strikeWidth || def.beamWidth) / 2;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      if (Math.abs(f.x - hazard.x) < halfWidth) {
        this.applyEnvironmentalHit(f, def, hazard.x);
      }
    }
  }

  // 天災による被弾処理(攻撃者が存在しないため、ダミーの発生源座標から吹っ飛び方向を計算する)
  applyEnvironmentalHit(defender, def, sourceX) {
    const fakeAttacker = { x: sourceX, facing: Math.random() < 0.5 ? -1 : 1 };
    const applied = defender.receiveHit(fakeAttacker, def);
    if (!applied) return;

    const hb = defender.getHurtbox();
    ParticleSystem.spawnHitSpark(defender.x, hb.y + hb.h * 0.4, def.color);
    ParticleSystem.spawnDamageText(defender.x, hb.y - 4, def.damage, defender.uiColor);
    if (Sound[def.hitSound]) Sound[def.hitSound]();
    this.hitStopTimer = Math.max(this.hitStopTimer, def.hitstopSelf || HITSTOP_NORMAL);
  }

  // ---- アイテム関連 -----------------------------------------------------

  updateItemSpawning(step) {
    this.itemSpawnTimer -= step;
    if (this.itemSpawnTimer <= 0) {
      this.itemSpawnTimer = randInt(280, 420); // 次のアイテム出現まで(約5〜7秒)
      this.spawnRandomItem();
    }
  }

  spawnRandomItem() {
    if (this.items.length >= 4) return; // フィールドに出しすぎない

    // 超必殺技オーブは「フィールド上 or 誰かが所持中」のいずれかで既に1個存在するなら出さない
    const ultimateExists = this.items.some(i => i.type === 'ultimate') ||
                            this.fighters.some(f => f.heldItem === 'ultimate');

    const pool = [];
    for (const [type, weight] of Object.entries(ITEM_SPAWN_WEIGHTS)) {
      if (type === 'ultimate' && ultimateExists) continue;
      for (let n = 0; n < weight; n++) pool.push(type);
    }
    if (pool.length === 0) return;
    const type = pool[randInt(0, pool.length - 1)];

    const g = Stage.ground;
    const x = randRange(g.x + 60, g.x + g.w - 60);
    this.items.push(new Item(type, x, -20, { vy: 0 }));
  }

  // 拾える状態(地面に置かれている)のアイテムのうち、指定ファイターの手が届く範囲にあるものを探す
  findPickupableItemNear(fighter) {
    for (const item of this.items) {
      if (item.thrown || !item.onGround || item.type === 'energyTank') continue;
      const dx = Math.abs(item.x - fighter.x);
      const dy = Math.abs(item.y - (fighter.y - fighter.height / 2));
      if (dx < 36 && dy < 55) return item;
    }
    return null;
  }

  // CPUが目標として狙うための、少し広めの範囲での最寄りアイテム検索(装備品のみ)
  findNearestGroundItem(fighter, maxDist) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const item of this.items) {
      if (item.thrown || !item.onGround || item.type === 'energyTank') continue;
      const d = Math.abs(item.x - fighter.x);
      if (d < maxDist && d < nearestDist) { nearestDist = d; nearest = item; }
    }
    return nearest;
  }

  pickupItem(fighter, item) {
    fighter.heldItem = item.type;
    this.items = this.items.filter(i => i !== item);
    Sound.pickup();
    ParticleSystem.spawnPickupSparkle(fighter.x, fighter.y - fighter.height * 0.6, item.def.color);
  }

  throwItem(fighter) {
    const type = fighter.heldItem;
    if (!type) return;
    fighter.heldItem = null;

    const originX = fighter.x + fighter.facing * (fighter.width / 2 + 10);
    const originY = fighter.y - fighter.height * 0.55;
    const thrown = new Item(type, originX, originY, {
      vx: 7.4 * fighter.facing,
      vy: -2.2,
      thrown: true,
      owner: fighter,
    });
    thrown.onGround = false;
    this.items.push(thrown);
    Sound.throwItem();
  }

  // エネルギータンクは拾うボタン不要で、触れた瞬間に自動で回復する
  checkHealPickups() {
    for (const item of this.items) {
      if (item.type !== 'energyTank' || item.thrown || !item.onGround) continue;
      for (const f of this.fighters) {
        if (!f.alive) continue;
        const dx = Math.abs(item.x - f.x);
        const dy = Math.abs(item.y - (f.y - f.height / 2));
        if (dx < 34 && dy < 46) {
          f.damage = Math.max(0, f.damage - item.def.healAmount);
          ParticleSystem.spawnHealText(f.x, f.y - f.height - 6, item.def.healAmount);
          ParticleSystem.spawnPickupSparkle(f.x, f.y - f.height * 0.6, item.def.color);
          Sound.heal();
          this.items = this.items.filter(i => i !== item);
          return; // 1体が取得したらこのアイテムは消費済み
        }
      }
    }
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
    this.items = [];
    this.itemSpawnTimer = randInt(180, 260);
    this.hazards = [];
    this.hazardSpawnTimer = randInt(420, 600);
    this.screenShakeTimer = 0;
    this.screenShakeMag = 0;
    this.battleTimer = 0;
    Stage.resetPlatforms();
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

    // --- バトル経過時間の計測(浮遊足場の動き出しに使用) -----------------------
    this.battleTimer += step;
    if (!Stage.platformsMoving && this.battleTimer >= PLATFORM_MOVE_START_FRAMES) {
      Stage.platformsMoving = true;
    }
    if (Stage.platformsMoving) {
      Stage.updatePlatforms(step);
    }

    // --- 通常更新(全ファイター共通ループ) --------------------------------
    this.fighters.forEach(f => { if (f.alive) f.update(step, this); });

    // 飛び道具の更新
    this.projectiles.forEach(p => p.update(step, this));
    this.projectiles = this.projectiles.filter(p => !p.dead);

    // アイテムの出現・更新・回復判定
    this.updateItemSpawning(step);
    this.items.forEach(i => i.update(step, this));
    this.items = this.items.filter(i => !i.dead);
    this.checkHealPickups();

    // 天災(爆弾・矢・レーザー)の出現・更新
    this.updateHazardSpawning(step);
    this.hazards.forEach(h => h.update(step, this));
    this.hazards = this.hazards.filter(h => !h.dead);

    // 画面揺れの減衰
    if (this.screenShakeTimer > 0) this.screenShakeTimer -= step;

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
    ctx.save();

    // 超必殺技・爆発などの演出時に画面全体を軽く揺らす(HUDは対象外)
    if (this.screenShakeTimer > 0) {
      const mag = this.screenShakeMag * clamp(this.screenShakeTimer / 20, 0, 1);
      ctx.translate(randRange(-mag, mag), randRange(-mag, mag));
    }

    Stage.draw(ctx);

    // アイテムはファイターより先に描画(地面の小物として扱う)
    this.items.forEach(i => i.draw(ctx));

    // 奥行き簡易ソート(yが小さい=奥のキャラから描画)
    const sorted = [...this.fighters].sort((a, b) => a.y - b.y);
    sorted.forEach(f => { if (f.alive) f.draw(ctx); });

    this.projectiles.forEach(p => p.draw(ctx));

    ParticleSystem.draw(ctx);

    // 天災の予告/発生エフェクトは最前面に表示して視認性を確保する
    this.hazards.forEach(h => h.draw(ctx));

    ctx.restore();

    this.drawUI(ctx);
    this.drawCenterMessage(ctx);
  }

  drawUI(ctx) {
    // 4人分のダメージ%を画面下に大きく横並びで表示(スマブラ風レイアウト)
    drawBottomHud(ctx, this.fighters);
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

// 画面下部中央: 4人分のダメージ%を横並びで大きく表示する(スマブラ風HUD)
// タッチボタンは画面の左右端(コーナー)に配置しているため、中央に寄せることで
// 操作ボタンとの重なりを避けている。
function drawBottomHud(ctx, fighters) {
  const boxW = 176;
  const boxH = 84;
  const gap = 8;
  const totalW = fighters.length * boxW + (fighters.length - 1) * gap;
  let x = (SCREEN_W - totalW) / 2;
  const y = SCREEN_H - boxH - 6;

  fighters.forEach((f) => {
    drawFighterHudBox(ctx, f, x, y, boxW, boxH, f.uiColor);
    x += boxW + gap;
  });
}

function drawFighterHudBox(ctx, fighter, x, y, w, h, color) {
  ctx.save();

  // パネル背景
  ctx.fillStyle = 'rgba(10,8,18,0.72)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);

  // 名前(装備品を持っていればアイコンも添える)
  ctx.font = 'bold 11px "Courier New", monospace';
  ctx.fillStyle = '#f2ead8';
  ctx.textAlign = 'center';
  const heldLabel = fighter.heldItem ? ` [${ITEM_DEFS[fighter.heldItem].shortLabel}]` : '';
  ctx.fillText(fighter.name + heldLabel, x + w / 2, y + 15);

  // ダメージ%(大きく表示。高いほど赤くなる)
  ctx.font = '900 36px "Courier New", monospace';
  ctx.fillStyle = damageColor(fighter.damage);
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.min(999, Math.floor(fighter.damage))}%`, x + w / 2, y + 58);

  // ストックアイコン
  const iconsTotalW = (START_STOCKS - 1) * 15;
  let iconX = x + w / 2 - iconsTotalW / 2;
  for (let i = 0; i < START_STOCKS; i++) {
    drawStockIcon(ctx, iconX, y + h - 11, i < fighter.stocks, color, 5);
    iconX += 15;
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
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault(); // Safariでのダブルタップズーム等の誤操作を防ぐ
  if (game.state === GameState.GAMEOVER) {
    game.startRound();
  }
});

// --- 超必殺技オーブを持っている間、Cボタン(必殺技ボタン)を光らせる ---------
const specialButtonEl = document.querySelector('[data-key="special"]');
function updateUltimateButtonGlow() {
  if (!specialButtonEl) return;
  if (game.player.heldItem === 'ultimate') {
    specialButtonEl.classList.add('ready-glow');
  } else {
    specialButtonEl.classList.remove('ready-glow');
  }
}


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
  updateUltimateButtonGlow();

  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
  game.draw(ctx);

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame((t) => {
  game.lastTime = t;
  requestAnimationFrame(gameLoop);
});
