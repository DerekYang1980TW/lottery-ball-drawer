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

// ── 初始化 ──
function init() {
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

// ── 抽球 ──
drawBtn.addEventListener("click", () => {
  const count = Math.min(state.drawCount, state.remaining.length);
  if (count === 0) return;

  const numbers = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * state.remaining.length);
    numbers.push(state.remaining.splice(idx, 1)[0]);
  }

  state.history.push({
    round: state.history.length + 1,
    numbers,
    time: new Date().toLocaleTimeString("zh-TW", { hour12: false }),
  });
  save();

  renderLatest(numbers);
  renderPool();
  renderHistory();
  updateStatus();
});

// ── 重新開始（按第一下變紅確認，再按一下才執行）──
resetBtn.addEventListener("click", () => {
  confirmClick(resetBtn, "再按一次確認重置", () => {
    localStorage.removeItem(STORAGE_KEY);
    state = { totalBalls: 0, drawCount: 1, remaining: [], history: [] };
    hideSetupError();
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

  const last = state.history[state.history.length - 1];
  renderLatest(last ? last.numbers : null);
  renderPool();
  renderHistory();
  updateStatus();
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
  for (const n of numbers) {
    const ball = document.createElement("div");
    ball.className = "big-ball";
    ball.textContent = n;
    latestDraw.appendChild(ball);
  }
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
