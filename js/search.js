// Depth-3 negamax + alpha-beta + quiescence for the browser.
// No selective pruning is used: every legal move is searched at each node.

import { MOVE_SRC, MOVE_DST, PIECE_VALUE } from "./engine.js";

export const MATE = 2.0;
const INF = 2.1;
const MATE_THRESHOLD = 1.9;
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const MAX_PLY = 96;
const TT_BITS = 17;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

function storeScore(score, ply) {
  if (score > MATE_THRESHOLD) return score + ply * 0.001;
  if (score < -MATE_THRESHOLD) return score - ply * 0.001;
  return score;
}
function loadScore(score, ply) {
  if (score > MATE_THRESHOLD) return score - ply * 0.001;
  if (score < -MATE_THRESHOLD) return score + ply * 0.001;
  return score;
}

export class Search {
  constructor(mlp) {
    this.mlp = mlp;
    this.ttKey = new Int32Array(TT_SIZE);
    this.ttDepth = new Int8Array(TT_SIZE);
    this.ttFlag = new Int8Array(TT_SIZE);
    this.ttScore = new Float32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE);
    this.ttMove.fill(-1);
    this.killer1 = new Int32Array(MAX_PLY);
    this.killer2 = new Int32Array(MAX_PLY);
    this.history = new Int32Array(2 * 8100);
    this.moveBufs = Array.from({ length: MAX_PLY }, () => new Int32Array(256));
    this.scoreBufs = Array.from({ length: MAX_PLY }, () => new Int32Array(256));
    this.nodes = 0;
  }

  clear() {
    this.ttKey.fill(0);
    this.ttDepth.fill(0);
    this.ttFlag.fill(0);
    this.ttScore.fill(0);
    this.ttMove.fill(-1);
    this.killer1.fill(-1);
    this.killer2.fill(-1);
    this.history.fill(0);
  }

  resetSearch() {
    this.nodes = 0;
    this.killer1.fill(-1);
    this.killer2.fill(-1);
    this.history.fill(0);
  }

  evaluate(board) {
    return this.mlp.evaluate(board);
  }

  // seenPositions: optional Set of exact position keys for the repetition rule.
  search(board, depth = 4, seenPositions = null) {
    const started = performance.now();
    this.resetSearch();
    const buf = this.moveBufs[0];
    let count = board.legalMoves(board.side, false, buf);
    if (count === 0) {
      return { move: null, score: -MATE, depth: 0, nodes: 0, timeMs: 0, completed: 0 };
    }

    let moves = Array.from(buf.subarray(0, count));
    const wasInCheck = board.inCheck(board.side);
    if (seenPositions && seenPositions.size && !wasInCheck) {
      const safe = [];
      for (const code of moves) {
        const src = MOVE_SRC[code], dst = MOVE_DST[code];
        board.make(src, dst, 0);
        if (!seenPositions.has(board.positionKey())) safe.push(code);
        board.unmake(src, dst, 0);
      }
      if (safe.length) moves = safe;
    }

    // Root transposition move gets first priority.
    const rootKey = board.hash | 0;
    let ttMove = -1;
    const tti = rootKey & TT_MASK;
    if (this.ttKey[tti] === rootKey && this.ttDepth[tti] > 0) ttMove = this.ttMove[tti];
    this.orderMoves(board, moves, moves.length, 0, ttMove);

    let bestMove = moves[0];
    let bestScore = -INF;
    let completed = 0;
    let scores = new Array(moves.length).fill(-INF);

    for (let d = 1; d <= depth; d++) {
      let alpha = -INF;
      const beta = INF;
      let iterBest = -INF;
      let iterMove = null;
      for (let i = 0; i < moves.length; i++) {
        const code = moves[i];
        const src = MOVE_SRC[code], dst = MOVE_DST[code];
        board.make(src, dst, 0);
        const score = -this.negamax(board, d - 1, -beta, -alpha, 1);
        board.unmake(src, dst, 0);
        scores[i] = score;
        if (score > iterBest) {
          iterBest = score;
          iterMove = code;
        }
        if (score > alpha) alpha = score;
      }
      completed = d;
      if (iterMove !== null) {
        bestMove = iterMove;
        bestScore = iterBest;
      }
      // Keep the completed iteration's order for the next depth.
      this.sortRoot(moves, scores);
      if (bestScore >= MATE_THRESHOLD) break;
    }

    if (bestMove !== null) {
      this.ttPut(rootKey, completed, storeScore(bestScore, 0), TT_EXACT, bestMove);
    }
    return {
      move: bestMove,
      score: bestScore,
      depth: completed,
      nodes: this.nodes,
      timeMs: performance.now() - started,
      completed,
    };
  }

  sortRoot(moves, scores) {
    for (let i = 1; i < moves.length; i++) {
      const mv = moves[i], sc = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < sc) {
        moves[j + 1] = moves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      moves[j + 1] = mv;
      scores[j + 1] = sc;
    }
  }

  negamax(board, depth, alpha, beta, ply) {
    this.nodes++;
    if (ply >= 64) return this.evaluate(board);
    if (depth <= 0) return this.quiescence(board, alpha, beta, ply, 0);

    const key = board.hash | 0;
    const idx = key & TT_MASK;
    const alpha0 = alpha, beta0 = beta;
    let ttMove = -1;
    if (this.ttKey[idx] === key && this.ttDepth[idx] > 0) {
      const ed = this.ttDepth[idx];
      if (ed >= depth) {
        const cached = loadScore(this.ttScore[idx], ply);
        const flag = this.ttFlag[idx];
        if (flag === TT_EXACT) return cached;
        if (flag === TT_LOWER) {
          if (cached > alpha) alpha = cached;
        } else if (flag === TT_UPPER) {
          if (cached < beta) beta = cached;
        }
        if (alpha >= beta) return cached;
      }
      ttMove = this.ttMove[idx];
    }

    const buf = this.moveBufs[ply];
    const count = board.legalMoves(board.side, false, buf);
    if (count === 0) {
      // Stalemate is also a loss for the side to move in Xiangqi.
      const score = -MATE + ply * 0.001;
      this.ttPut(key, depth, storeScore(score, ply), TT_EXACT, -1);
      return score;
    }

    this.orderMoves(board, buf, count, ply, ttMove);
    let best = -INF;
    let bestMove = -1;
    const sideIdx = board.side === 1 ? 0 : 1;
    for (let i = 0; i < count; i++) {
      const code = buf[i];
      const src = MOVE_SRC[code], dst = MOVE_DST[code];
      const captured = board.flat[dst];
      board.make(src, dst, ply);
      const score = -this.negamax(board, depth - 1, -beta, -alpha, ply + 1);
      board.unmake(src, dst, ply);
      if (score > best) {
        best = score;
        bestMove = code;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (captured === 0) {
          this.history[sideIdx * 8100 + code] += depth * depth;
          if (this.killer1[ply] !== code) {
            this.killer2[ply] = this.killer1[ply];
            this.killer1[ply] = code;
          }
        }
        break;
      }
    }

    if (best <= alpha0) this.ttPut(key, depth, storeScore(best, ply), TT_UPPER, bestMove);
    else if (best >= beta0) this.ttPut(key, depth, storeScore(best, ply), TT_LOWER, bestMove);
    else this.ttPut(key, depth, storeScore(best, ply), TT_EXACT, bestMove);
    return best;
  }

  quiescence(board, alpha, beta, ply, qdepth) {
    this.nodes++;
    if (qdepth >= 6 || ply >= 64) return this.evaluate(board);

    const inCheck = board.inCheck(board.side);
    let stand;
    if (!inCheck) {
      stand = this.evaluate(board);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (qdepth >= 4) return stand;
    } else {
      stand = alpha;
    }

    const buf = this.moveBufs[ply];
    const count = board.legalMoves(board.side, !inCheck, buf);
    if (count === 0) {
      return inCheck ? -MATE + ply * 0.001 : stand;
    }

    // Captures first, by victim value. Check evasions are already a short list.
    const scores = this.scoreBufs[ply];
    for (let i = 0; i < count; i++) {
      const victim = Math.abs(board.flat[MOVE_DST[buf[i]]]);
      scores[i] = victim ? PIECE_VALUE[victim] : 0;
    }
    for (let i = 1; i < count; i++) {
      const mv = buf[i], sc = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < sc) {
        buf[j + 1] = buf[j];
        scores[j + 1] = scores[j];
        j--;
      }
      buf[j + 1] = mv;
      scores[j + 1] = sc;
    }

    let best = inCheck ? -INF : stand;
    for (let i = 0; i < count; i++) {
      const code = buf[i];
      const src = MOVE_SRC[code], dst = MOVE_DST[code];
      board.make(src, dst, ply);
      const score = -this.quiescence(board, -beta, -alpha, ply + 1, qdepth + 1);
      board.unmake(src, dst, ply);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  orderMoves(board, moves, count, ply, ttMove) {
    const scores = this.scoreBufs[ply];
    const sideIdx = board.side === 1 ? 0 : 1;
    const hist = this.history;
    const k1 = this.killer1[ply];
    const k2 = this.killer2[ply];
    for (let i = 0; i < count; i++) {
      const code = moves[i];
      if (code === ttMove) {
        scores[i] = 1000000000;
        continue;
      }
      const victim = Math.abs(board.flat[MOVE_DST[code]]);
      if (victim) {
        scores[i] = 100000 + PIECE_VALUE[victim] * 10;
      } else if (code === k1) {
        scores[i] = 90000;
      } else if (code === k2) {
        scores[i] = 80000;
      } else {
        scores[i] = hist[sideIdx * 8100 + code] + 8 - Math.abs(MOVE_DST[code] % 9 - 4);
      }
    }
    for (let i = 1; i < count; i++) {
      const mv = moves[i], sc = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < sc) {
        moves[j + 1] = moves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      moves[j + 1] = mv;
      scores[j + 1] = sc;
    }
  }

  ttPut(key, depth, score, flag, move) {
    const idx = key & TT_MASK;
    if (this.ttKey[idx] === key && this.ttDepth[idx] > depth) return;
    this.ttKey[idx] = key;
    this.ttDepth[idx] = depth;
    this.ttScore[idx] = score;
    this.ttFlag[idx] = flag;
    this.ttMove[idx] = move;
  }
}
