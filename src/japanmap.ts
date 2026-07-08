import { buildLandMask, lonToX, latToY, type LandMask } from "./landmask";

export const JAPAN_BBOX: [number, number, number, number] = [122, 24, 148, 46];

/**
 * 日本全域ページの共通部品。
 * Webメルカトル投影（水域マスクと同じ座標系）で bbox をキャンバスに収め、
 * 国土地理院タイル由来の陸シルエットを背景として描く。
 */
export class JapanMap {
  readonly ctx: CanvasRenderingContext2D;
  readonly dpr = Math.min(window.devicePixelRatio || 1, 2);
  mask: LandMask | null = null;
  private land: HTMLCanvasElement | null = null;
  private scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly bbox: [number, number, number, number] = JAPAN_BBOX
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.resize();
  }

  async init(): Promise<void> {
    this.mask = await buildLandMask(this.bbox);
    if (this.mask) this.land = this.mask.landImage(226, 238, 248, 14);
    this.resize();
  }

  resize() {
    this.canvas.width = Math.round(this.canvas.clientWidth * this.dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * this.dpr);
    const z = this.mask?.z ?? 6;
    const [x0, y0, x1, y1] = this.bbox;
    const bx0 = lonToX(x0, z);
    const bx1 = lonToX(x1, z);
    const by0 = latToY(y1, z); // 北がy小
    const by1 = latToY(y0, z);
    const pad = 0.94;
    this.scale = Math.min(
      (this.canvas.width / (bx1 - bx0)) * pad,
      (this.canvas.height / (by1 - by0)) * pad
    );
    this.ox = this.canvas.width / 2 - ((bx0 + bx1) / 2) * this.scale;
    this.oy = this.canvas.height / 2 - ((by0 + by1) / 2) * this.scale;
  }

  toScreen(lon: number, lat: number): [number, number] {
    const z = this.mask?.z ?? 6;
    return [lonToX(lon, z) * this.scale + this.ox, latToY(lat, z) * this.scale + this.oy];
  }

  toLonLat(px: number, py: number): [number, number] {
    const z = this.mask?.z ?? 6;
    const wx = (px - this.ox) / this.scale;
    const wy = (py - this.oy) / this.scale;
    const n = 2 ** z * 256;
    const lon = (wx / n) * 360 - 180;
    const yFrac = wy / n;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * yFrac))) * 180) / Math.PI;
    return [lon, lat];
  }

  /** 背景（海の闇＋陸シルエット）を描く。ctx省略時はメインキャンバス */
  drawBase(ctx: CanvasRenderingContext2D = this.ctx) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#04070f";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawLand(ctx);
  }

  /** 陸シルエットのみ重ねる */
  drawLand(ctx: CanvasRenderingContext2D = this.ctx) {
    if (!this.land || !this.mask) return;
    ctx.drawImage(
      this.land,
      this.mask.px0 * this.scale + this.ox,
      this.mask.py0 * this.scale + this.oy,
      this.mask.w * this.scale,
      this.mask.h * this.scale
    );
  }
}
