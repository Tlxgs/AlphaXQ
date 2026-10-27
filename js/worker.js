// Search worker: keeps the model and transposition table warm.
import { loadMLP } from "./mlp.js";
import { Board, moveSrc, moveDst } from "./engine.js";
import { Search } from "./search.js";

const SEARCH_DEPTH = 4; // change to 3 or 5 here if needed

let mlp = null;
let search = null;

async function init() {
  try {
    mlp = await loadMLP();
    search = new Search(mlp);
    const meta = mlp.meta;
    self.postMessage({
      type: "ready",
      epoch: meta.epoch,
      valMse: meta.valMse,
      checkpoint: meta.checkpoint,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "search") {
    if (!search) {
      self.postMessage({ type: "error", message: "模型尚未加载" });
      return;
    }
    try {
      const board = new Board();
      board.loadFlat(msg.flat, msg.side);
      const seen = msg.seen ? new Set(msg.seen) : null;
      const started = performance.now();
      const result = search.search(board, SEARCH_DEPTH, seen);
      const move = result.move === null ? null : [moveSrc(result.move), moveDst(result.move)];
      self.postMessage({
        type: "result",
        requestId: msg.requestId,
        move,
        score: result.score,
        depth: result.depth,
        nodes: result.nodes,
        timeMs: performance.now() - started,
      });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  } else if (msg.type === "newgame") {
    if (search) search.clear();
    self.postMessage({ type: "newgame-ok" });
  }
};

init();
