import "./style.css";
import { arcgisQuery, msilFetchRaw } from "./api";
import { JapanMap } from "./japanmap";
import { mountNav } from "./nav";
import { formatJst } from "./time";

mountNav("koori");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const metaEl = document.getElementById("koori-meta")!;
const legendEl = document.getElementById("koori-legend") as HTMLElement;
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const tooltip = document.getElementById("tooltip")!;

// 北日本（オホーツク海・北海道沖）に寄せる。海氷はこの範囲にしか現れない。
const NORTH_BBOX: [number, number, number, number] = [139, 43, 149, 46];
const map = new JapanMap(canvas, NORTH_BBOX);

const TWO_PI = Math.PI * 2;

interface IceFeature {
  rings: [number, number][][]; // ポリゴン（外環＋穴）。点データのときは空
  point?: [number, number];
  conc: number | null; // 密接度[%] 0..100。取れなければ null（＝一様な白）
  cx: number; // 重心（ホバー最近傍用）
  cy: number;
}

let iceFeatures: IceFeature[] = [];

/** 密接度フィールドを防御的に拾う（実データの名称が大小文字・和名で揺れるため） */
function pickConc(p: Record<string, unknown>): number | null {
  // キーを小文字化してから引く（全大文字など大小文字の揺れに強くする）。
  // 外部API由来のキー（__proto__ 等）でプロトタイプ汚染しないよう null プロトで正規化。
  const low: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(p)) low[k.toLowerCase()] = v;
  const raw =
    low.concentration ?? low["密接度"] ?? low.density ??
    low.value ?? low.gridcode ?? low.dn ?? null;
  const n = typeof raw === "number" ? raw : raw != null && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function centroid(rings: [number, number][][]): [number, number] {
  let sx = 0, sy = 0, n = 0;
  for (const r of rings) for (const [x, y] of r) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n] : [0, 0];
}

/** 海氷レベル 0..1（薄氷→密氷）。密接度が取れなければ中庸の 0.7。 */
function iceLevel(conc: number | null): number {
  return conc != null ? Math.min(Math.max(conc / 100, 0), 1) : 0.7;
}

/**
 * 海氷の色: 冷たい白。速度色ランプ（シアン系）ではなく白基調で、密なほど明るい白へ。
 * かすかに青みを残して氷らしくしつつ、単一色相（白）の濃淡として表現する。
 */
function iceColor(t: number): [number, number, number] {
  const lo: [number, number, number] = [150, 170, 190]; // 薄氷: 淡い青灰
  const hi: [number, number, number] = [232, 242, 250]; // 密氷: ほぼ白
  return [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t];
}

async function fetchIce(): Promise<IceFeature[]> {
  const out: IceFeature[] = [];
  for (let page = 0; page < 12; page++) {
    const gj = await arcgisQuery("ice-information-jcg/v2", 3, NORTH_BBOX, {
      outFields: "*",
      resultOffset: String(page * 1000),
    });
    for (const f of gj.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      const conc = pickConc(f.properties ?? {});
      if (g.type === "Polygon") {
        const rings = g.coordinates as [number, number][][];
        const [cx, cy] = centroid(rings);
        out.push({ rings, conc, cx, cy });
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates as [number, number][][][]) {
          const [cx, cy] = centroid(poly);
          out.push({ rings: poly, conc, cx, cy });
        }
      } else if (g.type === "Point") {
        const [x, y] = g.coordinates as [number, number];
        out.push({ rings: [], point: [x, y], conc, cx: x, cy: y });
      } else if (g.type === "MultiPoint") {
        for (const pt of g.coordinates as [number, number][]) {
          out.push({ rings: [], point: pt, conc, cx: pt[0], cy: pt[1] });
        }
      }
    }
    statusEl.textContent = `海氷データを取得中… ${out.length}`;
    if (!gj.exceededTransferLimit) break;
  }
  return out;
}

/** 時系列（range）から解析時刻を拾う。取れなければ null。 */
async function fetchIceTime(): Promise<string | null> {
  try {
    const res = await msilFetchRaw("/ice-information-jcg/v2/MapServer/range");
    const d = await res.json();
    const f = d.features?.[0];
    const raw = f?.attributes?.msilendtime ?? f?.properties?.msilendtime ?? null;
    if (raw == null) return null;
    const dt = new Date(typeof raw === "number" ? raw : Date.parse(raw));
    return isNaN(dt.getTime()) ? null : formatJst(dt);
  } catch {
    return null;
  }
}

// ---- 描画 ----------------------------------------------------------------
function draw() {
  map.drawBase();
  const ctx = map.ctx;
  for (const f of iceFeatures) {
    const t = iceLevel(f.conc);
    const [r, g, b] = iceColor(t);
    if (f.point) {
      ctx.globalCompositeOperation = "lighter";
      const [x, y] = map.toScreen(f.point[0], f.point[1]);
      ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.3 + t * 0.45})`;
      ctx.beginPath();
      ctx.arc(x, y, (1.2 + t * 2.0) * map.dpr, 0, TWO_PI);
      ctx.fill();
    } else if (f.rings.length) {
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      for (const ring of f.rings) {
        for (let i = 0; i < ring.length; i++) {
          const [sx, sy] = map.toScreen(ring[i][0], ring[i][1]);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
      }
      ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.2 + t * 0.42})`;
      ctx.fill("evenodd");
      ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.3 + t * 0.4})`;
      ctx.lineWidth = 0.8 * map.dpr;
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawLegend() {
  const ctx = legendCanvas.getContext("2d")!;
  for (let x = 0; x < legendCanvas.width; x++) {
    // 凡例は海氷の白のトーン帯（少→密）
    const t = x / legendCanvas.width;
    const [r, g, b] = iceColor(t);
    ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.fillRect(x, 0, 1, legendCanvas.height);
  }
}

// ---- UI -----------------------------------------------------------------
canvas.addEventListener("pointermove", (ev) => {
  if (!iceFeatures.length) {
    tooltip.classList.remove("visible");
    return;
  }
  const cx = ev.clientX * map.dpr;
  const cy = ev.clientY * map.dpr;
  let best = Infinity;
  let bestF: IceFeature | null = null;
  for (const f of iceFeatures) {
    const [x, y] = map.toScreen(f.cx, f.cy);
    const d = Math.hypot(x - cx, y - cy);
    if (d < best) { best = d; bestF = f; }
  }
  if (bestF && best < 44 * map.dpr) {
    tooltip.classList.add("visible");
    tooltip.style.left = `${ev.clientX + 14}px`;
    tooltip.style.top = `${ev.clientY + 14}px`;
    // 表示も描画(iceLevel)と同じく 0..100 にクランプして整合させる
    tooltip.textContent =
      bestF.conc != null ? `密接度 ${Math.round(Math.min(Math.max(bestF.conc, 0), 100))} %` : "海氷";
  } else {
    tooltip.classList.remove("visible");
  }
});
canvas.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));
window.addEventListener("resize", () => {
  map.resize();
  if (iceFeatures.length) draw();
  else map.drawBase();
});

// ---- 起動 ---------------------------------------------------------------
async function boot() {
  statusEl.textContent = "海氷データを取得中…";
  try {
    const [feats] = await Promise.all([fetchIce(), map.init()]);
    iceFeatures = feats;
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  statusEl.textContent = "";

  if (!iceFeatures.length) {
    // オフシーズンの正直さ: 空を空として見せる（ねむりの精神）
    metaEl.textContent = "いまオホーツク海に海氷はありません（結氷期: 1〜3月）";
    legendEl.hidden = true;
    map.drawBase();
    return;
  }

  const time = await fetchIceTime();
  metaEl.textContent = time ? `海氷分布（${time}）` : "海氷分布";
  legendEl.hidden = false;
  drawLegend();
  draw();
}

void boot();
