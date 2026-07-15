import type { Area, ContourLine } from "./api";
import { VectorField, lerpLookup } from "./field";
import type { LandMask } from "./landmask";

/** 速度[kt] → 色。単一色相（青〜シアン）のシーケンシャルランプ、暗色面用。 */
export function speedColor(kt: number, maxKt: number): [number, number, number] {
  const t = Math.min(kt / Math.max(maxKt, 0.5), 1);
  // 停止: 深い群青 → 速い: 白く砕ける波頭
  const stops: [number, number, number][] = [
    [27, 58, 92],
    [31, 95, 138],
    [43, 140, 184],
    [63, 188, 212],
    [127, 227, 224],
    [216, 255, 244],
  ];
  const f = t * (stops.length - 1);
  const i = Math.min(Math.floor(f), stops.length - 2);
  const k = f - i;
  const [r1, g1, b1] = stops[i];
  const [r2, g2, b2] = stops[i + 1];
  return [r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k];
}

interface Particle {
  lon: number;
  lat: number;
  age: number;
  life: number;
  px: number; // 前フレームのスクリーン座標
  py: number;
}

export class FlowRenderer {
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private fieldA: VectorField | null = null;
  private fieldB: VectorField | null = null;
  private lerpT = 0;
  private area: Area | null = null;
  private contours: ContourLine[] = [];
  private mask: LandMask | null = null;
  private lookupOut = new Float32Array(2);
  private lookupTmp = new Float32Array(2);
  private reducedMotion: boolean;
  // 投影パラメータ
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private latScale = 1;
  dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(private canvas: HTMLCanvasElement, reducedMotion = false) {
    this.reducedMotion = reducedMotion;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.fitProjection();
    this.clearAll();
  }

  setArea(area: Area, contours: ContourLine[], mask: LandMask | null) {
    this.area = area;
    this.contours = contours;
    this.mask = mask;
    this.fieldA = null;
    this.fieldB = null;
    this.particles = [];
    this.fitProjection();
    this.clearAll();
  }

  setFields(a: VectorField, b: VectorField | null, t: number) {
    const changed = this.fieldA !== a;
    this.fieldA = a;
    this.fieldB = b;
    this.lerpT = t;
    if (changed) this.seedParticles();
  }

  setLerp(t: number) {
    this.lerpT = t;
  }

  get maxKt(): number {
    return Math.max(this.fieldA?.maxKt ?? 0, this.fieldB?.maxKt ?? 0);
  }

  /** 色スケールの基準速度。p90ベースで、静かな海域でも表情が出るようにする */
  get refKt(): number {
    const p90 = Math.max(this.fieldA?.p90Kt ?? 0, this.fieldB?.p90Kt ?? 0);
    return Math.max(p90 * 1.25, 0.4);
  }

  private fitProjection() {
    if (!this.area) return;
    const [x0, y0, x1, y1] = this.area.bbox;
    const midLat = (y0 + y1) / 2;
    this.latScale = 1 / Math.cos((midLat * Math.PI) / 180);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dataW = x1 - x0;
    const dataH = (y1 - y0) * this.latScale;
    const pad = 0.92;
    this.scale = Math.min((w / dataW) * pad, (h / dataH) * pad);
    this.ox = w / 2 - ((x0 + x1) / 2) * this.scale;
    this.oy = h / 2 + midLat * this.latScale * this.scale;
  }

  toScreen(lon: number, lat: number): [number, number] {
    return [lon * this.scale + this.ox, this.oy - lat * this.latScale * this.scale];
  }

  toLonLat(px: number, py: number): [number, number] {
    return [(px - this.ox) / this.scale, (this.oy - py) / this.scale / this.latScale];
  }

  /** カーソル位置の流速を調べる（ツールチップ用）。 */
  probe(cssX: number, cssY: number): { kt: number; dir: number } | null {
    if (!this.fieldA) return null;
    const [lon, lat] = this.toLonLat(cssX * this.dpr, cssY * this.dpr);
    if (this.mask && !this.mask.isWater(lon, lat)) return null;
    const ok = lerpLookup(
      this.fieldA, this.fieldB, this.lerpT, lon, lat, this.lookupOut, this.lookupTmp
    );
    if (!ok) return null;
    const [u, v] = this.lookupOut;
    const kt = Math.hypot(u, v);
    const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
    return { kt, dir };
  }

  private seedParticles() {
    if (!this.fieldA || !this.area) return;
    const f = this.fieldA;
    // データ点密度に応じて粒子数を決める
    const count = Math.min(Math.max(f.n * 3, 4000), 14000);
    this.particles = [];
    for (let i = 0; i < count; i++) this.particles.push(this.spawn());
  }

  private spawn(): Particle {
    const f = this.fieldA!;
    // 実在するデータ点の近傍・水域内から生まれる → 海域の形が自然に浮かぶ
    const jitter = f.spacing * (f.n < 300 ? 3.2 : 1.4);
    let lon = 0;
    let lat = 0;
    for (let tries = 0; tries < 8; tries++) {
      const i = Math.floor(Math.random() * f.n);
      const [lon0, lat0] = f.sampleAt(i);
      lon = lon0 + (Math.random() - 0.5) * 2 * jitter;
      lat = lat0 + (Math.random() - 0.5) * 2 * jitter;
      if (!this.mask || this.mask.isWater(lon, lat)) break;
      if (tries === 7) [lon, lat] = f.sampleAt(i); // 最後はデータ点そのもの（必ず海上）
    }
    const [px, py] = this.toScreen(lon, lat);
    return { lon, lat, age: 0, life: 80 + Math.random() * 160, px, py };
  }

  private clearAll() {
    this.ctx.fillStyle = "#04070f";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawContours();
  }

  private drawContours() {
    if (!this.contours.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    for (const line of this.contours) {
      // 深いほどわずかに明るく＝海底の陰影
      const a = 0.05 + Math.min(line.depth / 200, 1) * 0.06;
      ctx.strokeStyle = `rgba(90, 140, 190, ${a})`;
      for (const path of line.paths) {
        ctx.beginPath();
        for (let i = 0; i < path.length; i++) {
          const [sx, sy] = this.toScreen(path[i][0], path[i][1]);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 1フレーム描画。dt は秒。 */
  frame(dt: number) {
    const ctx = this.ctx;
    const f = this.fieldA;
    if (!f) return;

    if (this.reducedMotion) {
      // アニメーションなし: 静止速度マップのみ描く
      this.clearAll();
      this.drawStaticSpeedMap();
      return;
    }

    // 残像フェード（軌跡）
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(4, 7, 15, 0.06)";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawContours();

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    const refKt = this.refKt;
    // 1ktでこのくらい動く（度/秒）。海域の広さに合わせる
    const speedScale = f.spacing * 2.2;
    const out = this.lookupOut;
    const tmp = this.lookupTmp;

    for (let i = 0; i < this.particles.length; i++) {
      let p = this.particles[i];
      p.age += 1;
      const ok =
        p.age < p.life &&
        lerpLookup(f, this.fieldB, this.lerpT, p.lon, p.lat, out, tmp);
      if (!ok) {
        this.particles[i] = p = this.spawn();
        continue;
      }
      const u = out[0];
      const v = out[1];
      const kt = Math.hypot(u, v);
      p.lon += u * speedScale * dt;
      p.lat += (v * speedScale * dt) / this.latScale;
      // 陸に上がった粒子は消す（推算値は海上にしか存在しない）
      if (this.mask && !this.mask.isWater(p.lon, p.lat)) {
        this.particles[i] = this.spawn();
        continue;
      }
      const [sx, sy] = this.toScreen(p.lon, p.lat);

      const [r, g, b] = speedColor(kt, refKt);
      // 速いほど明るく太く（ガンマで中間域を持ち上げる）
      const t = Math.pow(Math.min(kt / refKt, 1), 0.7);
      const fadeIn = Math.min(p.age / 12, 1);
      const fadeOut = Math.min((p.life - p.age) / 20, 1);
      const alpha = (0.13 + t * 0.38) * fadeIn * fadeOut;
      ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
      ctx.lineWidth = (0.7 + t * 1.6) * this.dpr;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      p.px = sx;
      p.py = sy;
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** prefers-reduced-motion 用: 粒子なしで速度をドット密度で表示 */
  private drawStaticSpeedMap() {
    if (!this.fieldA || !this.area) return;
    const ctx = this.ctx;
    const f = this.fieldA;
    const refKt = this.refKt;
    const out = this.lookupOut;
    const step = 6; // グリッド間隔(px)
    ctx.globalCompositeOperation = "lighter";
    for (let px = 0; px < this.canvas.width; px += step) {
      for (let py = 0; py < this.canvas.height; py += step) {
        const [lon, lat] = this.toLonLat(px, py);
        if (this.mask && !this.mask.isWater(lon, lat)) continue;
        const ok = f.lookup(lon, lat, out);
        if (!ok) continue;
        const kt = Math.hypot(out[0], out[1]);
        const [r, g, b] = speedColor(kt, refKt);
        const t = Math.pow(Math.min(kt / refKt, 1), 0.7);
        ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.08 + t * 0.25})`;
        ctx.fillRect(px, py, step - 1, step - 1);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
