import "./style.css";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { speedColor } from "./render";
import { mountNav } from "./nav";
import { fetchTrafficRaster, activeIndices, TRAFFIC_CLASS_LABEL } from "./traffic-raster";

mountNav("michi");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const metaEl = document.getElementById("michi-meta")!;
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const legendMax = document.getElementById("legend-max")!;
const tooltip = document.getElementById("tooltip")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

// 密度ラスタの取得解像度。JAPAN_BBOX の縦横比（経度26° × 緯度22°）に合わせる。
const [BB_X0, BB_Y0, BB_X1, BB_Y1] = JAPAN_BBOX;
const LON_SPAN = BB_X1 - BB_X0; // 26
const LAT_SPAN = BB_Y1 - BB_Y0; // 22
const RASTER_W = 1400;
const RASTER_H = Math.round((RASTER_W * LAT_SPAN) / LON_SPAN);

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

// クラス別スプライトを1回だけ事前描画。drawTraffic は arc の代わりにこれをブリットする
// （lighter のまま重ねるので加算＝見た目は不変。パスのラスタライズを bitmap 転送に置換）。
interface ClassSprite {
  canvas: HTMLCanvasElement;
  c: number; // 中心オフセット（= サイズ/2）
}
const CLASS_SPRITE: ClassSprite[] = CLASS_STYLE.map((st): ClassSprite => {
  const maxR = st.bloom ? st.coreR * 2.4 : st.coreR;
  const size = Math.ceil(maxR * 2) + 2;
  const c = size / 2;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const sctx = cv.getContext("2d")!;
  sctx.globalCompositeOperation = "lighter";
  if (st.bloom) {
    sctx.fillStyle = st.fillBloom;
    sctx.beginPath();
    sctx.arc(c, c, st.coreR * 2.4, 0, TWO_PI);
    sctx.fill();
  }
  sctx.fillStyle = st.fillCore;
  sctx.beginPath();
  sctx.arc(c, c, st.coreR, 0, TWO_PI);
  sctx.fill();
  return { canvas: cv, c };
});

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

/** 通航量ラスタを取得して格子を差し替える。使えた年を返す */
async function loadTraffic(): Promise<string> {
  const { classes, year } = await fetchTrafficRaster(JAPAN_BBOX, RASTER_W, RASTER_H);
  grid = classes;
  activeIdx = activeIndices(classes);
  return year;
}

// ---- 描画 ----------------------------------------------------------------
function drawTraffic() {
  if (!grid || !activeIdx) return;
  map.drawBase();
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  // 非0画素だけを走査（O(非0画素数)）。事前描画したスプライトを lighter でブリット。
  for (let k = 0; k < activeIdx.length; k++) {
    const idx = activeIdx[k];
    const col = idx % RASTER_W;
    const row = (idx / RASTER_W) | 0;
    const [lon, lat] = pixelToLonLat(col, row);
    const [x, y] = map.toScreen(lon, lat);
    const sp = CLASS_SPRITE[grid[idx] - 1];
    ctx.drawImage(sp.canvas, x - sp.c, y - sp.c);
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
  tooltip.textContent = `通航 ${TRAFFIC_CLASS_LABEL[cls - 1]}`;
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
    const year = await loadTraffic();
    statusEl.textContent = "";
    metaEl.textContent = `AIS統計 ${year}年（海上保安庁）`;
    drawLegend();
    drawTraffic();
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
  }
}

void boot();
