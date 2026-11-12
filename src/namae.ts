import "./style.css";
import { featureQueryAll } from "./api";
import { JapanMap } from "./japanmap";
import { mountNav } from "./nav";
import { ambientLoop, type AmbientLoop } from "./motion";
import { speedColor } from "./render";

mountNav("namae");

/**
 * なまえ — 海の底につけられた名前（海上保安庁「海底地形名」）。
 *
 * 海山・海丘・海底谷の名前の多くは近くの地名に由来するが、
 * 一部は元号・二十四節気・星・七草・鳥・人名など、ひとつの「系統」でまとめて名づけられている。
 * 地名由来のものは点として静かに置き、系統で名づけられた名前を縦書きで浮かび上がらせる。
 */

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const countEl = document.getElementById("namae-count")!;
const chipsEl = document.getElementById("family-chips")!;
const tooltip = document.getElementById("tooltip")!;
tooltip.style.whiteSpace = "pre-line"; // 2行目に由来を出す
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const legendMax = document.getElementById("legend-max")!;

/** 南鳥島（鳥の名）・沖ノ鳥島（天然記念物の鳥）周辺の命名群まで入る範囲 */
const NAMAE_BBOX: [number, number, number, number] = [122, 17, 160, 46];
const map = new JapanMap(canvas, NAMAE_BBOX);

// ---- 系統 ------------------------------------------------------------------
// v3 の公式な「由来分類」（地理的名称・元号・鳥・七草・天文・人名…）で系統に分ける。
// 値には末尾の空白・改行や "<NULL>" が混じるので整えてから判定する。
interface Family {
  key: string;
  label: string;
  test: RegExp;
}
const FAMILIES: Family[] = [
  { key: "gengo", label: "元号", test: /^元号/ },
  { key: "koyomi", label: "暦・行事", test: /暦|節気|行事|祭|曜日/ }, // 陰暦の月名・七曜も暦の仲間
  { key: "tenmon", label: "天文", test: /^天文/ }, // 星・月・惑星
  { key: "kusaki", label: "草木", test: /七草|草木/ },
  { key: "tori", label: "鳥", test: /^鳥/ },
  { key: "hito", label: "人", test: /^人名/ }, // 海洋学者・作家・船長
  { key: "fune", label: "船", test: /船/ },
];
const OTHER: Family = { key: "hoka", label: "そのほか", test: /./ };
/** 地名に由来するもの・由来不明は系統に入れない（点として置く） */
const PLACE = /^(地理的名称|地元慣習名|近傍地名|不明|<NULL>)?$/;

function familyOf(category: string): Family | null {
  if (PLACE.test(category)) return null;
  return FAMILIES.find((f) => f.test.test(category)) ?? OTHER;
}

// ---- データ ----------------------------------------------------------------
interface Feature {
  name: string;
  kana: string;
  generic: string; // 属名（海山・海丘…）
  origin: string; // 呼称の由来
  depth: number | null; // m
  year: number | null; // 海洋地名打合せ会での承認年
  lon: number;
  lat: number;
  family: Family | null;
  /** 海底谷などの線・海山などの輪郭（経緯度） */
  shape: number[][][] | null;
}

let features: Feature[] = [];
let named: Feature[] = []; // 系統で名づけられたもの
let active: Family | null = null; // null = すべての系統
let hovered: Feature | null = null;

/** 水深は数値か "100m-1100m" のような文字列。範囲なら深い側をとる */
function parseDepth(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const nums = v.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : null;
}

function representative(g: any): [number, number] | null {
  const c = g?.coordinates;
  switch (g?.type) {
    case "Point":
      return [c[0], c[1]];
    case "LineString":
      return c[Math.floor(c.length / 2)];
    case "MultiLineString":
      return c[0][Math.floor(c[0].length / 2)];
    case "Polygon":
    case "MultiPolygon": {
      const ring: number[][] = g.type === "Polygon" ? c[0] : c[0][0];
      let x = 0, y = 0;
      for (const p of ring) { x += p[0]; y += p[1]; }
      return [x / ring.length, y / ring.length];
    }
  }
  return null;
}

function shapeOf(g: any): number[][][] | null {
  switch (g?.type) {
    case "LineString": return [g.coordinates];
    case "MultiLineString": return g.coordinates;
    case "Polygon": return g.coordinates;
    case "MultiPolygon": return g.coordinates.flat();
  }
  return null;
}

/** v3: 層0=点・1=線（海底谷など）・2=面（海山など） */
async function fetchLayer(layer: number): Promise<Feature[]> {
  const out: Feature[] = [];
  for (const f of await featureQueryAll("undersea_feature_name", layer, NAMAE_BBOX)) {
    const p = f.properties ?? {};
    const pos = representative(f.geometry);
    if (!pos) continue;
    out.push({
      name: String(p["海底地形名"] ?? ""),
      kana: String(p["かな"] ?? ""),
      generic: String(p["属名"] ?? ""),
      origin: String(p["呼称の由来"] ?? "").trim(),
      depth: parseDepth(p["水深"]),
      year: typeof p.jcufn_approved === "number" ? p.jcufn_approved : null,
      lon: pos[0],
      lat: pos[1],
      family: familyOf(String(p["由来分類"] ?? "").trim()),
      shape: shapeOf(f.geometry),
    });
  }
  return out;
}

// ---- 描画 ------------------------------------------------------------------
let refDepth = 6000;
/** 背景（陸・輪郭・全地点の点）は静的なので一度だけ描いて使い回す */
let base: HTMLCanvasElement | null = null;

function rebuildBase() {
  base = document.createElement("canvas");
  base.width = canvas.width;
  base.height = canvas.height;
  const ctx = base.getContext("2d")!;
  map.drawBase(ctx);
  const dpr = map.dpr;

  // 海底谷の線・海山の輪郭をかすかに
  ctx.lineWidth = 0.8 * dpr;
  ctx.strokeStyle = "rgba(226, 238, 248, 0.07)";
  for (const f of features) {
    if (!f.shape) continue;
    ctx.beginPath();
    for (const line of f.shape) {
      line.forEach(([lon, lat], i) => {
        const [x, y] = map.toScreen(lon, lat);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }
    ctx.stroke();
  }

  // 全地点の点。色は水深（単一色相ランプ。深いほど明るい）
  ctx.globalCompositeOperation = "lighter";
  for (const f of features) {
    const [x, y] = map.toScreen(f.lon, f.lat);
    const [r, g, b] = speedColor(f.depth ?? 0, refDepth);
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${f.family ? 0.75 : 0.38})`;
    ctx.beginPath();
    ctx.arc(x, y, (f.family ? 1.5 : 1.0) * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

const FONT = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';

/** 縦書き（1文字ずつ下へ）。canvas に縦書きは無いので自前で並べる */
function drawVertical(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = size * 1.12;
  let i = 0;
  for (const ch of text) {
    ctx.fillText(ch, x, y + i * step);
    i++;
  }
}

function visibleNamed(): Feature[] {
  return active ? named.filter((f) => f.family === active) : named;
}

// 浮かび上がる名前（アニメーション時のみ）
interface Surfacing {
  f: Feature;
  t: number; // 経過秒
}
const surfacing: Surfacing[] = [];
const FADE_IN = 1.4, HOLD = 3.2, FADE_OUT = 1.8;
const LIFE = FADE_IN + HOLD + FADE_OUT;
let nextSurface = 0.6;

function surfaceAlpha(t: number): number {
  if (t < FADE_IN) return t / FADE_IN;
  if (t < FADE_IN + HOLD) return 1;
  return Math.max(0, 1 - (t - FADE_IN - HOLD) / FADE_OUT);
}

/** 系統を選んだときだけ、その一族の名前をすべて灯す（すべてを並べると南の海で重なって読めない） */
function drawNames(ctx: CanvasRenderingContext2D, ts: number, animate: boolean) {
  if (!active) return;
  const dpr = map.dpr;
  const size = 11 * dpr;
  // 密集した海山列では名前どうしが重なるので、先に置いた名前とぶつかるものは省く
  // （点は背景に残っており、ホバーで読める）
  const placed: [number, number, number, number][] = [];
  for (const f of visibleNamed()) {
    const [x, y] = map.toScreen(f.lon, f.lat);
    const len = [...f.name].length * size * 1.12;
    // 画面の下端からはみ出すときは点の上側へ書く
    const top = y + 4 * dpr + len > canvas.height - 24 * dpr ? y - 4 * dpr - len : y + 4 * dpr;
    const box: [number, number, number, number] = [x - size * 0.6, top, x + size * 0.6, top + len];
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    const breath = animate ? 0.5 + 0.5 * Math.sin(ts / 2600 + f.lon * 3.1 + f.lat) : 0.5;
    ctx.fillStyle = `rgba(127, 227, 224, ${0.55 + breath * 0.25})`;
    drawVertical(ctx, f.name, x, top, size);
  }
}

function drawSurfacing(ctx: CanvasRenderingContext2D) {
  const dpr = map.dpr;
  for (const s of surfacing) {
    const a = surfaceAlpha(s.t);
    const [x, y] = map.toScreen(s.f.lon, s.f.lat);
    const size = 15 * dpr, kanaSize = 8 * dpr;
    const len = Math.max([...s.f.name].length * size, [...s.f.kana].length * kanaSize) * 1.12;
    // 画面の下端からはみ出すときは点の上側へ書く
    const top = y + 6 * dpr + len > canvas.height - 24 * dpr ? y - 6 * dpr - len : y + 6 * dpr;
    ctx.fillStyle = `rgba(226, 238, 248, ${0.92 * a})`;
    drawVertical(ctx, s.f.name, x, top, size);
    // 右隣にかなを小さく
    ctx.fillStyle = `rgba(226, 238, 248, ${0.45 * a})`;
    drawVertical(ctx, s.f.kana, x + 13 * dpr, top, kanaSize);
  }
}

function drawHover(ctx: CanvasRenderingContext2D) {
  if (!hovered) return;
  const [x, y] = map.toScreen(hovered.lon, hovered.lat);
  ctx.strokeStyle = "rgba(127, 227, 224, 0.8)";
  ctx.lineWidth = 1 * map.dpr;
  ctx.beginPath();
  ctx.arc(x, y, 6 * map.dpr, 0, Math.PI * 2);
  ctx.stroke();
}

function frame(ts: number, dt: number) {
  const ctx = map.ctx;
  if (base) ctx.drawImage(base, 0, 0);
  else map.drawBase();
  const animate = dt > 0;

  if (animate) {
    // 数秒おきに、系統の名前をひとつ大きく浮かび上がらせる
    nextSurface -= dt;
    const pool = visibleNamed();
    if (nextSurface <= 0 && pool.length && surfacing.length < 3) {
      const f = pool[Math.floor(Math.random() * pool.length)];
      if (!surfacing.some((s) => s.f === f)) surfacing.push({ f, t: 0 });
      nextSurface = 2.2 + Math.random() * 1.6;
    }
    for (const s of surfacing) s.t += dt;
    for (let i = surfacing.length - 1; i >= 0; i--) {
      if (surfacing[i].t >= LIFE) surfacing.splice(i, 1);
    }
  }

  drawNames(ctx, ts, animate);
  if (animate) drawSurfacing(ctx);
  drawHover(ctx);
}

// ---- 操作 ------------------------------------------------------------------
let loop: AmbientLoop | null = null;
const redraw = () => loop?.redraw();

function buildChips() {
  chipsEl.textContent = "";
  const counts = new Map<Family, number>();
  for (const f of named) counts.set(f.family!, (counts.get(f.family!) ?? 0) + 1);
  const make = (label: string, fam: Family | null) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "filter-chip" + (active === fam ? " active" : "");
    b.textContent = label;
    b.setAttribute("aria-pressed", String(active === fam));
    b.addEventListener("click", () => {
      active = active === fam ? null : fam;
      surfacing.length = 0;
      nextSurface = 0.3;
      buildChips();
      updateCount();
      redraw();
    });
    chipsEl.appendChild(b);
  };
  make(`すべて ${named.length}`, null);
  for (const fam of [...FAMILIES, OTHER]) {
    const n = counts.get(fam);
    if (n) make(`${fam.label} ${n}`, fam);
  }
}

function drawLegend() {
  const ctx = legendCanvas.getContext("2d")!;
  const w = legendCanvas.width, h = legendCanvas.height;
  for (let x = 0; x < w; x++) {
    const [r, g, b] = speedColor((x / w) * refDepth, refDepth);
    ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.fillRect(x, 0, 1, h);
  }
  legendMax.textContent = `${Math.round(refDepth).toLocaleString()} m`;
}

function updateCount() {
  const fam = active
    ? `「${active.label}」の名 ${visibleNamed().length}`
    : `系統で名づけられた名 ${named.length} — 系統を選ぶと名前が灯る`;
  countEl.textContent = `海底地形名 ${features.length.toLocaleString()} ・ ${fam}`;
}

function nearest(cssX: number, cssY: number, maxCss: number): Feature | null {
  let best = Infinity;
  let hit: Feature | null = null;
  const px = cssX * map.dpr, py = cssY * map.dpr;
  for (const f of features) {
    const [x, y] = map.toScreen(f.lon, f.lat);
    const d = Math.hypot(x - px, y - py);
    if (d < best) { best = d; hit = f; }
  }
  return best < maxCss * map.dpr ? hit : null;
}

canvas.addEventListener("pointermove", (ev) => {
  const f = nearest(ev.clientX, ev.clientY, 12);
  if (f !== hovered) {
    hovered = f;
    redraw();
  }
  if (!f) {
    tooltip.classList.remove("visible");
    return;
  }
  const depth = f.depth != null ? ` ・ 水深 ${f.depth.toLocaleString()} m` : "";
  const year = f.year ? ` ・ ${f.year}年` : "";
  tooltip.textContent = `${f.name}（${f.kana}）${f.generic ? " ・ " + f.generic : ""}${depth}${year}` +
    (f.origin ? `\n由来: ${f.origin}` : "");
  tooltip.classList.add("visible");
  // 右端・下端ではみ出さないよう、カーソルの反対側へ出す
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  const left = ev.clientX + 14 + w > innerWidth ? ev.clientX - 14 - w : ev.clientX + 14;
  const top = ev.clientY + 14 + h > innerHeight ? ev.clientY - 14 - h : ev.clientY + 14;
  tooltip.style.left = `${Math.max(4, left)}px`;
  tooltip.style.top = `${Math.max(4, top)}px`;
});
canvas.addEventListener("pointerleave", () => {
  tooltip.classList.remove("visible");
  if (hovered) {
    hovered = null;
    redraw();
  }
});

window.addEventListener("resize", () => {
  map.resize();
  if (features.length) rebuildBase();
  redraw();
});

// ---- 起動 ------------------------------------------------------------------
async function boot() {
  statusEl.textContent = "海の底の名前を集めています…";
  try {
    const [layers] = await Promise.all([
      Promise.all([0, 1, 2].map((l) => fetchLayer(l))),
      map.init(),
    ]);
    features = layers.flat().filter((f) => f.name);
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  if (!features.length) {
    statusEl.textContent = "海底地形名のデータがありません";
    return;
  }
  statusEl.textContent = "";
  named = features.filter((f) => f.family);
  // 水深の色スケールは実データの上位（p95）で正規化（深い海溝に引っぱられないように）
  const depths = features.map((f) => f.depth).filter((d): d is number => d != null).sort((a, b) => a - b);
  if (depths.length) refDepth = depths[Math.floor(depths.length * 0.95)] || refDepth;
  buildChips();
  updateCount();
  drawLegend();
  rebuildBase();
  loop = ambientLoop(frame);
}

void boot();
