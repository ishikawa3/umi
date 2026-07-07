import type { CurrentSample } from "./api";

/**
 * 散在する推算地点から連続的なベクトル場を作る。
 * 空間ハッシュ＋逆距離加重（IDW）補間。データ点から離れすぎた場所は
 * 「場なし」（陸・データ外）として扱う。
 */
export class VectorField {
  private cell: number;
  private bins = new Map<number, number[]>();
  /** データ点間の代表間隔（度） */
  readonly spacing: number;
  private maskDist2: number;
  // 平行配列（GC回避）
  private xs: Float64Array;
  private ys: Float64Array;
  private us: Float32Array; // 東向き成分 [kt]
  private vs: Float32Array; // 北向き成分 [kt]
  readonly kts: Float32Array;
  readonly n: number;
  readonly maxKt: number;
  /** 流速の90パーセンタイル。色スケールの基準（最大値だと全体が沈む） */
  readonly p90Kt: number;

  constructor(samples: CurrentSample[]) {
    const n = (this.n = samples.length);
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.us = new Float32Array(n);
    this.vs = new Float32Array(n);
    this.kts = new Float32Array(n);
    let maxKt = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      this.xs[i] = s.lon;
      this.ys[i] = s.lat;
      const rad = (s.dir * Math.PI) / 180;
      // 流向は「流れて行く方角」: 北=0°、時計回り
      this.us[i] = s.kt * Math.sin(rad);
      this.vs[i] = s.kt * Math.cos(rad);
      this.kts[i] = s.kt;
      if (s.kt > maxKt) maxKt = s.kt;
    }
    this.maxKt = maxKt;
    const sorted = Array.from(this.kts).sort((a, b) => a - b);
    this.p90Kt = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;

    this.spacing = this.estimateSpacing();
    // 疎な海域（推算地点が少ない）は補間を広めに効かせる
    const maskFactor = n < 300 ? 4.0 : 2.2;
    this.cell = this.spacing * maskFactor;
    this.maskDist2 = (this.spacing * maskFactor) ** 2;
    for (let i = 0; i < n; i++) {
      const key = this.binKey(this.xs[i], this.ys[i]);
      let bin = this.bins.get(key);
      if (!bin) this.bins.set(key, (bin = []));
      bin.push(i);
    }
  }

  sampleAt(i: number): [number, number] {
    return [this.xs[i], this.ys[i]];
  }

  private estimateSpacing(): number {
    // ランダムな点対の最近傍距離の中央値で近似
    const n = this.n;
    if (n < 2) return 0.01;
    const tryN = Math.min(200, n);
    const dists: number[] = [];
    for (let t = 0; t < tryN; t++) {
      const i = Math.floor((t / tryN) * n);
      let best = Infinity;
      // 全探索は重いのでサンプリング
      const step = Math.max(1, Math.floor(n / 500));
      for (let j = 0; j < n; j += step) {
        if (j === i) continue;
        const dx = this.xs[i] - this.xs[j];
        const dy = this.ys[i] - this.ys[j];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      dists.push(Math.sqrt(best));
    }
    dists.sort((a, b) => a - b);
    return Math.max(dists[Math.floor(dists.length / 2)], 1e-5);
  }

  private binKey(x: number, y: number): number {
    const bx = Math.floor(x / this.cell);
    const by = Math.floor(y / this.cell);
    return bx * 100000 + by;
  }

  /**
   * (lon, lat) の流速ベクトル [u kt, v kt] を返す。データ域外は null。
   * out に書き込んで返す（アロケーション回避）。
   */
  lookup(lon: number, lat: number, out: Float32Array): boolean {
    const bx = Math.floor(lon / this.cell);
    const by = Math.floor(lat / this.cell);
    let wSum = 0;
    let u = 0;
    let v = 0;
    let nearest2 = Infinity;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bin = this.bins.get((bx + ox) * 100000 + (by + oy));
        if (!bin) continue;
        for (const i of bin) {
          const dx = this.xs[i] - lon;
          const dy = this.ys[i] - lat;
          const d2 = dx * dx + dy * dy;
          if (d2 < nearest2) nearest2 = d2;
          const w = 1 / (d2 + 1e-9);
          wSum += w;
          u += this.us[i] * w;
          v += this.vs[i] * w;
        }
      }
    }
    if (wSum === 0 || nearest2 > this.maskDist2) return false;
    out[0] = u / wSum;
    out[1] = v / wSum;
    return true;
  }
}

/** 2つの場の線形補間ルックアップ（時刻再生をなめらかにする） */
export function lerpLookup(
  a: VectorField,
  b: VectorField | null,
  t: number,
  lon: number,
  lat: number,
  out: Float32Array,
  tmp: Float32Array
): boolean {
  const okA = a.lookup(lon, lat, out);
  if (!b || t <= 0) return okA;
  const okB = b.lookup(lon, lat, tmp);
  if (!okA) return false;
  if (okB) {
    out[0] += (tmp[0] - out[0]) * t;
    out[1] += (tmp[1] - out[1]) * t;
  }
  return true;
}
