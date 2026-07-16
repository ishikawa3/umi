import "./style.css";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { speedColor } from "./render";
import { mountNav } from "./nav";
import { API_BASE, MSIL_KEY } from "./config";

mountNav("michi");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const metaEl = document.getElementById("michi-meta")!;
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const legendMax = document.getElementById("legend-max")!;
const tooltip = document.getElementById("tooltip")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

// 船舶通航量（AIS統計）の対象年。APIは年単位（2017–2020）でのみ提供。最新の確定年を使う。
const YEAR = "2020";
// 密度ラスタの取得解像度。JAPAN_BBOX の縦横比（経度26° × 緯度22°）に合わせる。
const [BB_X0, BB_Y0, BB_X1, BB_Y1] = JAPAN_BBOX;
const LON_SPAN = BB_X1 - BB_X0; // 26
const LAT_SPAN = BB_Y1 - BB_Y0; // 22
const RASTER_W = 1400;
const RASTER_H = Math.round((RASTER_W * LAT_SPAN) / LON_SPAN);

// 公式ラスタの5色パレット → 通航量の4クラス（低→高）。白は背景（無データ）。
const CLASS_COLORS: { rgb: [number, number, number]; cls: number }[] = [
  { rgb: [0, 112, 255], cls: 1 }, // 青 = 閑散
  { rgb: [152, 230, 0], cls: 2 }, // 緑 = 中
  { rgb: [255, 170, 0], cls: 3 }, // 橙 = 多い
  { rgb: [214, 47, 39], cls: 4 }, // 赤 = 過密
];
const CLASS_LABEL = ["閑散", "中", "多い", "過密"];

/** ピクセルRGB → クラス(1..4)。背景(白)や不明色は 0。 */
function classify(r: number, g: number, b: number): number {
  // 白背景（253,253,253 近傍）は無データ
  if (r > 235 && g > 235 && b > 235) return 0;
  let best = 0;
  let bestD = Infinity;
  for (const c of CLASS_COLORS) {
    const dr = r - c.rgb[0];
    const dg = g - c.rgb[1];
    const db = b - c.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = c.cls;
    }
  }
  // どのクラス色にも遠すぎる（アンチエイリアス縁など）は捨てる
  return bestD < 90 * 90 ? best : 0;
}

/** ラスタ pixel(col,row) → 経緯度（等緯度経度＝プレートカレー） */
function pixelToLonLat(col: number, row: number): [number, number] {
  const lon = BB_X0 + ((col + 0.5) / RASTER_W) * LON_SPAN;
  const lat = BB_Y1 - ((row + 0.5) / RASTER_H) * LAT_SPAN;
  return [lon, lat];
}

// クラス格子（0=背景, 1..4）。ホバーの O(1) 参照にも使う。
let grid: Uint8Array | null = null;

async function loadTraffic(): Promise<void> {
  const url =
    `${API_BASE}/monthly-vessel-traffic-amount/v2/${YEAR}/MapServer/export` +
    `?bbox=${BB_X0},${BB_Y0},${BB_X1},${BB_Y1}` +
    `&layers=show:0&size=${RASTER_W},${RASTER_H}&f=image`;
  const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": MSIL_KEY } });
  if (!res.ok) throw new Error(`traffic ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);

  // オフスクリーンに描いてピクセルを読む
  const off = document.createElement("canvas");
  off.width = RASTER_W;
  off.height = RASTER_H;
  const octx = off.getContext("2d", { willReadFrequently: true })!;
  octx.drawImage(bmp, 0, 0, RASTER_W, RASTER_H);
  const data = octx.getImageData(0, 0, RASTER_W, RASTER_H).data;

  const g = new Uint8Array(RASTER_W * RASTER_H);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = classify(data[p], data[p + 1], data[p + 2]);
  }
  grid = g;
}

// ---- 描画 ----------------------------------------------------------------
function drawTraffic() {
  if (!grid) return;
  map.drawBase();
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  for (let row = 0; row < RASTER_H; row++) {
    for (let col = 0; col < RASTER_W; col++) {
      const cls = grid[row * RASTER_W + col];
      if (cls === 0) continue;
      const [lon, lat] = pixelToLonLat(col, row);
      const [x, y] = map.toScreen(lon, lat);
      const t = cls / 4; // 0.25 / 0.5 / 0.75 / 1.0
      const [r, gg, b] = speedColor(t, 1);
      const coreR = (0.7 + t * 1.5) * map.dpr;
      // 過密ほど大きく灯る外側のにじみ
      if (cls >= 2) {
        ctx.fillStyle = `rgba(${r | 0}, ${gg | 0}, ${b | 0}, ${0.05 + t * 0.11})`;
        ctx.beginPath();
        ctx.arc(x, y, coreR * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      // 芯
      ctx.fillStyle = `rgba(${r | 0}, ${gg | 0}, ${b | 0}, ${0.22 + t * 0.55})`;
      ctx.beginPath();
      ctx.arc(x, y, coreR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawLegend() {
  const ctx = legendCanvas.getContext("2d")!;
  for (let x = 0; x < legendCanvas.width; x++) {
    const [r, g, b] = speedColor(x / legendCanvas.width, 1);
    ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.fillRect(x, 0, 1, legendCanvas.height);
  }
  legendMax.textContent = "過密";
}

// ---- UI -----------------------------------------------------------------
canvas.addEventListener("pointermove", (ev) => {
  if (!grid) {
    tooltip.classList.remove("visible");
    return;
  }
  // 画面座標 → 経緯度（メルカトル逆変換）→ ラスタ格子（O(1) 参照）
  const [lon, lat] = map.toLonLat(ev.clientX * map.dpr, ev.clientY * map.dpr);
  const col = Math.round(((lon - BB_X0) / LON_SPAN) * RASTER_W - 0.5);
  const row = Math.round(((BB_Y1 - lat) / LAT_SPAN) * RASTER_H - 0.5);
  if (col < 0 || col >= RASTER_W || row < 0 || row >= RASTER_H) {
    tooltip.classList.remove("visible");
    return;
  }
  const cls = grid[row * RASTER_W + col];
  if (cls === 0) {
    tooltip.classList.remove("visible");
    return;
  }
  tooltip.classList.add("visible");
  tooltip.style.left = `${ev.clientX + 14}px`;
  tooltip.style.top = `${ev.clientY + 14}px`;
  tooltip.textContent = `通航 ${CLASS_LABEL[cls - 1]}`;
});
canvas.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));
window.addEventListener("resize", () => {
  map.resize();
  drawTraffic();
});

// ---- 起動 ---------------------------------------------------------------
async function boot() {
  statusEl.textContent = "船舶通航量データ取得中…";
  try {
    await map.init();
    await loadTraffic();
    statusEl.textContent = "";
    metaEl.textContent = `AIS統計 ${YEAR}年（海上保安庁）`;
    drawLegend();
    drawTraffic();
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
  }
}

void boot();
