// ── 狀態 ──
const STORAGE_KEY = "lottery-state";

let state = {
  totalBalls: 0,   // 號碼球總數
  drawCount: 1,    // 每次抽出顆數
  remaining: [],   // 剩餘號碼池
  history: [],     // [{ round, numbers: [..], time }]
};

// ── DOM ──
const $ = (id) => document.getElementById(id);
const setupPanel = $("setup-panel");
const drawPanel = $("draw-panel");
const historyPanel = $("history-panel");
const totalBallsInput = $("total-balls");
const drawCountInput = $("draw-count");
const startBtn = $("start-btn");
const drawBtn = $("draw-btn");
const resetBtn = $("reset-btn");
const clearHistoryBtn = $("clear-history-btn");
const latestDraw = $("latest-draw");
const ballPool = $("ball-pool");
const historyList = $("history-list");
const remainingCount = $("remaining-count");
const drawnCount = $("drawn-count");
const setupError = $("setup-error");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 頁面內提示與二段式確認（內嵌預覽會擋掉 alert/confirm，改用這兩個）──
function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove("hidden");
}

function hideSetupError() {
  setupError.classList.add("hidden");
}

// 第一次按：按鈕變紅要求確認；3 秒內再按一次才執行 onConfirm
function confirmClick(btn, confirmText, onConfirm) {
  if (btn.dataset.confirming === "1") {
    delete btn.dataset.confirming;
    btn.classList.remove("btn-confirming");
    btn.textContent = btn.dataset.originalText;
    clearTimeout(Number(btn.dataset.timer));
    onConfirm();
    return;
  }
  btn.dataset.confirming = "1";
  btn.dataset.originalText = btn.textContent;
  btn.classList.add("btn-confirming");
  btn.textContent = confirmText;
  btn.dataset.timer = setTimeout(() => {
    delete btn.dataset.confirming;
    btn.classList.remove("btn-confirming");
    btn.textContent = btn.dataset.originalText;
  }, 3000);
}

// ══════════════════════════════════════════
//  開球機：canvas 物理模擬
// ══════════════════════════════════════════
const BALL_COLORS = [
  ["#ff9a56", "#e0392b"],
  ["#5b8def", "#2d55b0"],
  ["#5fd08a", "#1e8e4e"],
  ["#ffd45e", "#dfa010"],
  ["#b08df0", "#6c3fc5"],
  ["#f58fc4", "#c2377f"],
];

const machine = {
  canvas: $("machine-canvas"),
  ctx: null,
  balls: [],        // { n, x, y, vx, vy, r, color, eject: null | {...} }
  cx: 0, cy: 0, R: 0,
  gateW: 0,         // 出球口寬度
  agitation: 0,     // 0 = 靜置微動，1 = 抽獎攪動
  rafId: null,
  lastT: 0,
  lastRafAt: 0,     // 最近一次 rAF 觸發時間
  worker: null,     // 備援計時器（嵌入式面板會暫停 rAF，Worker 計時不受影響）

  init() {
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", () => this.resize());
  },

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 420;
    const h = w * 1.1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w;
    this.H = h;
    this.cx = w / 2;
    this.R = w * 0.42;
    this.cy = this.R + w * 0.03;
    this.gateW = Math.max(26, w * 0.09);
    // 把既有球夾回球體內
    for (const b of this.balls) this.clampInside(b);
  },

  ballRadius(count) {
    const r = this.R * Math.sqrt(0.5 / Math.max(count, 1)) * 0.9;
    return Math.min(16, Math.max(5, r));
  },

  setBalls(numbers) {
    const r = this.ballRadius(numbers.length);
    this.balls = numbers.map((n) => {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * (this.R - r - 4);
      return {
        n,
        x: this.cx + Math.cos(a) * d,
        y: this.cy + Math.sin(a) * d,
        vx: (Math.random() - 0.5) * 40,
        vy: (Math.random() - 0.5) * 40,
        r,
        color: BALL_COLORS[n % BALL_COLORS.length],
        eject: null,
      };
    });
  },

  clampInside(b) {
    const dx = b.x - this.cx;
    const dy = b.y - this.cy;
    const d = Math.hypot(dx, dy);
    const max = this.R - b.r - 2;
    if (d > max) {
      b.x = this.cx + (dx / d) * max;
      b.y = this.cy + (dy / d) * max;
    }
  },

  setAgitation(level) {
    this.agitation = level;
  },

  // 抽出號碼 n 的球：滾向底部出球口 → 掉出畫面
  // 分頁隱藏時 rAF 會暫停，因此加上定時保底，時間到直接完成，動畫純屬視覺
  eject(n) {
    return new Promise((resolve) => {
      const b = this.balls.find((x) => x.n === n);
      if (!b) { resolve(); return; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const i = this.balls.indexOf(b);
        if (i !== -1) this.balls.splice(i, 1);
        resolve();
      };
      b.eject = {
        phase: "toGate",
        t: 0,
        fromX: b.x, fromY: b.y,
        finish,
      };
      setTimeout(finish, 1200);
    });
  },

  tick(source) {
    const now = performance.now();
    // rAF 正常運作時忽略 Worker 的 tick，避免雙重驅動
    if (source === "worker" && now - this.lastRafAt < 120) return;
    const dt = Math.min((now - this.lastT) / 1000, 0.05);
    this.lastT = now;
    this.step(dt);
    this.render();
  },

  start() {
    if (this.rafId) return;
    this.lastT = performance.now();
    const loop = (t) => {
      this.lastRafAt = t;
      this.tick("raf");
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);

    if (!this.worker) {
      const src = "setInterval(() => postMessage(0), 16);";
      this.worker = new Worker(
        URL.createObjectURL(new Blob([src], { type: "text/javascript" }))
      );
      this.worker.onmessage = () => this.tick("worker");
    }
  },

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  },

  step(dt) {
    const G = 620;                       // 重力 px/s²
    const gateX = this.cx;
    const gateY = this.cy + this.R;

    for (const b of this.balls) {
      // 出球動畫：接管位置
      if (b.eject) {
        const e = b.eject;
        e.t += dt;
        if (e.phase === "toGate") {
          const k = Math.min(e.t / 0.4, 1);
          const ease = 1 - Math.pow(1 - k, 3);
          b.x = e.fromX + (gateX - e.fromX) * ease;
          b.y = e.fromY + (gateY - b.r - e.fromY) * ease;
          if (k >= 1) { e.phase = "drop"; e.t = 0; }
        } else if (e.phase === "drop") {
          b.y += 520 * dt;
          if (b.y > this.H + b.r) e.finish();
        }
        continue;
      }

      // 重力 + 底部氣流（攪動時強、靜置時弱）
      b.vy += G * dt;
      const air = this.agitation > 0 ? 1 : 0.12;
      const nearBottom = b.y > this.cy + this.R * 0.35;
      if (nearBottom && Math.random() < 0.5 * air) {
        b.vy -= (300 + Math.random() * 500) * air * dt * 8;
        b.vx += (Math.random() - 0.5) * 600 * air * dt * 8;
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // 球體內壁碰撞
      const dx = b.x - this.cx;
      const dy = b.y - this.cy;
      const d = Math.hypot(dx, dy) || 0.001;
      const max = this.R - b.r - 2;
      if (d > max) {
        const nx = dx / d, ny = dy / d;
        b.x = this.cx + nx * max;
        b.y = this.cy + ny * max;
        const dot = b.vx * nx + b.vy * ny;
        b.vx -= 1.75 * dot * nx;
        b.vy -= 1.75 * dot * ny;
        b.vx *= 0.96;
        b.vy *= 0.96;
      }
    }

    // 球與球碰撞（球太多時跳過，避免 O(n²) 拖慢）
    if (this.balls.length <= 120) {
      for (let i = 0; i < this.balls.length; i++) {
        const a = this.balls[i];
        if (a.eject) continue;
        for (let j = i + 1; j < this.balls.length; j++) {
          const c = this.balls[j];
          if (c.eject) continue;
          const dx = c.x - a.x, dy = c.y - a.y;
          const d = Math.hypot(dx, dy) || 0.001;
          const min = a.r + c.r;
          if (d < min) {
            const nx = dx / d, ny = dy / d;
            const push = (min - d) / 2;
            a.x -= nx * push; a.y -= ny * push;
            c.x += nx * push; c.y += ny * push;
            const dvn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
            if (dvn < 0) {
              a.vx += dvn * nx * 0.9; a.vy += dvn * ny * 0.9;
              c.vx -= dvn * nx * 0.9; c.vy -= dvn * ny * 0.9;
            }
          }
        }
      }
    }
  },

  render() {
    const { ctx, cx, cy, R, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    // 出球管
    const tubeW = this.gateW;
    ctx.fillStyle = "rgba(90, 46, 166, 0.12)";
    ctx.fillRect(cx - tubeW / 2, cy + R - 6, tubeW, H - (cy + R) + 6);
    ctx.strokeStyle = "rgba(90, 46, 166, 0.35)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - tubeW / 2, cy + R - 4);
    ctx.lineTo(cx - tubeW / 2, H);
    ctx.moveTo(cx + tubeW / 2, cy + R - 4);
    ctx.lineTo(cx + tubeW / 2, H);
    ctx.stroke();

    // 玻璃球體
    const glass = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    glass.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    glass.addColorStop(0.6, "rgba(230, 235, 255, 0.18)");
    glass.addColorStop(1, "rgba(150, 160, 220, 0.15)");
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // 球（裁切在球體 + 出球管範圍內）
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.rect(cx - tubeW / 2, cy + R - 8, tubeW, H - (cy + R) + 8);
    ctx.clip();
    for (const b of this.balls) this.renderBall(b);
    ctx.restore();

    // 玻璃邊框（留出球口缺口）
    const gateHalf = Math.asin(this.gateW / 2 / R);
    ctx.strokeStyle = "#5a2ea6";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.PI / 2 + gateHalf, Math.PI / 2 - gateHalf + Math.PI * 2);
    ctx.stroke();

    // 高光
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 10, Math.PI * 1.15, Math.PI * 1.45);
    ctx.stroke();
  },

  renderBall(b) {
    const { ctx } = this;
    const grad = ctx.createRadialGradient(
      b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.15,
      b.x, b.y, b.r
    );
    grad.addColorStop(0, b.color[0]);
    grad.addColorStop(1, b.color[1]);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    if (b.r >= 8) {
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${Math.round(b.r * 0.95)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.n, b.x, b.y + 0.5);
    }
  },
};

// ── 初始化 ──
function init() {
  machine.init();
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      state = JSON.parse(saved);
      if (state.totalBalls > 0) {
        totalBallsInput.value = state.totalBalls;
        drawCountInput.value = state.drawCount;
        showDrawView();
        return;
      }
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── 開始抽獎 ──
startBtn.addEventListener("click", () => {
  const total = parseInt(totalBallsInput.value, 10);
  const count = parseInt(drawCountInput.value, 10);

  if (!Number.isInteger(total) || total < 1) {
    showSetupError("請輸入有效的號碼球總數（至少 1 顆）");
    return;
  }
  if (!Number.isInteger(count) || count < 1) {
    showSetupError("請輸入有效的每次抽出顆數（至少 1 顆）");
    return;
  }
  if (count > total) {
    showSetupError("每次抽出顆數不能大於號碼球總數");
    return;
  }
  hideSetupError();

  state.totalBalls = total;
  state.drawCount = count;
  state.remaining = Array.from({ length: total }, (_, i) => i + 1);
  state.history = [];
  save();
  showDrawView();
});

// ── 抽球（含攪動與出球動畫）──
let animating = false;

drawBtn.addEventListener("click", async () => {
  if (animating) return;
  const count = Math.min(state.drawCount, state.remaining.length);
  if (count === 0) return;

  animating = true;
  drawBtn.disabled = true;
  drawBtn.textContent = "攪動中…";
  latestDraw.innerHTML = "";

  machine.setAgitation(1);
  await wait(1400);

  const numbers = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * state.remaining.length);
    const n = state.remaining.splice(idx, 1)[0];
    numbers.push(n);
    save();
    drawBtn.textContent = `出球中… (${i + 1}/${count})`;
    await machine.eject(n);
    appendBigBall(n);
    if (i < count - 1) await wait(350);
  }

  machine.setAgitation(0);
  state.history.push({
    round: state.history.length + 1,
    numbers,
    time: new Date().toLocaleTimeString("zh-TW", { hour12: false }),
  });
  save();

  renderPool();
  renderHistory();
  updateStatus();
  animating = false;
});

// ── 重新開始（按第一下變紅確認，再按一下才執行）──
resetBtn.addEventListener("click", () => {
  if (animating) return;
  confirmClick(resetBtn, "再按一次確認重置", () => {
    localStorage.removeItem(STORAGE_KEY);
    state = { totalBalls: 0, drawCount: 1, remaining: [], history: [] };
    hideSetupError();
    machine.stop();
    drawPanel.classList.add("hidden");
    historyPanel.classList.add("hidden");
    setupPanel.classList.remove("hidden");
  });
});

// ── 清除記錄（保留抽獎進度）──
clearHistoryBtn.addEventListener("click", () => {
  confirmClick(clearHistoryBtn, "再按一次確認", () => {
    state.history = [];
    save();
    renderHistory();
  });
});

// ── 畫面切換與渲染 ──
function showDrawView() {
  setupPanel.classList.add("hidden");
  drawPanel.classList.remove("hidden");
  historyPanel.classList.remove("hidden");

  machine.resize();
  machine.setBalls(state.remaining);
  machine.start();

  const last = state.history[state.history.length - 1];
  renderLatest(last ? last.numbers : null);
  renderPool();
  renderHistory();
  updateStatus();
}

function appendBigBall(n) {
  const ball = document.createElement("div");
  ball.className = "big-ball";
  ball.textContent = n;
  latestDraw.appendChild(ball);
}

function renderLatest(numbers) {
  latestDraw.innerHTML = "";
  if (!numbers || numbers.length === 0) {
    const p = document.createElement("span");
    p.className = "placeholder";
    p.textContent = "按下「抽球！」開始抽出號碼";
    latestDraw.appendChild(p);
    return;
  }
  for (const n of numbers) appendBigBall(n);
}

function renderPool() {
  ballPool.innerHTML = "";
  const remainingSet = new Set(state.remaining);
  for (let n = 1; n <= state.totalBalls; n++) {
    const ball = document.createElement("div");
    ball.className = "small-ball" + (remainingSet.has(n) ? "" : " drawn");
    ball.textContent = n;
    ballPool.appendChild(ball);
  }
}

function renderHistory() {
  historyList.innerHTML = "";
  // 最新的排最上面
  for (const record of [...state.history].reverse()) {
    const li = document.createElement("li");

    const left = document.createElement("span");
    const round = document.createElement("span");
    round.className = "history-round";
    round.textContent = `第 ${record.round} 輪`;
    const nums = document.createElement("span");
    nums.className = "history-numbers";
    nums.textContent = record.numbers.join("、");
    left.appendChild(round);
    left.appendChild(nums);

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = record.time;

    li.appendChild(left);
    li.appendChild(time);
    historyList.appendChild(li);
  }
}

function updateStatus() {
  remainingCount.textContent = state.remaining.length;
  drawnCount.textContent = state.totalBalls - state.remaining.length;

  if (state.remaining.length === 0) {
    drawBtn.disabled = true;
    drawBtn.textContent = "已全部抽完 🎉";
  } else {
    drawBtn.disabled = false;
    const next = Math.min(state.drawCount, state.remaining.length);
    drawBtn.textContent = `抽球！（抽 ${next} 顆）`;
  }
}

init();
