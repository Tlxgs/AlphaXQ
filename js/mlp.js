// Sparse-input inference for the compact value MLP:
// 693 -> 256 -> 192 -> 96 -> 1, tanh. Weights are little-endian float32.

const W1 = 693 * 256;
const B1 = 256;
const W2 = 192 * 256;
const B2 = 192;
const W3 = 96 * 192;
const B3 = 96;
const W4 = 96;
const B4 = 1;
const FLOATS = W1 + B1 + W2 + B2 + W3 + B3 + W4 + B4;

export class MLP {
  constructor(meta, buffer) {
    if (!meta || meta.format !== 1) throw new Error("bad model metadata");
    if (!buffer || buffer.byteLength !== meta.bytes) {
      throw new Error("model size mismatch: " + (buffer ? buffer.byteLength : 0) +
        " vs " + (meta.bytes || 0));
    }
    const all = new Float32Array(buffer);
    if (all.length !== FLOATS) throw new Error("model float count mismatch");
    let o = 0;
    this.w1t = all.subarray(o, o + W1); o += W1;
    this.b1 = all.subarray(o, o + B1); o += B1;
    this.w2 = all.subarray(o, o + W2); o += W2;
    this.b2 = all.subarray(o, o + B2); o += B2;
    this.w3 = all.subarray(o, o + W3); o += W3;
    this.b3 = all.subarray(o, o + B3); o += B3;
    this.w4 = all.subarray(o, o + W4); o += W4;
    this.b4 = all.subarray(o, o + B4);

    this.h1 = new Float32Array(256);
    this.h2 = new Float32Array(192);
    this.h3 = new Float32Array(96);

    // Feature id -> offset in the transposed first-layer matrix.
    this.featureOffset = new Int32Array(meta.redIndex.length);
    for (let i = 0; i < meta.redIndex.length; i++) {
      const v = meta.redIndex[i];
      this.featureOffset[i] = v < 0 ? -1 : v * 256;
    }
    this.blackOffset = new Int32Array(meta.blackIndex.length);
    for (let i = 0; i < meta.blackIndex.length; i++) {
      const v = meta.blackIndex[i];
      this.blackOffset[i] = v < 0 ? -1 : v * 256;
    }
    this.sideOffset = meta.sideFeature * 256;
    this.redIndex = Int32Array.from(meta.redIndex);
    this.blackIndex = Int32Array.from(meta.blackIndex);
    this.meta = meta;
  }

  // Value from the side-to-move perspective, in [-1, 1].
  evaluate(board) {
    const f = board.flat;
    const h1 = this.h1;
    const h2 = this.h2;
    const h3 = this.h3;
    const w1t = this.w1t;

    h1.set(this.b1);
    for (let i = 0; i < 90; i++) {
      const v = f[i];
      if (v === 0) continue;
      const row = v > 0 ? this.featureOffset[v * 90 + i] : this.blackOffset[(-v) * 90 + i];
      if (row < 0) continue;
      for (let j = 0; j < 256; j += 4) {
        h1[j] += w1t[row + j];
        h1[j + 1] += w1t[row + j + 1];
        h1[j + 2] += w1t[row + j + 2];
        h1[j + 3] += w1t[row + j + 3];
      }
    }
    if (board.side === 1) {
      const off = this.sideOffset;
      for (let j = 0; j < 256; j += 4) {
        h1[j] += w1t[off + j];
        h1[j + 1] += w1t[off + j + 1];
        h1[j + 2] += w1t[off + j + 2];
        h1[j + 3] += w1t[off + j + 3];
      }
    }
    for (let j = 0; j < 256; j++) if (h1[j] < 0) h1[j] = 0;

    const w2 = this.w2;
    for (let j = 0; j < 192; j++) {
      const off = j * 256;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < 256; k += 4) {
        s0 += w2[off + k] * h1[k];
        s1 += w2[off + k + 1] * h1[k + 1];
        s2 += w2[off + k + 2] * h1[k + 2];
        s3 += w2[off + k + 3] * h1[k + 3];
      }
      const v = this.b2[j] + s0 + s1 + s2 + s3;
      h2[j] = v > 0 ? v : 0;
    }

    const w3 = this.w3;
    for (let j = 0; j < 96; j++) {
      const off = j * 192;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < 192; k += 4) {
        s0 += w3[off + k] * h2[k];
        s1 += w3[off + k + 1] * h2[k + 1];
        s2 += w3[off + k + 2] * h2[k + 2];
        s3 += w3[off + k + 3] * h2[k + 3];
      }
      const v = this.b3[j] + s0 + s1 + s2 + s3;
      h3[j] = v > 0 ? v : 0;
    }

    let out = this.b4[0];
    for (let k = 0; k < 96; k++) out += this.w4[k] * h3[k];
    return Math.tanh(out);
  }
}

export async function loadMLP() {
  const base = new URL("../model/", import.meta.url);
  const [metaRes, binRes] = await Promise.all([
    fetch(new URL("meta.json", base)),
    fetch(new URL("values.bin", base)),
  ]);
  if (!metaRes.ok) throw new Error("无法加载模型元数据");
  if (!binRes.ok) throw new Error("无法加载模型权重");
  const meta = await metaRes.json();
  const buffer = await binRes.arrayBuffer();
  return new MLP(meta, buffer);
}

export function mlpFromParts(meta, buffer) {
  return new MLP(meta, buffer);
}
