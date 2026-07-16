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

const TWO_PI = Math.PI * 2;

// クラス(1..4)ごとの描画スタイルを事前計算。speedColor と rgba 文字列生成は
// ここで4回だけ行い、drawTraffic のループでは per-pixel の再計算・確保を避ける。
interface ClassStyle {
  fillCore: string;
  fillBloom: string;
  coreR: number; // 既に dpr を掛けた画面px
  bloom: boolean;
}
const CLASS_STYLE: ClassStyle[] = [1, 2, 3, 4].map((cls): ClassStyle => {
  const t = cls / 4; // 0.25 / 0.5 / 0.75 / 1.0
  const [r, g, b] = speedColor(t, 1);
  const rgb = `${r | 0}, ${g | 0}, ${b | 0}`;
  return {
    fillCore: `rgba(${rgb}, ${0.22 + t * 0.55})`,
    fillBloom: `rgba(${rgb}, ${0.05 + t * 0.11})`,
    coreR: (0.7 + t * 1.5) * map.dpr,
    bloom: cls >= 2, // 過密ほど大きく灯る外側のにじみ
  };
});

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

// クラス格子（0=背景, 1..4）。ホバーの O(1) 参照に使う。
let grid: Uint8Array | null = null;
// 非0（描画対象）画素のインデックス一覧。描画を O(非0画素数) にするため。
let activeIdx: Int32Array | null = null;

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
  bmp.close(); // ピクセル取得後は不要。大きめの export 画像を早期に解放する。

  const g = new Uint8Array(RASTER_W * RASTER_H);
  const active: number[] = [];
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const cls = classify(data[p], data[p + 1], data[p + 2]);
    if (cls !== 0) {
      g[i] = cls;
      active.push(i);
    }
  }
  grid = g;
  activeIdx = Int32Array.from(active);
}

// ---- 描画 ----------------------------------------------------------------
function drawTraffic() {
  if (!grid || !activeIdx) return;
  map.drawBase();
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  // 非0画素だけを走査（O(非0画素数)）
  for (let k = 0; k < activeIdx.length; k++) {
    const idx = activeIdx[k];
    const col = idx % RASTER_W;
    const row = (idx / RASTER_W) | 0;
    const [lon, lat] = pixelToLonLat(col, row);
    const [x, y] = map.toScreen(lon, lat);
    const st = CLASS_STYLE[grid[idx] - 1];
    // 過密ほど大きく灯る外側のにじみ
    if (st.bloom) {
      ctx.fillStyle = st.fillBloom;
      ctx.beginPath();
      ctx.arc(x, y, st.coreR * 2.4, 0, TWO_PI);
      ctx.fill();
    }
    // 芯
    ctx.fillStyle = st.fillCore;
    ctx.beginPath();
    ctx.arc(x, y, st.coreR, 0, TWO_PI);
    ctx.fill();
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

// resize は連続発火するため、描画は requestAnimationFrame で1フレームに集約する
let drawRaf = 0;
function scheduleDraw() {
  if (drawRaf) return;
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0;
    drawTraffic();
  });
}
window.addEventListener("resize", () => {
  map.resize();
  scheduleDraw();
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
