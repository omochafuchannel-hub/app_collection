/* =====================================================================================
   PIXEL TOWN — script.js
   「街そのものがメニューになっているゲーム風ホームページ」

   ---------------------------------------------------------------------------------
   ここを書き換えるだけでリンク先を変更できます
   --------------------------------------------------------------------------------- */
const softwareURL = "https://example.com/software";
const musicURL    = "https://example.com/music";
const toyURL      = "https://example.com/toys";
const podcastURL  = "https://example.com/podcast";
const gameURL     = "https://omochafuchannel-hub.github.io/app_collection/game/";

/* =====================================================================================
   0. 定数・ユーティリティ
   ===================================================================================== */
const Utils = {
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
  lerp(a, b, t) { return a + (b - a) * t; },
  rand(min, max) { return min + Math.random() * (max - min); },
  randInt(min, max) { return Math.floor(Utils.rand(min, max + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); },
  rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  },
  pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }
};

const WORLD = { width: 1700, height: 950 };

// 道路・歩道レイアウト（ワールド座標＝内部描画ピクセル座標）
const LAYOUT = {
  roadH: { y0: 560, y1: 620 },              // 横断する大通り
  sidewalkHTop: { y0: 515, y1: 560 },
  sidewalkHBottom: { y0: 620, y1: 662 },
  roadV: { x0: 1550, x1: 1610 },             // 縦の通り
  sidewalkVLeft: { x0: 1512, x1: 1550 },
  sidewalkVRight: { x0: 1610, x1: 1648 },
  park: { x: 560, y: 700, w: 340, h: 190 },
  fountain: { cx: 730, cy: 795, r: 30 },
};

/* =====================================================================================
   1. AudioManager — 将来のBGM/SE追加を見据えた薄いラッパー
   ===================================================================================== */
class AudioManager {
  constructor() {
    this.bgmTracks = {};   // name -> HTMLAudioElement
    this.seTracks = {};
    this.currentBgm = null;
    this.muted = false;
  }
  loadBGM(name, src) {
    const a = new Audio(src);
    a.loop = true;
    a.volume = 0.5;
    this.bgmTracks[name] = a;
  }
  loadSE(name, src) {
    const a = new Audio(src);
    a.volume = 0.6;
    this.seTracks[name] = a;
  }
  playBGM(name) {
    if (this.muted) return;
    const track = this.bgmTracks[name];
    if (!track) return; // assets/bgm に音源を追加すると自動的に再生されます
    if (this.currentBgm && this.currentBgm !== track) this.currentBgm.pause();
    this.currentBgm = track;
    track.currentTime = 0;
    track.play().catch(() => {});
  }
  stopBGM() {
    if (this.currentBgm) this.currentBgm.pause();
    this.currentBgm = null;
  }
  playSE(name) {
    if (this.muted) return;
    const track = this.seTracks[name];
    if (!track) return; // assets/se に音源を追加すると自動的に再生されます
    const node = track.cloneNode();
    node.volume = track.volume;
    node.play().catch(() => {});
  }
  setMuted(m) {
    this.muted = m;
    if (m) this.stopBGM();
  }
}

/* =====================================================================================
   2. InputManager — キーボード / 仮想スティック / タップ・クリック
   ===================================================================================== */
class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.joyVector = { x: 0, y: 0 };
    this.pointer = { x: 0, y: 0, downX: 0, downY: 0, isDown: false, moved: false };
    this.justPressedInteract = false;
    this.anyInputThisFrame = false;
    this.onTap = null; // callback(internalX, internalY)

    this._bindKeyboard();
    this._bindPointer();
    this._bindJoystick();
  }

  _bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      this.anyInputThisFrame = true;
      if (["Enter", "Space", "KeyE"].includes(e.code)) this.justPressedInteract = true;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  _toInternal(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  _bindPointer() {
    const down = (clientX, clientY) => {
      const p = this._toInternal(clientX, clientY);
      this.pointer.isDown = true;
      this.pointer.moved = false;
      this.pointer.downX = p.x;
      this.pointer.downY = p.y;
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.anyInputThisFrame = true;
    };
    const move = (clientX, clientY) => {
      const p = this._toInternal(clientX, clientY);
      if (Utils.dist(p.x, p.y, this.pointer.downX, this.pointer.downY) > 4) this.pointer.moved = true;
      this.pointer.x = p.x;
      this.pointer.y = p.y;
    };
    const up = () => {
      if (this.pointer.isDown && !this.pointer.moved && this.onTap) {
        this.onTap(this.pointer.x, this.pointer.y);
      }
      this.pointer.isDown = false;
    };

    this.canvas.addEventListener("mousedown", (e) => down(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => { if (this.pointer.isDown) move(e.clientX, e.clientY); });
    window.addEventListener("mouseup", up);

    this.canvas.addEventListener("touchstart", (e) => {
      if (e.target.closest("#joystick-zone")) return;
      const t = e.changedTouches[0];
      down(t.clientX, t.clientY);
    }, { passive: true });
    this.canvas.addEventListener("touchmove", (e) => {
      const t = e.changedTouches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    this.canvas.addEventListener("touchend", (e) => { up(); }, { passive: true });
  }

  _bindJoystick() {
    const zone = document.getElementById("joystick-zone");
    const stick = document.getElementById("joystick-stick");
    const base = document.getElementById("joystick-base");
    let activeTouchId = null;
    const maxR = 40;

    const setStick = (dx, dy) => {
      const len = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(len, maxR);
      const nx = (dx / len) * clamped;
      const ny = (dy / len) * clamped;
      stick.style.transform = `translate(${nx}px, ${ny}px)`;
      this.joyVector.x = nx / maxR;
      this.joyVector.y = ny / maxR;
    };
    const reset = () => {
      stick.style.transform = "translate(0,0)";
      this.joyVector.x = 0;
      this.joyVector.y = 0;
      activeTouchId = null;
    };

    zone.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      activeTouchId = t.identifier;
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setStick(t.clientX - cx, t.clientY - cy);
      this.anyInputThisFrame = true;
      e.preventDefault();
    }, { passive: false });

    zone.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === activeTouchId) {
          const rect = base.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          setStick(t.clientX - cx, t.clientY - cy);
        }
      }
      e.preventDefault();
    }, { passive: false });

    zone.addEventListener("touchend", (e) => { reset(); }, { passive: true });
    zone.addEventListener("touchcancel", (e) => { reset(); }, { passive: true });
  }

  getMoveVector() {
    let x = 0, y = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) y -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) y += 1;
    if (x === 0 && y === 0 && (Math.abs(this.joyVector.x) > 0.12 || Math.abs(this.joyVector.y) > 0.12)) {
      x = this.joyVector.x;
      y = this.joyVector.y;
    }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  consumeInteract() {
    const v = this.justPressedInteract;
    this.justPressedInteract = false;
    return v;
  }

  consumeAnyInput() {
    const v = this.anyInputThisFrame;
    this.anyInputThisFrame = false;
    return v;
  }
}

/* =====================================================================================
   3. Camera
   ===================================================================================== */
class Camera {
  constructor(viewW, viewH) {
    this.x = 0; this.y = 0;
    this.viewW = viewW; this.viewH = viewH;
    this.shake = 0;
  }
  resize(viewW, viewH) { this.viewW = viewW; this.viewH = viewH; }
  follow(targetX, targetY, dt) {
    const goalX = Utils.clamp(targetX - this.viewW / 2, 0, Math.max(0, WORLD.width - this.viewW));
    const goalY = Utils.clamp(targetY - this.viewH / 2, 0, Math.max(0, WORLD.height - this.viewH));
    const t = 1 - Math.pow(0.001, dt);
    this.x = Utils.lerp(this.x, goalX, t);
    this.y = Utils.lerp(this.y, goalY, t);
  }
  setImmediate(targetX, targetY) {
    this.x = Utils.clamp(targetX - this.viewW / 2, 0, Math.max(0, WORLD.width - this.viewW));
    this.y = Utils.clamp(targetY - this.viewH / 2, 0, Math.max(0, WORLD.height - this.viewH));
  }
  worldToScreen(x, y) { return { x: x - this.x, y: y - this.y }; }
}

/* =====================================================================================
   4. Building — 5つの目的地
   ===================================================================================== */
class Building {
  constructor(def) {
    Object.assign(this, def);
    // ドアはフッタープリント下辺の中央
    this.door = { x: this.x + this.w / 2 - 13, y: this.y + this.h - 20, w: 26, h: 20 };
    this.hover = 0;          // 0-1 ドアが開く演出
    this.signPhase = Utils.rand(0, Math.PI * 2);
    this.onAirPhase = Utils.rand(0, 10);
  }

  get footY() { return this.y + this.h; }

  isPlayerNear(player) {
    const cx = this.door.x + this.door.w / 2;
    const cy = this.door.y + this.door.h / 2;
    return Utils.dist(player.x, player.y, cx, cy) < 70;
  }

  update(dt, playerNear) {
    const target = playerNear ? 1 : 0;
    this.hover = Utils.lerp(this.hover, target, 1 - Math.pow(0.0005, dt));
    this.signPhase += dt;
    this.onAirPhase += dt;
  }

  draw(ctx, cam) {
    const s = cam.worldToScreen(this.x, this.y);
    ctx.save();
    ctx.translate(s.x, s.y);
    switch (this.type) {
      case "office": this._drawOffice(ctx); break;
      case "livehouse": this._drawLiveHouse(ctx); break;
      case "arcade": this._drawArcade(ctx); break;
      case "radio": this._drawRadio(ctx); break;
      case "toyshop": this._drawToyShop(ctx); break;
    }
    this._drawDoor(ctx);
    this._drawLabel(ctx);
    ctx.restore();
  }

  _drawDoor(ctx) {
    const d = this.door;
    const localX = d.x - this.x, localY = d.y - this.y;
    const open = this.hover; // 0..1
    ctx.save();
    ctx.translate(localX, localY);
    // 中から漏れる光
    if (open > 0.02) {
      ctx.fillStyle = `rgba(255, 214, 130, ${0.55 * open})`;
      ctx.beginPath();
      ctx.moveTo(d.w / 2, d.h);
      ctx.lineTo(-10 - 14 * open, d.h + 26 + 20 * open);
      ctx.lineTo(d.w + 10 + 14 * open, d.h + 26 + 20 * open);
      ctx.closePath();
      ctx.fill();
    }
    // 扉本体（左右に開く２枚扉）
    ctx.fillStyle = "#3b2416";
    const leafW = d.w / 2;
    ctx.fillRect(-leafW * open * 0.5, 0, leafW, d.h);
    ctx.fillRect(d.w - leafW - (-leafW * open * 0.5) + leafW * open, 0, leafW, d.h);
    ctx.fillStyle = "#5a3a22";
    ctx.fillRect(-leafW * open * 0.5 + 3, 3, leafW - 6, d.h - 6);
    ctx.restore();
  }

  _drawLabel(ctx) {
    if (this.hover < 0.05) return;
    ctx.save();
    ctx.globalAlpha = Utils.clamp(this.hover, 0, 1);
    ctx.font = "10px 'DotGothic16', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(20,19,42,0.75)";
    const label = this.name;
    const textW = ctx.measureText(label).width + 14;
    ctx.fillRect(this.w / 2 - textW / 2, -14, textW, 16);
    ctx.fillStyle = "#ffd166";
    ctx.fillText(label, this.w / 2, -2);
    ctx.restore();
  }

  // ---- ①ソフトウェアエンジニアリング：高層ビル ----
  _drawOffice(ctx) {
    const { w, h } = this;
    ctx.fillStyle = "#2c3350";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#232a44";
    ctx.fillRect(0, 0, w, 10);
    // 窓（一部点滅）
    const cols = Math.floor(w / 26), rows = Math.floor((h - 30) / 24);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const flicker = Math.sin(this.signPhase * 0.6 + r * 1.3 + c * 2.1) > 0.55;
        ctx.fillStyle = flicker ? "#ffe9a8" : "#5b6a9c";
        ctx.fillRect(14 + c * 26, 24 + r * 24, 16, 14);
      }
    }
    // 屋上アンテナ & 「SE」ロゴパネル
    ctx.strokeStyle = "#aab4d6"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, -22); ctx.stroke();
    ctx.fillStyle = "#ff5da2";
    ctx.beginPath(); ctx.arc(w / 2, -24, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#14132a";
    ctx.fillRect(w / 2 - 26, -14, 52, 16);
    ctx.fillStyle = "#7ee7ff";
    ctx.font = "9px 'Press Start 2P', monospace";
    ctx.textAlign = "center";
    ctx.fillText("SE", w / 2, -2);
    // 入口横のPCアイコン看板
    this._panel(ctx, this.door.x - this.x - 4, this.door.y - this.y - 44, 34, 30, "#101425", () => {
      ctx.fillStyle = "#7ee7ff";
      ctx.fillRect(3, 4, 22, 14);
      ctx.fillStyle = "#14132a";
      ctx.fillRect(6, 7, 16, 8);
      ctx.fillRect(10, 18, 8, 3);
    });
  }

  // ---- ②音楽：ライブハウス ----
  _drawLiveHouse(ctx) {
    const { w, h } = this;
    ctx.fillStyle = "#4a2036";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 18) {
      ctx.fillStyle = "#3a1829";
      ctx.fillRect(i, 0, 2, h);
    }
    // ネオン：ギター型
    const glow = 0.6 + 0.4 * Math.sin(this.signPhase * 3);
    ctx.save();
    ctx.strokeStyle = `rgba(255,93,162,${glow})`;
    ctx.lineWidth = 3;
    ctx.shadowColor = "#ff5da2";
    ctx.shadowBlur = 8 * glow;
    ctx.beginPath();
    ctx.ellipse(w / 2, 30, 16, 20, 0, 0, Math.PI * 2);
    ctx.moveTo(w / 2, 10);
    ctx.lineTo(w / 2, -22);
    ctx.stroke();
    ctx.restore();
    // マーキー「LIVE」
    const on = Math.sin(this.signPhase * 4) > -0.3;
    ctx.fillStyle = "#1a1020";
    ctx.fillRect(w / 2 - 34, 46, 68, 20);
    ctx.font = "10px 'Press Start 2P', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = on ? "#ffd166" : "#5a4a55";
    ctx.fillText("LIVE", w / 2, 60);
    // スピーカー（ドア両脇）
    const dx = this.door.x - this.x, dy = this.door.y - this.y;
    for (const side of [-1, 1]) {
      const sx = dx + this.door.w / 2 + side * 26;
      ctx.fillStyle = "#161018";
      ctx.fillRect(sx - 10, dy - 30, 20, 30);
      ctx.fillStyle = "#3a2c33";
      ctx.beginPath(); ctx.arc(sx, dy - 20, 6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx, dy - 8, 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---- ⑤ゲーム：ゲームセンター（一番派手） ----
  _drawArcade(ctx) {
    const { w, h } = this;
    ctx.fillStyle = "#221540";
    ctx.fillRect(0, 0, w, h);
    // LEDボーダー（点滅）
    const t = this.signPhase;
    const colors = ["#ff5da2", "#7ee7ff", "#ffd166", "#8dff9c"];
    let ci = 0;
    for (let x = 0; x < w; x += 12) {
      ctx.fillStyle = colors[(Math.floor(t * 4) + ci) % colors.length];
      ctx.fillRect(x, 0, 6, 4);
      ctx.fillRect(x, h - 4, 6, 4);
      ci++;
    }
    for (let y = 0; y < h; y += 12) {
      ctx.fillStyle = colors[(Math.floor(t * 4) + ci) % colors.length];
      ctx.fillRect(0, y, 4, 6);
      ctx.fillRect(w - 4, y, 4, 6);
      ci++;
    }
    // 大型マーキー「GAME」
    ctx.fillStyle = "#0e0a1c";
    ctx.fillRect(w / 2 - 56, 14, 112, 30);
    ctx.font = "14px 'Press Start 2P', monospace";
    ctx.textAlign = "center";
    const pulse = 0.7 + 0.3 * Math.sin(t * 5);
    ctx.fillStyle = `rgba(255,209,102,${pulse})`;
    ctx.shadowColor = "#ffd166";
    ctx.shadowBlur = 10 * pulse;
    ctx.fillText("GAME", w / 2, 36);
    ctx.shadowBlur = 0;
    // 筐体シルエット（ドア両脇）
    const dx = this.door.x - this.x, dy = this.door.y - this.y;
    for (const side of [-1, 1]) {
      const sx = dx + this.door.w / 2 + side * 30;
      ctx.fillStyle = "#150d2a";
      ctx.fillRect(sx - 11, dy - 34, 22, 34);
      ctx.fillStyle = colors[Math.floor(t * 2) % colors.length];
      ctx.fillRect(sx - 7, dy - 28, 14, 10);
    }
  }

  // ---- ④ポッドキャスト：ラジオ局 ----
  _drawRadio(ctx) {
    const { w, h } = this;
    ctx.fillStyle = "#25324a";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#1c2740";
    ctx.fillRect(0, 0, w, 8);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = "#4a5c82";
      ctx.fillRect(16 + i * (w - 32) / 3, 20, (w - 32) / 3 - 10, 40);
    }
    // アンテナ塔
    ctx.strokeStyle = "#c7cfe6"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, -46);
    ctx.moveTo(w / 2 - 12, -30); ctx.lineTo(w / 2 + 12, -30);
    ctx.moveTo(w / 2 - 8, -18); ctx.lineTo(w / 2 + 8, -18);
    ctx.stroke();
    const blink = Math.sin(this.onAirPhase * 3) > 0;
    ctx.fillStyle = blink ? "#ff5252" : "#5a2020";
    ctx.beginPath(); ctx.arc(w / 2, -48, 3, 0, Math.PI * 2); ctx.fill();
    // 「ON AIR」看板
    const active = Math.sin(this.onAirPhase * 0.5) > -0.2;
    ctx.fillStyle = "#14101c";
    ctx.fillRect(w / 2 - 30, 68, 60, 18);
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = active ? "#ff5252" : "#5a3838";
    ctx.fillText("ON AIR", w / 2, 80);
  }

  // ---- ③ブロック（おもちゃ）：おもちゃ屋 ----
  _drawToyShop(ctx) {
    const { w, h } = this;
    ctx.fillStyle = "#f4e8c1";
    ctx.fillRect(0, 0, w, h);
    // カラフル屋根縞
    const stripes = ["#ff5da2", "#ffd166", "#7ee7ff", "#8dff9c"];
    for (let i = 0; i < w; i += 20) {
      ctx.fillStyle = stripes[(i / 20) % stripes.length];
      ctx.beginPath();
      ctx.moveTo(i, 0); ctx.lineTo(i + 20, 0); ctx.lineTo(i + 10, -16);
      ctx.closePath(); ctx.fill();
    }
    // ショーウィンドウ：積み木
    ctx.fillStyle = "#dff0ff";
    ctx.fillRect(14, 20, w - 28, 42);
    const blockColors = ["#ff5da2", "#ffd166", "#7ee7ff", "#8dff9c", "#c78dff"];
    let bx = 20;
    let bi = 0;
    while (bx < w - 30) {
      const bw = 16;
      ctx.fillStyle = blockColors[bi % blockColors.length];
      ctx.fillRect(bx, 46, bw, 14);
      bx += bw + 4; bi++;
    }
    // 看板
    ctx.fillStyle = "#ff5da2";
    ctx.fillRect(w / 2 - 40, 72, 80, 18);
    ctx.font = "8px 'DotGothic16', monospace";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText("TOY BLOCKS", w / 2, 84);
  }

  _panel(ctx, x, y, w, h, bg, drawInner) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    drawInner();
    ctx.restore();
  }
}

/* =====================================================================================
   5. Player
   ===================================================================================== */
class Player {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.w = 12; this.h = 16;
    this.dir = "down";
    this.speed = 96; // px/sec
    this.walkPhase = 0;
    this.moving = false;
  }
  get footY() { return this.y + this.h / 2; }

  update(dt, moveVec, collision) {
    this.moving = moveVec.x !== 0 || moveVec.y !== 0;
    if (this.moving) {
      if (Math.abs(moveVec.x) > Math.abs(moveVec.y)) this.dir = moveVec.x > 0 ? "right" : "left";
      else this.dir = moveVec.y > 0 ? "down" : "up";
      this.walkPhase += dt * 9;
      const dx = moveVec.x * this.speed * dt;
      const dy = moveVec.y * this.speed * dt;
      collision.moveWithCollision(this, dx, dy);
    }
  }

  draw(ctx, cam) {
    const s = cam.worldToScreen(this.x, this.y);
    const bob = this.moving ? Math.sin(this.walkPhase) * 1.4 : 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    // 影
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(0, this.h / 2 + 1, 7, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(0, bob);
    // 体
    ctx.fillStyle = "#3a6ea5";
    ctx.fillRect(-5, -2, 10, 10);
    // 頭
    ctx.fillStyle = "#ffd7ae";
    ctx.fillRect(-5, -12, 10, 10);
    // 髪
    ctx.fillStyle = "#4a3222";
    ctx.fillRect(-6, -13, 12, 5);
    // 向きの目印
    ctx.fillStyle = "#2a2a2a";
    if (this.dir === "down") { ctx.fillRect(-3, -8, 2, 2); ctx.fillRect(2, -8, 2, 2); }
    if (this.dir === "up") { /* 後ろ姿は目を描かない */ }
    if (this.dir === "left") ctx.fillRect(-6, -8, 2, 2);
    if (this.dir === "right") ctx.fillRect(4, -8, 2, 2);
    // 足
    ctx.fillStyle = "#2c2c3a";
    const step = this.moving ? Math.sin(this.walkPhase) * 3 : 0;
    ctx.fillRect(-4 + step, 8, 3, 5);
    ctx.fillRect(1 - step, 8, 3, 5);
    ctx.restore();
  }
}

/* =====================================================================================
   6. NPC — 通行人
   ===================================================================================== */
const NPC_ZONES = [
  { x: 60, y: 520, w: 1400, h: 34 },      // 上側歩道（店先）
  { x: 20, y: 626, w: 1620, h: 30 },      // 下側歩道
  { x: 580, y: 705, w: 300, h: 40 },      // 公園上部
  { x: 580, y: 850, w: 300, h: 40 },      // 公園下部
  { x: 1520, y: 40, w: 20, h: 460 },      // 縦通り歩道（左）
];

class NPC {
  constructor(id) {
    this.id = id;
    const zone = Utils.pick(NPC_ZONES);
    this.x = Utils.rand(zone.x, zone.x + zone.w);
    this.y = Utils.rand(zone.y, zone.y + zone.h);
    this.palette = Utils.pick(["#c96a4e", "#4e8fc9", "#7fc96a", "#c9ab4e", "#a06ac9", "#c94ea0"]);
    this.state = "idle";
    this.timer = Utils.rand(0.5, 2.5);
    this.target = { x: this.x, y: this.y };
    this.speed = Utils.rand(18, 34);
    this.dir = "down";
    this.walkPhase = Utils.rand(0, 10);
    this.kind = Utils.pick(["person", "person", "person", "dog", "cat"]);
  }
  get footY() { return this.y; }

  _pickTarget() {
    const zone = Utils.pick(NPC_ZONES);
    this.target.x = Utils.rand(zone.x, zone.x + zone.w);
    this.target.y = Utils.rand(zone.y, zone.y + zone.h);
  }

  update(dt) {
    this.timer -= dt;
    if (this.state === "idle") {
      if (this.timer <= 0) {
        this._pickTarget();
        this.state = "walk";
        this.timer = 8;
      }
    } else {
      const d = Utils.dist(this.x, this.y, this.target.x, this.target.y);
      if (d < 4 || this.timer <= 0) {
        this.state = "idle";
        this.timer = Utils.rand(1, 4);
      } else {
        const vx = (this.target.x - this.x) / d;
        const vy = (this.target.y - this.y) / d;
        this.x += vx * this.speed * dt;
        this.y += vy * this.speed * dt;
        this.walkPhase += dt * 7;
        if (Math.abs(vx) > Math.abs(vy)) this.dir = vx > 0 ? "right" : "left";
        else this.dir = vy > 0 ? "down" : "up";
      }
    }
  }

  draw(ctx, cam) {
    const s = cam.worldToScreen(this.x, this.y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.ellipse(0, 7, 6, 2.4, 0, 0, Math.PI * 2); ctx.fill();
    const bob = this.state === "walk" ? Math.sin(this.walkPhase) * 1 : 0;
    ctx.translate(0, bob);
    if (this.kind === "person") {
      ctx.fillStyle = this.palette;
      ctx.fillRect(-4, -8, 8, 8);
      ctx.fillStyle = "#f1caa0";
      ctx.fillRect(-3.5, -15, 7, 7);
      ctx.fillStyle = "#2c2c3a";
      const step = this.state === "walk" ? Math.sin(this.walkPhase) * 2.4 : 0;
      ctx.fillRect(-3 + step, 0, 2.4, 4);
      ctx.fillRect(0.6 - step, 0, 2.4, 4);
    } else if (this.kind === "dog") {
      ctx.fillStyle = "#caa06a";
      ctx.fillRect(-6, -4, 10, 5);
      ctx.fillRect(3, -6, 4, 4);
      ctx.fillStyle = "#8a6a44";
      ctx.fillRect(-7, 1, 2, 3); ctx.fillRect(3, 1, 2, 3);
    } else { // cat
      ctx.fillStyle = "#555a63";
      ctx.fillRect(-5, -4, 8, 4);
      ctx.fillRect(2, -6, 3, 3);
      ctx.fillRect(-7, -6, 2, 2);
    }
    ctx.restore();
  }
}

/* =====================================================================================
   7. Vehicle — 道路上の車・バス
   ===================================================================================== */
class Vehicle {
  constructor(def) {
    Object.assign(this, def); // {axis:'h'|'v', lane, min, max, speed, dir, color, len, kind}
    this.pos = Utils.rand(this.min, this.max);
  }
  get footY() { return this.axis === "h" ? this.lane + 8 : this.pos + 8; }

  update(dt) {
    this.pos += this.speed * this.dir * dt;
    if (this.pos > this.max) { this.pos = this.max; this.dir *= -1; }
    if (this.pos < this.min) { this.pos = this.min; this.dir *= -1; }
  }

  draw(ctx, cam) {
    let wx, wy, w, h, horizontal;
    if (this.axis === "h") { wx = this.pos; wy = this.lane; w = this.len; h = 16; horizontal = true; }
    else { wx = this.lane; wy = this.pos; w = 16; h = this.len; horizontal = false; }
    const s = cam.worldToScreen(wx, wy);
    ctx.save();
    ctx.translate(s.x, s.y);
    if (this.dir < 0 && horizontal) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, h - 2, w, 4);
    ctx.fillStyle = this.color;
    ctx.fillRect(0, 0, w, h - 4);
    ctx.fillStyle = "#cfe8ff";
    ctx.fillRect(horizontal ? w * 0.55 : 2, 2, horizontal ? w * 0.35 : w - 4, h - 10);
    ctx.fillStyle = "#1c1c22";
    ctx.fillRect(horizontal ? w * 0.12 : 2, h - 6, 5, 5);
    ctx.fillRect(horizontal ? w * 0.72 : w - 7, h - 6, 5, 5);
    ctx.fillStyle = "#fff6c8";
    ctx.fillRect(horizontal ? w - 3 : 2, 3, 3, 3);
    ctx.restore();
  }
}

/* =====================================================================================
   8. Particles — 雲・鳥
   ===================================================================================== */
class CloudField {
  constructor(count) {
    this.clouds = Array.from({ length: count }, () => ({
      x: Utils.rand(0, WORLD.width),
      y: Utils.rand(20, 130),
      scale: Utils.rand(0.6, 1.6),
      speed: Utils.rand(3, 9),
    }));
  }
  update(dt) {
    for (const c of this.clouds) {
      c.x += c.speed * dt;
      if (c.x > WORLD.width + 100) c.x = -100;
    }
  }
  draw(ctx, cam, parallax) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (const c of this.clouds) {
      const sx = (c.x - cam.x * parallax) % (WORLD.width + 200);
      const x = sx < -100 ? sx + WORLD.width + 200 : sx;
      const y = c.y - cam.y * 0.05;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(c.scale, c.scale);
      ctx.beginPath();
      ctx.ellipse(0, 0, 20, 8, 0, 0, Math.PI * 2);
      ctx.ellipse(14, -3, 14, 7, 0, 0, Math.PI * 2);
      ctx.ellipse(-14, -2, 12, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}

class BirdFlock {
  constructor(count) {
    this.birds = Array.from({ length: count }, () => ({
      x: Utils.rand(0, WORLD.width),
      y: Utils.rand(40, 160),
      speed: Utils.rand(30, 55),
      phase: Utils.rand(0, 10),
    }));
  }
  update(dt) {
    for (const b of this.birds) {
      b.x += b.speed * dt;
      b.phase += dt * 10;
      if (b.x > WORLD.width + 30) b.x = -30;
    }
  }
  draw(ctx, cam) {
    ctx.strokeStyle = "#2a2a3a";
    ctx.lineWidth = 1.4;
    for (const b of this.birds) {
      const s = cam.worldToScreen(b.x, b.y);
      const flap = Math.sin(b.phase) * 3;
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y + flap);
      ctx.quadraticCurveTo(s.x, s.y - 3, s.x + 4, s.y + flap);
      ctx.stroke();
    }
  }
}

/* =====================================================================================
   9. CollisionManager
   ===================================================================================== */
class CollisionManager {
  constructor(buildings) { this.buildings = buildings; }

  moveWithCollision(entity, dx, dy) {
    entity.x = Utils.clamp(entity.x + dx, 8, WORLD.width - 8);
    if (this._hitsBuilding(entity)) entity.x -= dx;
    entity.y = Utils.clamp(entity.y + dy, 8, WORLD.height - 8);
    if (this._hitsBuilding(entity)) entity.y -= dy;
  }

  _hitsBuilding(entity) {
    const r = { x: entity.x - entity.w / 2, y: entity.y - 4, w: entity.w, h: 10 };
    for (const b of this.buildings) {
      const solid = { x: b.x, y: b.y, w: b.w, h: b.h - 4 }; // ドア前は少し歩けるよう余白
      if (Utils.rectsOverlap(r, solid)) return true;
    }
    return false;
  }
}

/* =====================================================================================
   10. Dialog — ゲーム風の確認ウィンドウ
   ===================================================================================== */
class Dialog {
  constructor(onOpenChange) {
    this.overlay = document.getElementById("dialog-overlay");
    this.titleEl = document.getElementById("dialog-title");
    this.msgEl = document.getElementById("dialog-message");
    this.choices = Array.from(document.querySelectorAll("#dialog-choices li"));
    this.active = false;
    this.selected = 0; // 0 = はい, 1 = いいえ
    this.url = null;
    this.onOpenChange = onOpenChange;

    this.choices.forEach((li, i) => {
      li.addEventListener("click", () => {
        this.selected = i;
        this._render();
        this._confirm();
      });
      li.addEventListener("mouseenter", () => { this.selected = i; this._render(); });
    });

    window.addEventListener("keydown", (e) => {
      if (!this.active) return;
      if (e.code === "ArrowUp" || e.code === "ArrowLeft") { this.selected = 0; this._render(); }
      if (e.code === "ArrowDown" || e.code === "ArrowRight") { this.selected = 1; this._render(); }
      if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); this._confirm(); }
      if (e.code === "Escape") { this.close(); }
    });
  }

  open(building) {
    this.active = true;
    this.selected = 0;
    this.url = building.url;
    this.titleEl.textContent = building.name;
    this.msgEl.textContent = `${building.name}へ入りますか？`;
    this.overlay.classList.remove("hidden");
    this._render();
    this.onOpenChange && this.onOpenChange(true);
  }

  close() {
    this.active = false;
    this.overlay.classList.add("hidden");
    this.onOpenChange && this.onOpenChange(false);
  }

  _render() {
    this.choices.forEach((li, i) => li.classList.toggle("active", i === this.selected));
  }

  _confirm() {
    if (this.selected === 0 && this.url) {
      window.location.href = this.url;
    } else {
      this.close();
    }
  }
}

/* =====================================================================================
   11. World — 街の静的レイアウトと全エンティティの統括
   ===================================================================================== */
class World {
  constructor() {
    this.buildings = [
      new Building({ id: "software", name: "ソフトウェアエンジニアリング", type: "office",
        x: 60, y: 180, w: 220, h: 335, url: softwareURL }),
      new Building({ id: "music", name: "音楽", type: "livehouse",
        x: 340, y: 345, w: 190, h: 170, url: musicURL }),
      new Building({ id: "game", name: "ゲーム", type: "arcade",
        x: 590, y: 315, w: 230, h: 200, url: gameURL }),
      new Building({ id: "podcast", name: "ポッドキャスト", type: "radio",
        x: 900, y: 325, w: 190, h: 190, url: podcastURL }),
      new Building({ id: "toy", name: "ブロック（おもちゃ）", type: "toyshop",
        x: 1180, y: 365, w: 200, h: 150, url: toyURL }),
    ];

    this.npcs = Array.from({ length: 13 }, (_, i) => new NPC(i));

    this.vehicles = [
      new Vehicle({ axis: "h", lane: 568, min: 20, max: 1680, speed: 70, dir: 1, color: "#d94f4f", len: 30, kind: "car" }),
      new Vehicle({ axis: "h", lane: 596, min: 20, max: 1680, speed: 58, dir: -1, color: "#4f8ed9", len: 30, kind: "car" }),
      new Vehicle({ axis: "h", lane: 568, min: 20, max: 1680, speed: 40, dir: -1, color: "#d9b84f", len: 46, kind: "bus" }),
      new Vehicle({ axis: "v", lane: 1568, min: 20, max: 920, speed: 50, dir: 1, color: "#7fd94f", len: 28, kind: "car" }),
    ];

    this.clouds = new CloudField(7);
    this.birds = new BirdFlock(5);

    this.treeSway = 0;
    this.fountainPhase = 0;
    this.lampGlow = 0;
    this.trafficPhase = 0;

    this.streetTrees = this._layoutAlong([
      { x0: 40, x1: 1480, y: 508 },
      { x0: 20, x1: 1690, y: 668 },
    ], 95);

    this.lamps = this._layoutAlong([
      { x0: 60, x1: 1480, y: 508 },
      { x0: 40, x1: 1690, y: 668 },
    ], 230);

    this.poles = this._layoutAlong([
      { x0: 100, x1: 1460, y: 508 },
    ], 260, 45);

    this.benches = [
      { x: 610, y: 730 }, { x: 850, y: 730 }, { x: 610, y: 860 }, { x: 850, y: 860 },
    ];

    this.hedges = this._rectPerimeter(LAYOUT.park.x - 12, LAYOUT.park.y - 12, LAYOUT.park.w + 24, LAYOUT.park.h + 24, 14);

    this.vendingMachines = [{ x: 250, y: 632 }, { x: 1430, y: 632 }];

    this.houses = [
      { x: 60, y: 780, w: 130, h: 80, color: "#c98a5a" },
      { x: 1330, y: 780, w: 150, h: 84, color: "#8ab0c9" },
    ];
  }

  _layoutAlong(segments, spacing, jitter = 0) {
    const items = [];
    for (const seg of segments) {
      for (let x = seg.x0; x <= seg.x1; x += spacing) {
        items.push({ x: x + Utils.rand(-jitter, jitter), y: seg.y });
      }
    }
    return items;
  }

  _rectPerimeter(x, y, w, h, spacing) {
    const pts = [];
    for (let px = x; px <= x + w; px += spacing) { pts.push({ x: px, y: y }); pts.push({ x: px, y: y + h }); }
    for (let py = y; py <= y + h; py += spacing) { pts.push({ x: x, y: py }); pts.push({ x: x + w, y: py }); }
    return pts;
  }

  update(dt, player) {
    this.treeSway += dt;
    this.fountainPhase += dt;
    this.lampGlow += dt;
    this.trafficPhase += dt;
    for (const b of this.buildings) b.update(dt, b.isPlayerNear(player));
    for (const n of this.npcs) n.update(dt);
    for (const v of this.vehicles) v.update(dt);
    this.clouds.update(dt);
    this.birds.update(dt);
  }

  findNearestDoor(player) {
    let best = null, bestD = Infinity;
    for (const b of this.buildings) {
      const cx = b.door.x + b.door.w / 2, cy = b.door.y + b.door.h / 2;
      const d = Utils.dist(player.x, player.y, cx, cy);
      if (d < 70 && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  hitTestDoor(internalX, internalY, cam) {
    for (const b of this.buildings) {
      const screenRect = { x: b.door.x - cam.x - 10, y: b.door.y - cam.y - 10, w: b.door.w + 20, h: b.door.h + 20 };
      if (Utils.pointInRect(internalX, internalY, screenRect)) return b;
    }
    return null;
  }

  /* ---------------- 背景（空・山・雲） ---------------- */
  drawSky(ctx, cam, viewW, viewH) {
    const grad = ctx.createLinearGradient(0, 0, 0, viewH);
    grad.addColorStop(0, "#241b3b");
    grad.addColorStop(0.45, "#5a4382");
    grad.addColorStop(0.75, "#c9708a");
    grad.addColorStop(1, "#ffb27a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, viewW, viewH);

    // 遠景の山（パララックス）
    ctx.fillStyle = "#4a3a63";
    const mBase = viewH * 0.42;
    ctx.beginPath();
    ctx.moveTo(-50, mBase);
    for (let x = -50; x <= viewW + 50; x += 60) {
      const wx = x + cam.x * 0.1;
      const peak = mBase - 30 - 26 * Math.sin(wx * 0.004) - 14 * Math.sin(wx * 0.011 + 2);
      ctx.lineTo(x, peak);
    }
    ctx.lineTo(viewW + 50, viewH);
    ctx.lineTo(-50, viewH);
    ctx.closePath();
    ctx.fill();

    this.clouds.draw(ctx, cam, 0.25);
  }

  /* ---------------- 地面（道路・歩道・公園） ---------------- */
  drawGround(ctx, cam) {
    ctx.save();
    ctx.translate(-cam.x, -cam.y);

    // 全体の地面ベース（草地）
    ctx.fillStyle = "#3f7a4d";
    ctx.fillRect(0, 0, WORLD.width, WORLD.height);

    // 歩道
    ctx.fillStyle = "#b9b6ad";
    ctx.fillRect(0, LAYOUT.sidewalkHTop.y0, WORLD.width, LAYOUT.sidewalkHTop.y1 - LAYOUT.sidewalkHTop.y0);
    ctx.fillRect(0, LAYOUT.sidewalkHBottom.y0, WORLD.width, LAYOUT.sidewalkHBottom.y1 - LAYOUT.sidewalkHBottom.y0);
    ctx.fillRect(LAYOUT.sidewalkVLeft.x0, 0, LAYOUT.sidewalkVLeft.x1 - LAYOUT.sidewalkVLeft.x0, WORLD.height);
    ctx.fillRect(LAYOUT.sidewalkVRight.x0, 0, LAYOUT.sidewalkVRight.x1 - LAYOUT.sidewalkVRight.x0, WORLD.height);
    // 歩道タイル目地
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    for (let x = 0; x < WORLD.width; x += 20) {
      ctx.beginPath(); ctx.moveTo(x, LAYOUT.sidewalkHTop.y0); ctx.lineTo(x, LAYOUT.sidewalkHTop.y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, LAYOUT.sidewalkHBottom.y0); ctx.lineTo(x, LAYOUT.sidewalkHBottom.y1); ctx.stroke();
    }

    // 道路
    ctx.fillStyle = "#454049";
    ctx.fillRect(0, LAYOUT.roadH.y0, WORLD.width, LAYOUT.roadH.y1 - LAYOUT.roadH.y0);
    ctx.fillRect(LAYOUT.roadV.x0, 0, LAYOUT.roadV.x1 - LAYOUT.roadV.x0, WORLD.height);
    // センターライン
    ctx.strokeStyle = "#e8d98a";
    ctx.setLineDash([16, 12]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, (LAYOUT.roadH.y0 + LAYOUT.roadH.y1) / 2);
    ctx.lineTo(WORLD.width, (LAYOUT.roadH.y0 + LAYOUT.roadH.y1) / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo((LAYOUT.roadV.x0 + LAYOUT.roadV.x1) / 2, 0);
    ctx.lineTo((LAYOUT.roadV.x0 + LAYOUT.roadV.x1) / 2, WORLD.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // 横断歩道（交差点）
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let x = LAYOUT.roadV.x0 + 4; x < LAYOUT.roadV.x1 - 4; x += 12) {
      ctx.fillRect(x, LAYOUT.roadH.y0 - 14, 6, 14);
      ctx.fillRect(x, LAYOUT.roadH.y1, 6, 14);
    }
    for (let y = LAYOUT.roadH.y0 + 4; y < LAYOUT.roadH.y1 - 4; y += 12) {
      ctx.fillRect(LAYOUT.roadV.x0 - 14, y, 14, 6);
      ctx.fillRect(LAYOUT.roadV.x1, y, 14, 6);
    }

    // 公園
    const p = LAYOUT.park;
    ctx.fillStyle = "#5a9a5f";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    for (let i = 0; i < 6; i++) {
      ctx.beginPath(); ctx.moveTo(p.x, p.y + (i / 6) * p.h); ctx.lineTo(p.x + p.w, p.y + (i / 6) * p.h); ctx.stroke();
    }
    for (const h of this.hedges) {
      ctx.fillStyle = "#3f7a45";
      ctx.fillRect(h.x - 5, h.y - 5, 10, 10);
    }

    ctx.restore();
  }

  drawFountain(ctx, cam) {
    const f = LAYOUT.fountain;
    const s = cam.worldToScreen(f.cx, f.cy);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#8a8a92";
    ctx.beginPath(); ctx.ellipse(0, 4, f.r, f.r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3d78c9";
    ctx.beginPath(); ctx.ellipse(0, 2, f.r - 6, (f.r - 6) * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    // 噴水の水しぶき
    for (let i = 0; i < 5; i++) {
      const ph = this.fountainPhase * 3 + i * 1.3;
      const jump = Math.abs(Math.sin(ph));
      ctx.fillStyle = `rgba(220,245,255,${0.5 + 0.4 * jump})`;
      ctx.beginPath();
      ctx.arc(Math.cos(i * 1.25) * 8, -18 * jump, 2 + jump, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#c9c9d2";
    ctx.fillRect(-4, -8, 8, 10);
    ctx.restore();
  }

  _drawTree(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    const sway = Math.sin(this.treeSway * 1.3 + x * 0.05) * 3;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath(); ctx.ellipse(0, 2, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#6b4a30";
    ctx.fillRect(-3, -14, 6, 16);
    ctx.save();
    ctx.translate(0, -14);
    ctx.rotate(sway * 0.02);
    ctx.fillStyle = "#3f7a45";
    ctx.beginPath(); ctx.arc(0, -12, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#4f8f55";
    ctx.beginPath(); ctx.arc(-6 + sway * 0.3, -16, 10, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(7, -18, 9, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  _drawLamp(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    const glow = 0.6 + 0.4 * Math.sin(this.lampGlow * 2 + x * 0.1);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#2c2c33";
    ctx.fillRect(-2, -40, 4, 40);
    ctx.fillStyle = `rgba(255, 224, 150, ${glow})`;
    ctx.beginPath(); ctx.arc(0, -42, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255, 224, 150, ${glow * 0.25})`;
    ctx.beginPath(); ctx.arc(0, -30, 20, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _drawPole(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#5a4a3a";
    ctx.fillRect(-2, -54, 4, 54);
    ctx.strokeStyle = "#333";
    ctx.beginPath();
    ctx.moveTo(-2, -48); ctx.lineTo(-20, -52);
    ctx.moveTo(2, -46); ctx.lineTo(20, -50);
    ctx.stroke();
    ctx.restore();
  }

  _drawBench(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#8a5a34";
    ctx.fillRect(-14, -2, 28, 3);
    ctx.fillRect(-14, -10, 28, 3);
    ctx.fillStyle = "#4a3222";
    ctx.fillRect(-12, 1, 3, 6); ctx.fillRect(9, 1, 3, 6);
    ctx.restore();
  }

  _drawVending(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#d94f4f";
    ctx.fillRect(-9, -28, 18, 28);
    ctx.fillStyle = "#fefefe";
    ctx.fillRect(-7, -24, 14, 14);
    ctx.fillStyle = "#ffd166";
    for (let i = 0; i < 3; i++) ctx.fillRect(-6 + i * 5, -22, 3, 10);
    ctx.fillStyle = "#2c2c33";
    ctx.fillRect(-7, -8, 14, 6);
    ctx.restore();
  }

  _drawHouse(ctx, cam, h) {
    const s = cam.worldToScreen(h.x, h.y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = h.color;
    ctx.fillRect(0, h.h * 0.4, h.w, h.h * 0.6);
    ctx.fillStyle = "#5a3a2c";
    ctx.beginPath();
    ctx.moveTo(-6, h.h * 0.4);
    ctx.lineTo(h.w / 2, -h.h * 0.15);
    ctx.lineTo(h.w + 6, h.h * 0.4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fff6d6";
    ctx.fillRect(h.w * 0.2, h.h * 0.55, h.w * 0.18, h.h * 0.2);
    ctx.fillRect(h.w * 0.62, h.h * 0.55, h.w * 0.18, h.h * 0.2);
    ctx.fillStyle = "#4a3222";
    ctx.fillRect(h.w * 0.44, h.h * 0.65, h.w * 0.14, h.h * 0.35);
    ctx.restore();
  }

  _drawTrafficLight(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    const cyclePos = (this.trafficPhase % 6);
    const state = cyclePos < 3 ? "green" : cyclePos < 4.2 ? "yellow" : "red";
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#333";
    ctx.fillRect(-2, -50, 4, 50);
    ctx.fillStyle = "#222";
    ctx.fillRect(-7, -70, 14, 24);
    const lights = [["red", -63], ["yellow", -55], ["green", -47]];
    for (const [color, ly] of lights) {
      ctx.fillStyle = state === color
        ? { red: "#ff4444", yellow: "#ffd166", green: "#5fdc6a" }[color]
        : "#4a4a4a";
      ctx.beginPath(); ctx.arc(0, ly, 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _drawParkSign(ctx, cam, x, y) {
    const s = cam.worldToScreen(x, y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = "#6b4a30";
    ctx.fillRect(-2, 0, 4, 22);
    ctx.fillStyle = "#e8d9b0";
    ctx.fillRect(-30, -16, 60, 16);
    ctx.strokeStyle = "#6b4a30"; ctx.lineWidth = 1.5;
    ctx.strokeRect(-30, -16, 60, 16);
    ctx.fillStyle = "#3a2c1c";
    ctx.font = "8px 'DotGothic16', monospace";
    ctx.textAlign = "center";
    ctx.fillText("TOWN PARK", 0, -6);
    ctx.restore();
  }
}

/* =====================================================================================
   12. Game — 状態管理とメインループ
   ===================================================================================== */
class Game {
  constructor() {
    this.canvas = document.getElementById("game-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;

    this.input = new InputManager(this.canvas);
    this.audio = new AudioManager();
    // 例）this.audio.loadBGM('town', 'assets/bgm/town.mp3');
    // 例）this.audio.loadSE('door', 'assets/se/door.mp3');

    this.world = new World();
    this.collision = new CollisionManager(this.world.buildings);
    this.player = new Player(730, 640);
    this.camera = new Camera(400, 220);
    this.dialog = new Dialog((open) => {
      this.dialogOpen = open;
      if (!open) this.input.justPressedInteract = false; // 閉じた直後の誤発火防止
    });
    this.dialogOpen = false;

    this.state = "loading"; // loading -> title -> playing
    this.introT = 0;
    this.lastTime = performance.now();

    this._resize();
    window.addEventListener("resize", () => this._resize());
    window.addEventListener("orientationchange", () => this._resize());

    this.input.onTap = (ix, iy) => this._handleTap(ix, iy);
    this.canvas.addEventListener("click", (e) => {
      // マウス操作（デスクトップ）：クリック位置をタップ相当として処理
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const ix = (e.clientX - rect.left) * scaleX;
      const iy = (e.clientY - rect.top) * scaleY;
      this._handleTap(ix, iy);
    });

    this._startLoadingSequence();
    requestAnimationFrame((t) => this._loop(t));
  }

  _resize() {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const aspect = cssW / cssH;
    const MIN_W = 200, MAX_W = 560, BASE_H = 220;

    let internalH = BASE_H;
    let internalW = Math.round(internalH * aspect);
    // 幅を範囲内に収めつつ、縦横比を維持したまま高さを再計算する
    // （幅だけをクランプすると、画面比率とビットマップ比率がずれてドット絵が歪んでしまうため）
    if (internalW < MIN_W) { internalW = MIN_W; internalH = Math.round(internalW / aspect); }
    else if (internalW > MAX_W) { internalW = MAX_W; internalH = Math.round(internalW / aspect); }

    this.canvas.width = internalW;
    this.canvas.height = internalH;
    this.camera.resize(internalW, internalH);
    this.ctx.imageSmoothingEnabled = false;

    const isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
    document.getElementById("joystick-zone").classList.toggle("hidden", !isTouch || this.state !== "playing");
  }

  _startLoadingSequence() {
    const fill = document.getElementById("loading-bar-fill");
    const veil = document.getElementById("loading-veil");
    const label = document.getElementById("loading-label");
    let p = 0;
    const steps = ["NOW LOADING...", "STREET DATA...", "NPC AI...", "READY!"];
    const timer = setInterval(() => {
      p += Utils.rand(14, 26);
      fill.style.width = Math.min(100, p) + "%";
      label.textContent = steps[Math.min(steps.length - 1, Math.floor(p / 30))];
      if (p >= 100) {
        clearInterval(timer);
        setTimeout(() => {
          veil.classList.add("fade-out");
          this._enterTitle();
        }, 200);
      }
    }, 140);
  }

  _enterTitle() {
    this.state = "title";
    this.introT = 0;
    document.getElementById("title-overlay").classList.remove("hidden");
  }

  _enterPlaying() {
    if (this.state === "playing") return;
    this.state = "playing";
    document.getElementById("title-overlay").classList.add("hidden");
    document.getElementById("hud-hint").classList.remove("hidden");
    this.camera.setImmediate(this.player.x, this.player.y);
    this._resize();
    this.audio.playBGM("town");
  }

  _handleTap(ix, iy) {
    if (this.state === "title") { this._enterPlaying(); return; }
    if (this.state !== "playing" || this.dialogOpen) return;
    const b = this.world.hitTestDoor(ix, iy, this.camera);
    if (b && b.isPlayerNear(this.player)) {
      this.audio.playSE("door");
      this.dialog.open(b);
    }
  }

  _update(dt) {
    if (this.state === "title") {
      this.introT += dt;
      // タイトルデモ：街をゆっくり横移動しながら見せる
      const span = Math.max(0, WORLD.width - this.camera.viewW);
      const cycle = 14;
      const t = (this.introT % cycle) / cycle;
      const eased = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
      this.camera.x = eased * span;
      this.camera.y = Utils.clamp(560 - this.camera.viewH / 2, 0, WORLD.height - this.camera.viewH);
      this.world.update(dt, { x: -9999, y: -9999 });
      if (this.input.consumeAnyInput()) this._enterPlaying();
      return;
    }

    if (this.state !== "playing") return;

    this.world.update(dt, this.player);

    if (!this.dialogOpen) {
      const moveVec = this.input.getMoveVector();
      this.player.update(dt, moveVec, this.collision);
      this.camera.follow(this.player.x, this.player.y, dt);

      const nearDoor = this.world.findNearestDoor(this.player);
      const hint = document.getElementById("hud-hint-text");
      const mobileHint = document.getElementById("mobile-tap-hint");
      if (nearDoor) {
        hint.textContent = `「${nearDoor.name}」のドアをクリック / タップ`;
        mobileHint.classList.remove("hidden");
      } else {
        hint.textContent = "街を歩いて、行きたい建物のドアに近づこう";
        mobileHint.classList.add("hidden");
      }
      if (this.input.consumeInteract() && nearDoor) {
        this.audio.playSE("door");
        this.dialog.open(nearDoor);
      }
    }
  }

  _draw() {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.world.drawSky(ctx, cam, this.canvas.width, this.canvas.height);
    this.world.drawGround(ctx, cam);
    this.world.drawFountain(ctx, cam);

    // 深度ソートして描画（建物・木・NPC・車・プレイヤー等）
    const drawables = [];
    for (const b of this.world.buildings) drawables.push({ y: b.footY, draw: () => b.draw(ctx, cam) });
    for (const t of this.world.streetTrees) drawables.push({ y: t.y + 4, draw: () => this.world._drawTree(ctx, cam, t.x, t.y) });
    for (const l of this.world.lamps) drawables.push({ y: l.y, draw: () => this.world._drawLamp(ctx, cam, l.x, l.y) });
    for (const p of this.world.poles) drawables.push({ y: p.y, draw: () => this.world._drawPole(ctx, cam, p.x, p.y) });
    for (const bn of this.world.benches) drawables.push({ y: bn.y, draw: () => this.world._drawBench(ctx, cam, bn.x, bn.y) });
    for (const v of this.world.vendingMachines) drawables.push({ y: v.y, draw: () => this.world._drawVending(ctx, cam, v.x, v.y) });
    for (const h of this.world.houses) drawables.push({ y: h.y + h.h, draw: () => this.world._drawHouse(ctx, cam, h) });
    for (const n of this.world.npcs) drawables.push({ y: n.footY, draw: () => n.draw(ctx, cam) });
    for (const v of this.world.vehicles) drawables.push({ y: v.footY, draw: () => v.draw(ctx, cam) });
    drawables.push({ y: LAYOUT.roadV.x0 - 22 + LAYOUT.roadH.y0, draw: () => this.world._drawTrafficLight(ctx, cam, LAYOUT.roadV.x0 - 22, LAYOUT.roadH.y0 - 10) });
    drawables.push({ y: LAYOUT.park.y - 4, draw: () => this.world._drawParkSign(ctx, cam, LAYOUT.park.x + LAYOUT.park.w / 2, LAYOUT.park.y - 4) });
    if (this.state === "playing") drawables.push({ y: this.player.footY, draw: () => this.player.draw(ctx, cam) });

    drawables.sort((a, b) => a.y - b.y);
    for (const d of drawables) d.draw();

    this.world.birds.draw(ctx, cam);

    // 画面全体に薄い夕景ビネット
    const vig = ctx.createRadialGradient(
      this.canvas.width / 2, this.canvas.height / 2, this.canvas.width * 0.2,
      this.canvas.width / 2, this.canvas.height / 2, this.canvas.width * 0.75
    );
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(20,10,30,0.28)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _loop(now) {
    let dt = (now - this.lastTime) / 1000;
    dt = Math.min(dt, 1 / 30);
    this.lastTime = now;
    this._update(dt);
    this._draw();
    requestAnimationFrame((t) => this._loop(t));
  }
}

/* =====================================================================================
   13. 起動
   ===================================================================================== */
window.addEventListener("DOMContentLoaded", () => {
  // アクセシビリティ用フォールバックリンク（スクリーンリーダー / JS無効環境向け）
  // 上部のURL変数と同じ値を使うので、変更はURL変数側だけでOK
  const linkMap = {
    "link-software": softwareURL,
    "link-music": musicURL,
    "link-toy": toyURL,
    "link-podcast": podcastURL,
    "link-game": gameURL,
  };
  for (const [role, url] of Object.entries(linkMap)) {
    const el = document.querySelector(`[data-role="${role}"]`);
    if (el) el.setAttribute("href", url);
  }

  window.__pixelTownGame = new Game();
});
