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
// 0. 定数・DOM要素の取得
// =====================================================================
const video = document.getElementById("camera-video");
const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const loadingScreen = document.getElementById("loading-screen");
const loadingDetail = document.getElementById("loading-detail");
const calibrationScreen = document.getElementById("calibration-screen");
const calibBarInner = document.getElementById("calib-bar-inner");
const startScreen = document.getElementById("start-screen");
const startBtn = document.getElementById("start-btn");
const resultScreen = document.getElementById("result-screen");
const resultTitle = document.getElementById("result-title");
const retryBtn = document.getElementById("retry-btn");

const hud = document.getElementById("hud");
const playerHpBar = document.getElementById("player-hp-bar");
const bossHpBar = document.getElementById("boss-hp-bar");
const chargeBar = document.getElementById("charge-bar");
const statusText = document.getElementById("status-text");

// ゲーム全体のステート機械: loading -> calibrating -> ready -> playing -> win/lose
let gameState = "loading";

// キャリブレーション用
const CALIB_FRAMES_NEEDED = 45; // 約45フレーム分の姿勢平均を基準姿勢とする
let calibFrameCount = 0;
let calibShoulderYSum = 0;
let baselineShoulderY = null; // 基準時の肩の高さ（画面比率 0〜1）
let baselineTorsoLen = null;  // 基準時の肩〜腰の距離（縦の目安）

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
const BOSS_MAX_HP = 100;
const boss = {
  hp: BOSS_MAX_HP,
  baseX: 0, baseY: 0, // canvasサイズ確定後に設定
  bobPhase: 0,
  attackTimer: 0,
  attackInterval: 1800, // ms、徐々に短縮される
  nextAttackType: "ground",
  hitFlash: 0,
  dead: false
};

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

  boss.baseX = canvas.width * 0.82;
  boss.baseY = canvas.height * 0.42;

  requestAnimationFrame(() => gameLoop(poseLandmarker));
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

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
    numPoses: 1
  });
}

// スタートボタン
startBtn.addEventListener("click", () => {
  startScreen.classList.add("hidden");
  hud.classList.remove("hidden");
  gameState = "playing";
  boss.attackTimer = performance.now() + 1200;
});

retryBtn.addEventListener("click", () => {
  resetGame();
  resultScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
});

function resetGame() {
  player.hp = PLAYER_MAX_HP;
  boss.hp = BOSS_MAX_HP;
  boss.dead = false;
  boss.attackInterval = 1800;
  playerBolts = [];
  enemyProjectiles = [];
  particles = [];
  updateHpBars();
  gameState = "ready-wait"; // スタートボタン待ち（start-screenはretryBtn側で表示済み）
}

// =====================================================================
// 5. メインループ
// =====================================================================
let lastVideoTime = -1;

function gameLoop(poseLandmarker) {
  requestAnimationFrame(() => gameLoop(poseLandmarker));

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // --- 姿勢推定（動画フレームが更新された時だけ実行し負荷を抑える） ---
  let landmarks = null;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    if (result.landmarks && result.landmarks.length > 0) {
      landmarks = result.landmarks[0];
    }
  }

  if (gameState === "calibrating") {
    handleCalibration(landmarks);
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
// 6. キャリブレーション（基準姿勢の取得）
// =====================================================================
function handleCalibration(landmarks) {
  if (!landmarks) return;
  const ls = landmarks[11], rs = landmarks[12]; // 左肩・右肩
  const lh = landmarks[23], rh = landmarks[24]; // 左腰・右腰
  if (!ls || !rs) return;

  const shoulderY = (ls.y + rs.y) / 2;
  const hipY = lh && rh ? (lh.y + rh.y) / 2 : shoulderY + 0.25;

  calibShoulderYSum += shoulderY;
  calibFrameCount++;

  calibBarInner.style.width = `${Math.min(100, (calibFrameCount / CALIB_FRAMES_NEEDED) * 100)}%`;

  if (calibFrameCount >= CALIB_FRAMES_NEEDED) {
    baselineShoulderY = calibShoulderYSum / calibFrameCount;
    baselineTorsoLen = Math.abs(hipY - shoulderY) || 0.25;
    calibrationScreen.classList.add("hidden");
    startScreen.classList.remove("hidden");
    gameState = "ready-wait";
  }
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
  if (boss.dead) return;
  boss.bobPhase += 0.05;

  const now = performance.now();
  if (now > boss.attackTimer) {
    launchEnemyAttack();
    boss.attackInterval = Math.max(900, boss.attackInterval - 25); // 徐々に速くなる
    boss.attackTimer = now + boss.attackInterval;
  }
  if (boss.hitFlash > 0) boss.hitFlash--;
}

function launchEnemyAttack() {
  const type = boss.nextAttackType;
  boss.nextAttackType = type === "ground" ? "air" : "ground"; // 交互に出す
  AudioSys.enemyShoot();

  const y = type === "ground" ? canvas.height * 0.86 : canvas.height * 0.38;
  enemyProjectiles.push({
    x: boss.baseX,
    y,
    vx: -6.5,
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
  if (!boss.dead) {
    playerBolts.forEach(b => {
      const dx = b.x - boss.baseX;
      const dy = b.y - (boss.baseY + Math.sin(boss.bobPhase) * 10);
      if (Math.hypot(dx, dy) < 55 + b.r * 0.3) {
        const dmg = [0, 8, 16, 32][b.level] || 8;
        boss.hp = Math.max(0, boss.hp - dmg);
        boss.hitFlash = 10;
        b.x = 99999; // 消去マーク
        spawnHitParticles(boss.baseX, boss.baseY, "#ff6b6b");
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
  if (gameState !== "playing") return;
  gameState = "win";
  boss.dead = true;
  AudioSys.win();
  for (let i = 0; i < 60; i++) {
    particles.push({
      x: boss.baseX + (Math.random() - 0.5) * 80,
      y: boss.baseY + (Math.random() - 0.5) * 80,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 8,
      life: 40,
      color: ["#ffe66d", "#ff6b6b", "#7fdcff"][i % 3],
      size: 5
    });
  }
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

// ボス（ロボット風ドット絵）を canvas 図形で自前描画。既存キャラクター素材は使用しない
function drawEnemy() {
  if (gameState === "loading" || gameState === "calibrating") return;
  const bx = boss.baseX;
  const by = boss.baseY + Math.sin(boss.bobPhase) * 10;
  const flash = boss.hitFlash > 0;

  ctx.save();
  ctx.translate(bx, by);

  const bodyColor = flash ? "#ffffff" : "#3a6fa5";
  const darkColor = flash ? "#dddddd" : "#1c3a5e";
  const eyeColor = boss.dead ? "#555" : "#ff4444";

  // ドット絵風に見せるため、細かい矩形の集合で描画する
  const px = 6; // 1ドットのピクセルサイズ
  const grid = [
    "..OOOOOO..",
    ".OOOOOOOO.",
    "OO.O..O.OO",
    "OOOOOOOOOO",
    ".OOOOOOOO.",
    "..O.OO.O..",
    "..O.OO.O..",
    ".OO.OO.OO.",
  ];
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[row].length; col++) {
      if (grid[row][col] === "O") {
        const isEye = (row === 2 && (col === 2 || col === 7));
        ctx.fillStyle = isEye ? eyeColor : (row % 2 === 0 ? bodyColor : darkColor);
        ctx.fillRect((col - 5) * px, (row - 4) * px, px, px);
      }
    }
  }

  if (boss.dead) {
    ctx.globalAlpha = 0.4;
  }
  ctx.restore();
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

  // 敵の弾（地上/空中で色を変える）
  enemyProjectiles.forEach(p => {
    ctx.save();
    const color = p.type === "ground" ? "#ff8c42" : "#c86bff";
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
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
  bossHpBar.style.width = `${(boss.hp / BOSS_MAX_HP) * 100}%`;
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
