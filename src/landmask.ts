/**
 * 国土地理院 淡色地図タイルから水域マスクを作る。
 * 海しるAPIは海上の推算地点しか持たないため、陸の判定はこのマスクで行う。
 * 海色 ≈ rgb(190, 210, 255)。地名文字・境界線で開く小穴はクロージングで埋める。
 * タイル取得に失敗した場合は null（マスクなし＝従来動作）にフォールバック。
 */

const TILE_URL = (z: number, x: number, y: number) =>
  `https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`;
const TILE = 256;

function lonToX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z * TILE;
}
function latToY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * TILE;
}

export class LandMask {
  constructor(
    private data: Uint8Array, // 1 = 水域
    private w: number,
    private h: number,
    private px0: number, // マスク原点のグローバルピクセル座標（zoom z）
    private py0: number,
    private z: number
  ) {}

  isWater(lon: number, lat: number): boolean {
    const x = Math.floor(lonToX(lon, this.z) - this.px0);
    const y = Math.floor(latToY(lat, this.z) - this.py0);
    // マスク外（対象海域のパディングの外）は対象外として粒子を消す
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.data[y * this.w + x] === 1;
  }
}

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 海上などタイル欠損 → 水域扱い
    img.src = TILE_URL(z, x, y);
  });
}

/** 1=水域の二値マスクにクロージング（膨張→収縮）をかけて文字・線の穴を埋める */
function close(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const dilate = (src: Uint8Array, val: number) => {
    const tmp = new Uint8Array(src.length);
    // 水平
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w && src[y * w + xx] === val) { hit = 1; break; }
        }
        tmp[y * w + x] = hit ? val : src[y * w + x];
      }
    }
    // 垂直
    const out = new Uint8Array(tmp.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h && tmp[yy * w + x] === val) { hit = 1; break; }
        }
        out[y * w + x] = hit ? val : tmp[y * w + x];
      }
    }
    return out;
  };
  // 水域を膨張してから陸を膨張で戻す＝クロージング
  return dilate(dilate(mask, 1), 0);
}

export async function buildLandMask(
  bbox: [number, number, number, number]
): Promise<LandMask | null> {
  try {
    const [x0, y0, x1, y1] = bbox;
    const padLon = (x1 - x0) * 0.08;
    const padLat = (y1 - y0) * 0.08;
    const lonSpan = x1 - x0 + padLon * 2;
    // マスク幅が1400px程度になるズームを選び、大きすぎる場合は1段ずつ下げる
    let z = Math.round(Math.log2(((360 / lonSpan) * 1400) / TILE));
    z = Math.max(9, Math.min(14, z));
    let px0 = 0, px1 = 0, py0 = 0, py1 = 0, w = 0, h = 0;
    for (; z >= 9; z--) {
      px0 = Math.floor(lonToX(x0 - padLon, z));
      px1 = Math.ceil(lonToX(x1 + padLon, z));
      py0 = Math.floor(latToY(y1 + padLat, z)); // 北がy小
      py1 = Math.ceil(latToY(y0 - padLat, z));
      w = px1 - px0;
      h = py1 - py0;
      if (w * h <= 16_000_000) break;
    }
    if (w <= 0 || h <= 0 || w * h > 16_000_000) return null;

    const tx0 = Math.floor(px0 / TILE);
    const tx1 = Math.floor((px1 - 1) / TILE);
    const ty0 = Math.floor(py0 / TILE);
    const ty1 = Math.floor((py1 - 1) / TILE);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // 取得失敗タイルは水域扱いにしたいので、先に海色で塗っておく
    ctx.fillStyle = "rgb(190, 210, 255)";
    ctx.fillRect(0, 0, w, h);

    const jobs: Promise<void>[] = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        jobs.push(
          loadTile(z, tx, ty).then((img) => {
            if (img) ctx.drawImage(img, tx * TILE - px0, ty * TILE - py0);
          })
        );
      }
    }
    await Promise.all(jobs);

    const { data } = ctx.getImageData(0, 0, w, h);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      // 淡色地図の海: 青みが強く明るい
      mask[i] = b >= 225 && b - r >= 35 && b - g >= 22 ? 1 : 0;
    }
    return new LandMask(close(mask, w, h, 3), w, h, px0, py0, z);
  } catch (e) {
    console.warn("[landmask] build failed:", e);
    return null;
  }
}
