// Human (red) vs the compact MLP at fixed depth 4.
import {
  Board, RED, PIECE_CHAR, MOVE_DST, moveDst, squareName,
} from "./engine.js";

const HUMAN = RED;
const W = 620;
const H = 684;
const PAD = 54;
const CELL = 64;
const PIECE_R = 27;

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const newBtn = document.getElementById("new-game");
const undoBtn = document.getElementById("undo");

const board = new Board();
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let ready = false;
let loadError = false;
let thinking = false;
let gameOver = false;
let gameOverText = "";
let selected = -1;
let validMoves = [];
let lastMove = null;
let states = [];
let seen = new Set();
let requestId = 0;
let flashToken = 0;
let dpr = 1;
const checkBuf = new Int32Array(256);

const xOf = (c) => PAD + c * CELL;
const yOf = (r) => PAD + r * CELL;

function setupCanvas() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function makeState(last) {
  return {
    flat: board.flat.slice(),
    side: board.side,
    key: board.positionKey(),
    lastMove: last,
  };
}

function resetHistory() {
  states = [makeState(null)];
  seen = new Set([states[0].key]);
}

function newGame() {
  requestId++;
  thinking = false;
  gameOver = false;
  gameOverText = "";
  selected = -1;
  validMoves = [];
  lastMove = null;
  board.setStart();
  resetHistory();
  if (ready) worker.postMessage({ type: "newgame" });
  render();
  updateStatus();
}

function restoreState(st) {
  board.loadFlat(st.flat, st.side);
  lastMove = st.lastMove;
  selected = -1;
  validMoves = [];
  gameOver = false;
  gameOverText = "";
}

function undo() {
  if (thinking || states.length <= 1) return;
  requestId++;
  states.pop();
  // Return to the previous human turn: drop the AI reply and our last move.
  while (states.length > 1 && states[states.length - 1].side !== HUMAN) states.pop();
  const st = states[states.length - 1];
  restoreState(st);
  seen = new Set(states.map((s) => s.key));
  render();
  updateStatus();
}

function updateStatus() {
  flashToken++;
  let text = "";
  let cls = "status";
  if (loadError) {
    text = "加载失败";
    cls += " error";
  } else if (!ready) {
    text = "加载中…";
  } else if (gameOver) {
    text = gameOverText;
    cls += " over";
  } else if (thinking) {
    text = (board.side === RED ? "红方" : "黑方") + "思考中…";
    cls += " thinking";
  } else {
    const side = board.side === RED ? "红方" : "黑方";
    text = board.inCheck(board.side) ? side + "被将军" : side + "走棋";
  }
  statusEl.className = cls;
  statusEl.textContent = text;
  undoBtn.disabled = !ready || thinking || states.length <= 1;
}

function flash(text, ms = 1400) {
  const token = ++flashToken;
  statusEl.className = "status";
  statusEl.textContent = text;
  window.setTimeout(() => {
    if (token === flashToken) updateStatus();
  }, ms);
}

function checkGameOver() {
  const n = board.legalMoves(board.side, false, checkBuf);
  if (n > 0) return false;
  gameOver = true;
  gameOverText = board.side === RED ? "黑方胜" : "红方胜";
  render();
  updateStatus();
  return true;
}

function startAI() {
  if (!ready || thinking || gameOver || board.side === HUMAN) return;
  thinking = true;
  selected = -1;
  validMoves = [];
  const id = ++requestId;
  updateStatus();
  render();
  worker.postMessage({
    type: "search",
    flat: board.flat,
    side: board.side,
    seen: Array.from(seen),
    requestId: id,
  });
}

function applyAIMove(move) {
  const src = move[0];
  const dst = move[1];
  const wasInCheck = board.inCheck(board.side);
  board.make(src, dst, 0);
  const key = board.positionKey();
  if (seen.has(key) && !wasInCheck) {
    // A non-checked side may not recreate an earlier position; it loses.
    board.unmake(src, dst, 0);
    gameOver = true;
    gameOverText = board.side === RED ? "黑方胜" : "红方胜";
    render();
    updateStatus();
    return;
  }
  seen.add(key);
  lastMove = src * 90 + dst;
  states.push(makeState(lastMove));
  render();
  updateStatus();
  checkGameOver();
}

function tryHumanMove(code) {
  const src = selected;
  const dst = moveDst(code);
  const wasInCheck = board.inCheck(HUMAN);
  board.make(src, dst, 0);
  const key = board.positionKey();
  if (seen.has(key) && !wasInCheck) {
    board.unmake(src, dst, 0);
    flash("不能重复局面");
    render();
    return;
  }
  seen.add(key);
  lastMove = code;
  selected = -1;
  validMoves = [];
  states.push(makeState(code));
  render();
  updateStatus();
  if (checkGameOver()) return;
  startAI();
}

function handlePointer(ev) {
  ev.preventDefault();
  if (!ready || thinking || gameOver || board.side !== HUMAN) return;
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (W / rect.width);
  const y = (ev.clientY - rect.top) * (H / rect.height);
  const c = Math.round((x - PAD) / CELL);
  const r = Math.round((y - PAD) / CELL);
  if (c < 0 || c > 8 || r < 0 || r > 9) return;
  if (Math.abs(x - xOf(c)) > CELL * 0.58 || Math.abs(y - yOf(r)) > CELL * 0.58) return;
  const sq = r * 9 + c;

  if (selected >= 0) {
    let target = -1;
    for (const mv of validMoves) {
      if (MOVE_DST[mv] === sq) { target = mv; break; }
    }
    if (target >= 0) {
      tryHumanMove(target);
      return;
    }
  }

  const piece = board.flat[sq];
  if (piece > 0 && board.side === RED) {
    selected = sq;
    validMoves = board.movesFrom(sq);
  } else {
    selected = -1;
    validMoves = [];
  }
  render();
}

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBoard() {
  ctx.fillStyle = "#f4f3ee";
  ctx.fillRect(0, 0, W, H);

  // Very quiet paper grain.
  ctx.save();
  ctx.globalAlpha = 0.032;
  ctx.strokeStyle = "#4b4a45";
  ctx.lineWidth = 1;
  for (let y = 8; y < H; y += 13) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + ((y * 7) % 5) - 2);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "#5d5c57";
  ctx.lineWidth = 1.4;

  for (let r = 0; r < 10; r++) {
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(r));
    ctx.lineTo(xOf(8), yOf(r));
    ctx.stroke();
  }

  for (let c = 0; c < 9; c++) {
    if (c === 0 || c === 8) {
      ctx.beginPath();
      ctx.moveTo(xOf(c), yOf(0));
      ctx.lineTo(xOf(c), yOf(9));
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(xOf(c), yOf(0));
      ctx.lineTo(xOf(c), yOf(4));
      ctx.moveTo(xOf(c), yOf(5));
      ctx.lineTo(xOf(c), yOf(9));
      ctx.stroke();
    }
  }

  ctx.lineWidth = 2.2;
  ctx.strokeRect(xOf(0), yOf(0), CELL * 8, CELL * 9);

  // Palaces.
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(xOf(3), yOf(0)); ctx.lineTo(xOf(5), yOf(2));
  ctx.moveTo(xOf(5), yOf(0)); ctx.lineTo(xOf(3), yOf(2));
  ctx.moveTo(xOf(3), yOf(7)); ctx.lineTo(xOf(5), yOf(9));
  ctx.moveTo(xOf(5), yOf(7)); ctx.lineTo(xOf(3), yOf(9));
  ctx.stroke();

  // River.
  ctx.save();
  ctx.fillStyle = "rgba(70, 69, 64, .58)";
  ctx.font = '500 22px "KaiTi", "STKaiti", "SimSun", serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("楚 河", xOf(2), yOf(4.5));
  ctx.fillText("汉 界", xOf(6), yOf(4.5));
  ctx.restore();
}

function drawLastMove() {
  if (lastMove === null) return;
  const src = (lastMove / 90) | 0;
  const dst = lastMove % 90;
  for (const sq of [src, dst]) {
    const cx = xOf(sq % 9);
    const cy = yOf((sq / 9) | 0);
    ctx.beginPath();
    ctx.arc(cx, cy, PIECE_R + 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(31, 31, 29, .055)";
    ctx.fill();
    ctx.strokeStyle = "rgba(31, 31, 29, .22)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function drawPiece(sq, piece) {
  const cx = xOf(sq % 9);
  const cy = yOf((sq / 9) | 0);
  const red = piece > 0;

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, .14)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  ctx.arc(cx, cy, PIECE_R, 0, Math.PI * 2);
  ctx.fillStyle = red ? "#fbfaf6" : "#242422";
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.strokeStyle = red ? "#45443f" : "#101010";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, PIECE_R - 4.2, 0, Math.PI * 2);
  ctx.strokeStyle = red ? "rgba(45, 45, 41, .30)" : "rgba(244, 243, 238, .32)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = red ? "#262623" : "#f4f3ee";
  ctx.font = '700 35px "KaiTi", "STKaiti", "KaiTi_GB2312", "SimSun", serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(PIECE_CHAR[String(piece)], cx, cy + 1.5);
  ctx.restore();
}

function drawSelectionAndTargets() {
  if (selected >= 0) {
    const cx = xOf(selected % 9);
    const cy = yOf((selected / 9) | 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, PIECE_R + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "#1b1b19";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  for (const code of validMoves) {
    const dst = MOVE_DST[code];
    const cx = xOf(dst % 9);
    const cy = yOf((dst / 9) | 0);
    if (board.flat[dst] === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(31, 31, 29, .52)";
      ctx.fill();
      ctx.strokeStyle = "rgba(251, 250, 247, .62)";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, PIECE_R + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(31, 31, 29, .55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawCheck() {
  if (!board.inCheck(board.side)) return;
  const sq = board.kingSquare(board.side);
  if (sq < 0) return;
  const cx = xOf(sq % 9);
  const cy = yOf((sq / 9) | 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, PIECE_R + 7, 0, Math.PI * 2);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 2.2;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.restore();
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawBoard();
  drawLastMove();
  for (let sq = 0; sq < 90; sq++) {
    const piece = board.flat[sq];
    if (piece) drawPiece(sq, piece);
  }
  drawSelectionAndTargets();
  drawCheck();
}

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "ready") {
    ready = true;
    loadError = false;
    updateStatus();
    return;
  }
  if (msg.type === "error") {
    console.error("AI error:", msg.message);
    if (!ready) loadError = true;
    thinking = false;
    updateStatus();
    return;
  }
  if (msg.type !== "result") return;
  if (!thinking || msg.requestId !== requestId) return;
  thinking = false;
  if (!msg.move) {
    checkGameOver();
    updateStatus();
    return;
  }
  applyAIMove(msg.move);
  updateStatus();
};

newBtn.addEventListener("click", newGame);
undoBtn.addEventListener("click", undo);
canvas.addEventListener("pointerdown", handlePointer);
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

setupCanvas();
resetHistory();
render();
updateStatus();

// Useful for local smoke tests; harmless in production.
window.__xiangqi = {
  board,
  newGame,
  undo,
  get ready() { return ready; },
  get thinking() { return thinking; },
  get gameOver() { return gameOver; },
  get states() { return states; },
  get selected() { return selected; },
  squareName,
};
