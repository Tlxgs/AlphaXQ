// Xiangqi rules and a fast mutable board for the browser engine.
// Piece codes: +1..+7 red king/rook/knight/bishop/advisor/cannon/pawn,
// -1..-7 the same black pieces.

export const RED = 1;
export const BLACK = -1;
export const KING = 1;
export const ROOK = 2;
export const KNIGHT = 3;
export const BISHOP = 4;
export const ADVISOR = 5;
export const CANNON = 6;
export const PAWN = 7;

export const PIECE_VALUE = [0, 10000, 500, 300, 120, 120, 285, 55];
export const PIECE_CHAR = {
  1: "帅", 2: "车", 3: "马", 4: "相", 5: "仕", 6: "炮", 7: "兵",
  "-1": "将", "-2": "车", "-3": "马", "-4": "象", "-5": "士", "-6": "炮", "-7": "卒",
};

const START = new Int8Array(90);
function putStart(sq, piece) { START[sq] = piece; }
// Black at the top, red at the bottom.
[ROOK, KNIGHT, BISHOP, ADVISOR, KING, ADVISOR, BISHOP, KNIGHT, ROOK].forEach((p, c) => putStart(c, -p));
putStart(2 * 9 + 1, -CANNON); putStart(2 * 9 + 7, -CANNON);
for (let c = 0; c < 9; c += 2) putStart(3 * 9 + c, -PAWN);
[ROOK, KNIGHT, BISHOP, ADVISOR, KING, ADVISOR, BISHOP, KNIGHT, ROOK].forEach((p, c) => putStart(9 * 9 + c, p));
putStart(7 * 9 + 1, CANNON); putStart(7 * 9 + 7, CANNON);
for (let c = 0; c < 9; c += 2) putStart(6 * 9 + c, PAWN);

// 8100 encoded moves (src * 90 + dst) -> coordinates.
export const MOVE_SRC = new Int16Array(8100);
export const MOVE_DST = new Int16Array(8100);
for (let code = 0; code < 8100; code++) {
  MOVE_SRC[code] = (code / 90) | 0;
  MOVE_DST[code] = code % 90;
}

// Zobrist keys: 15 piece slots (piece + 7) times 90 squares, plus side.
const ZOBRIST = new Int32Array(15 * 90);
let zseed = 0x9e3779b9;
function zrand() {
  zseed ^= zseed << 13;
  zseed ^= zseed >>> 17;
  zseed ^= zseed << 5;
  return zseed | 0;
}
for (let i = 0; i < ZOBRIST.length; i++) ZOBRIST[i] = zrand();
const Z_SIDE = zrand() || 1;

const MAX_STACK = 96;

export class Board {
  constructor() {
    this.flat = new Int8Array(90);
    this.side = RED;
    this.kingRed = -1;
    this.kingBlack = -1;
    this.hash = 0;
    this.undoCaptured = new Int8Array(MAX_STACK);
    this.undoHash = new Int32Array(MAX_STACK);
    this.undoKingR = new Int16Array(MAX_STACK);
    this.undoKingB = new Int16Array(MAX_STACK);
    this.setStart();
  }

  setStart() {
    this.flat.set(START);
    this.side = RED;
    this._locateKings();
    this._recomputeHash();
  }

  loadFlat(flat, side = RED) {
    this.flat.set(flat);
    this.side = side === BLACK ? BLACK : RED;
    this._locateKings();
    this._recomputeHash();
  }

  clone() {
    const b = new Board();
    b.loadFlat(this.flat, this.side);
    return b;
  }

  _locateKings() {
    this.kingRed = -1;
    this.kingBlack = -1;
    for (let i = 0; i < 90; i++) {
      if (this.flat[i] === KING) this.kingRed = i;
      else if (this.flat[i] === -KING) this.kingBlack = i;
    }
  }

  _recomputeHash() {
    let h = this.side === RED ? Z_SIDE : 0;
    const f = this.flat;
    for (let i = 0; i < 90; i++) {
      const p = f[i];
      if (p) h ^= ZOBRIST[(p + 7) * 90 + i];
    }
    this.hash = h | 0;
  }

  kingSquare(side) {
    return side === RED ? this.kingRed : this.kingBlack;
  }

  pieceAt(sq) {
    return this.flat[sq];
  }

  // Make a move and save enough state to unmake it. ply is 0..MAX_STACK-1.
  make(src, dst, ply = 0) {
    const f = this.flat;
    const piece = f[src];
    const captured = f[dst];
    const u = ply | 0;
    this.undoCaptured[u] = captured;
    this.undoHash[u] = this.hash;
    this.undoKingR[u] = this.kingRed;
    this.undoKingB[u] = this.kingBlack;

    let h = this.hash;
    h ^= ZOBRIST[(piece + 7) * 90 + src];
    h ^= ZOBRIST[(piece + 7) * 90 + dst];
    if (captured) h ^= ZOBRIST[(captured + 7) * 90 + dst];
    h ^= Z_SIDE;
    this.hash = h | 0;

    f[src] = 0;
    f[dst] = piece;
    if (piece === KING) this.kingRed = dst;
    else if (piece === -KING) this.kingBlack = dst;
    this.side = -this.side;
    return captured;
  }

  unmake(src, dst, ply = 0) {
    const f = this.flat;
    const piece = f[dst];
    const u = ply | 0;
    f[src] = piece;
    f[dst] = this.undoCaptured[u];
    this.kingRed = this.undoKingR[u];
    this.kingBlack = this.undoKingB[u];
    this.hash = this.undoHash[u];
    this.side = -this.side;
  }

  // Exact game-position key for the repetition rule.
  positionKey() {
    let s = "";
    for (let i = 0; i < 90; i++) s += String.fromCharCode(this.flat[i] + 8);
    return s + (this.side === RED ? "r" : "b");
  }

  inCheck(side = this.side) {
    const sq = side === RED ? this.kingRed : this.kingBlack;
    if (sq < 0) return true;
    return this.isAttacked(sq, -side);
  }

  // Is square sq attacked by side opp? Includes flying-general and cannons.
  isAttacked(sq, opp) {
    const f = this.flat;
    const kr = (sq / 9) | 0;
    const kc = sq % 9;

    // Rook / flying general / adjacent king.
    for (let d = 0; d < 4; d++) {
      const dr = d === 0 ? -1 : d === 1 ? 1 : 0;
      const dc = d === 2 ? -1 : d === 3 ? 1 : 0;
      let r = kr + dr, c = kc + dc;
      while (r >= 0 && r < 10 && c >= 0 && c < 9) {
        const p = f[r * 9 + c];
        if (p !== 0) {
          if (p === opp * ROOK) return true;
          if (p === opp * KING) {
            if (dc === 0) return true;
            if (Math.abs(r - kr) + Math.abs(c - kc) === 1) return true;
          }
          break;
        }
        r += dr; c += dc;
      }
    }

    // Cannon: exactly one screen, then an enemy cannon.
    for (let d = 0; d < 4; d++) {
      const dr = d === 0 ? -1 : d === 1 ? 1 : 0;
      const dc = d === 2 ? -1 : d === 3 ? 1 : 0;
      let r = kr + dr, c = kc + dc;
      let screen = false;
      while (r >= 0 && r < 10 && c >= 0 && c < 9) {
        const p = f[r * 9 + c];
        if (p !== 0) {
          if (!screen) screen = true;
          else {
            if (p === opp * CANNON) return true;
            break;
          }
        }
        r += dr; c += dc;
      }
    }

    // Horse, blocked by the leg square.
    const H = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (let i = 0; i < 8; i++) {
      const hr = kr + H[i][0], hc = kc + H[i][1];
      if (hr < 0 || hr >= 10 || hc < 0 || hc >= 9) continue;
      if (f[hr * 9 + hc] !== opp * KNIGHT) continue;
      let lr, lc;
      if (Math.abs(kr - hr) === 2) { lr = hr + ((kr - hr) >> 1); lc = hc; }
      else { lr = hr; lc = hc + ((kc - hc) >> 1); }
      if (f[lr * 9 + lc] === 0) return true;
    }

    // Pawn attacks: forward always, sideways after crossing the river.
    if (opp === RED) {
      if (kr + 1 < 10 && f[(kr + 1) * 9 + kc] === PAWN) return true;
      if (kr <= 4) {
        if (kc > 0 && f[kr * 9 + kc - 1] === PAWN) return true;
        if (kc < 8 && f[kr * 9 + kc + 1] === PAWN) return true;
      }
    } else {
      if (kr - 1 >= 0 && f[(kr - 1) * 9 + kc] === -PAWN) return true;
      if (kr >= 5) {
        if (kc > 0 && f[kr * 9 + kc - 1] === -PAWN) return true;
        if (kc < 8 && f[kr * 9 + kc + 1] === -PAWN) return true;
      }
    }
    return false;
  }

  // Generate pseudo-legal moves into out, filter by king safety in place.
  legalMoves(side = this.side, capturesOnly = false, out) {
    const f = this.flat;
    const own = side;
    const enemyKing = -side * KING;
    const ownKing = side === RED ? this.kingRed : this.kingBlack;
    let n = 0;

    const push = (src, dst, q) => {
      if (capturesOnly && q === 0) return;
      out[n++] = src * 90 + dst;
    };

    for (let idx = 0; idx < 90; idx++) {
      const p = f[idx];
      if (p === 0 || (p > 0 ? 1 : -1) !== side) continue;
      const kind = p > 0 ? p : -p;
      const r = (idx / 9) | 0;
      const c = idx % 9;

      if (kind === KING) {
        for (let d = 0; d < 4; d++) {
          const nr = r + (d === 0 ? -1 : d === 1 ? 1 : 0);
          const nc = c + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (nr < 0 || nr >= 10 || nc < 0 || nc >= 9) continue;
          if (side === RED ? (nr < 7 || nr > 9) : (nr < 0 || nr > 2)) continue;
          if (nc < 3 || nc > 5) continue;
          const t = nr * 9 + nc;
          const q = f[t];
          if (q * side > 0 || q === enemyKing) continue;
          push(idx, t, q);
        }
      } else if (kind === ADVISOR) {
        for (let d = 0; d < 4; d++) {
          const nr = r + (d < 2 ? -1 : 1);
          const nc = c + (d % 2 === 0 ? -1 : 1);
          if (nr < 0 || nr >= 10 || nc < 0 || nc >= 9) continue;
          if (side === RED ? (nr < 7 || nr > 9) : (nr < 0 || nr > 2)) continue;
          if (nc < 3 || nc > 5) continue;
          const t = nr * 9 + nc;
          const q = f[t];
          if (q * side > 0 || q === enemyKing) continue;
          push(idx, t, q);
        }
      } else if (kind === BISHOP) {
        for (let d = 0; d < 4; d++) {
          const dr = d < 2 ? -2 : 2;
          const dc = d % 2 === 0 ? -2 : 2;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= 10 || nc < 0 || nc >= 9) continue;
          if (side === RED ? nr < 5 : nr > 4) continue;
          if (f[(r + (dr >> 1)) * 9 + (c + (dc >> 1))] !== 0) continue;
          const t = nr * 9 + nc;
          const q = f[t];
          if (q * side > 0 || q === enemyKing) continue;
          push(idx, t, q);
        }
      } else if (kind === KNIGHT) {
        const H = [[-2, -1, -1, 0], [-2, 1, -1, 0], [-1, -2, 0, -1], [-1, 2, 0, 1],
          [1, -2, 0, -1], [1, 2, 0, 1], [2, -1, 1, 0], [2, 1, 1, 0]];
        for (let i = 0; i < 8; i++) {
          const nr = r + H[i][0], nc = c + H[i][1];
          if (nr < 0 || nr >= 10 || nc < 0 || nc >= 9) continue;
          if (f[(r + H[i][2]) * 9 + (c + H[i][3])] !== 0) continue;
          const t = nr * 9 + nc;
          const q = f[t];
          if (q * side > 0 || q === enemyKing) continue;
          push(idx, t, q);
        }
      } else if (kind === ROOK) {
        for (let d = 0; d < 4; d++) {
          const dr = d === 0 ? -1 : d === 1 ? 1 : 0;
          const dc = d === 2 ? -1 : d === 3 ? 1 : 0;
          let nr = r + dr, nc = c + dc;
          while (nr >= 0 && nr < 10 && nc >= 0 && nc < 9) {
            const t = nr * 9 + nc;
            const q = f[t];
            if (q === 0) {
              if (!capturesOnly) out[n++] = idx * 90 + t;
            } else {
              if (q * side < 0 && q !== enemyKing) out[n++] = idx * 90 + t;
              break;
            }
            nr += dr; nc += dc;
          }
        }
      } else if (kind === CANNON) {
        for (let d = 0; d < 4; d++) {
          const dr = d === 0 ? -1 : d === 1 ? 1 : 0;
          const dc = d === 2 ? -1 : d === 3 ? 1 : 0;
          let nr = r + dr, nc = c + dc;
          let screen = false;
          while (nr >= 0 && nr < 10 && nc >= 0 && nc < 9) {
            const t = nr * 9 + nc;
            const q = f[t];
            if (!screen) {
              if (q === 0) {
                if (!capturesOnly) out[n++] = idx * 90 + t;
              } else {
                screen = true;
              }
            } else if (q !== 0) {
              if (q * side < 0 && q !== enemyKing) out[n++] = idx * 90 + t;
              break;
            }
            nr += dr; nc += dc;
          }
        }
      } else if (kind === PAWN) {
        const forward = side === RED ? r - 1 : r + 1;
        if (forward >= 0 && forward < 10) {
          const t = forward * 9 + c;
          const q = f[t];
          if (q * side <= 0 && q !== enemyKing) push(idx, t, q);
        }
        const crossed = side === RED ? r <= 4 : r >= 5;
        if (crossed) {
          for (let dc = -1; dc <= 1; dc += 2) {
            const nc = c + dc;
            if (nc < 0 || nc >= 9) continue;
            const t = r * 9 + nc;
            const q = f[t];
            if (q * side <= 0 && q !== enemyKing) push(idx, t, q);
          }
        }
      }
    }

    // Keep only moves that leave our own king safe. A move that captures the
    // enemy king is never generated, so one king always remains on the board.
    let legal = 0;
    for (let k = 0; k < n; k++) {
      const code = out[k];
      const src = (code / 90) | 0;
      const dst = code % 90;
      const piece = f[src];
      const captured = f[dst];
      f[src] = 0;
      f[dst] = piece;
      const king = piece === side * KING ? dst : ownKing;
      if (!this.isAttacked(king, -side)) out[legal++] = code;
      f[dst] = captured;
      f[src] = piece;
    }
    return legal;
  }

  // Convenience for the human UI: legal moves from one square.
  movesFrom(sq) {
    const buf = new Int32Array(256);
    const n = this.legalMoves(this.side, false, buf);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (MOVE_SRC[buf[i]] === sq) out.push(buf[i]);
    }
    return out;
  }

  findKingSide(side) {
    return side === RED ? this.kingRed : this.kingBlack;
  }
}

export function moveCode(src, dst) { return src * 90 + dst; }
export function moveSrc(code) { return MOVE_SRC[code]; }
export function moveDst(code) { return MOVE_DST[code]; }
export function squareName(sq) { return "abcdefghi"[sq % 9] + (10 - ((sq / 9) | 0)); }
