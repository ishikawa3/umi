import "./style.css";
import { arcgisQuery } from "./api";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { mountNav } from "./nav";

mountNav("suji");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const infoEl = document.getElementById("cable-info")!;

const map = new JapanMap(canvas, JAPAN_BBOX);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface ScreenPath {
  pts: Float32Array; // x0,y0,x1,y1,...
  cum: Float32Array; // 累積弧長
  total: number;
}

interface Particle {
  path: number; // screenPaths内のindex
  s: number; // 弧長位置(px)
  v: number; // 速度(px/s)
  tail: number; // 尾の長さ(px)
  seg: number; // 現在セグメントのキャッシュ（前進のみ）
  bright: number; // 個体差 0..1
}

let cables: [number, number][][] = []; // lon/lat のポリライン群
let cableCount = 0; // 経路（フィーチャ）数
let screenPaths: ScreenPath[] = [];
let particles: Particle[] = [];

/** 海底ケーブル（layer 2 = polyline）を全ページ取得する。属性は OBJECTID のみ（名称なし）。 */
async function fetchCables(): Promise<{ lines: [number, number][][]; count: number }> {
  const lines: [number, number][][] = [];
  let count = 0;
  for (let page = 0; page < 8; page++) {
    const gj = await arcgisQuery("submarine-cable-line/v2", 2, JAPAN_BBOX, {
      outFields: "OBJECTID",
      resultOffset: String(page * 1000),
    });
    const fs: any[] = gj.features ?? [];
    for (const f of fs) {
      const g = f.geometry;
      if (!g) continue;
      count++;
      if (g.type === "LineString") lines.push(g.coordinates);
      else if (g.type === "MultiLineString") lines.push(...g.coordinates);
    }
    statusEl.textContent = `海底ケーブルを集めています… ${count}`;
    if (!gj.exceededTransferLimit) break;
  }
  return { lines, count };
}

function projectPaths() {
  screenPaths = [];
  for (const path of cables) {
    if (path.length < 2) continue;
    const pts = new Float32Array(path.length * 2);
    const cum = new Float32Array(path.length);
    let total = 0;
    for (let i = 0; i < path.length; i++) {
      const [x, y] = map.toScreen(path[i][0], path[i][1]);
      pts[i * 2] = x;
      pts[i * 2 + 1] = y;
      if (i > 0) total += Math.hypot(x - pts[i * 2 - 2], y - pts[i * 2 - 1]);
      cum[i] = total;
    }
    if (total > 4) screenPaths.push({ pts, cum, total });
  }
}

function seedParticles() {
  particles = [];
  let totalLen = 0;
  for (const sp of screenPaths) totalLen += sp.total;
  if (totalLen <= 0) return;
  // 全体で一定数の微光に抑える（経路数が多くても重くしない）。長い経路ほど多く灯る。
  const BUDGET = 2400;
  for (let pi = 0; pi < screenPaths.length; pi++) {
    const sp = screenPaths[pi];
    const count = Math.round((sp.total / totalLen) * BUDGET);
    for (let i = 0; i < count; i++) {
      particles.push({
        path: pi,
        s: Math.random() * sp.total,
        v: (10 + Math.random() * 16) * map.dpr,
        tail: (5 + Math.random() * 8) * map.dpr,
        seg: 0,
        bright: Math.random(),
      });
    }
  }
}

/** 弧長sの位置。segは前回位置のキャッシュ（前進のみ想定） */
function posAt(sp: ScreenPath, s: number, segHint: number): [number, number, number] {
  let i = segHint;
  const n = sp.cum.length;
  if (s < sp.cum[i]) i = 0; // wrap
  while (i < n - 2 && sp.cum[i + 1] < s) i++;
  const segLen = sp.cum[i + 1] - sp.cum[i] || 1;
  const t = (s - sp.cum[i]) / segLen;
  return [
    sp.pts[i * 2] + (sp.pts[i * 2 + 2] - sp.pts[i * 2]) * t,
    sp.pts[i * 2 + 1] + (sp.pts[i * 2 + 3] - sp.pts[i * 2 + 1]) * t,
    i,
  ];
}

/** 背景（海＋陸＋ケーブル網）の静止画。トレイルはこの画像へ向かってフェードする */
let base: HTMLCanvasElement | null = null;
function rebuildBase() {
  base = document.createElement("canvas");
  base.width = canvas.width;
  base.height = canvas.height;
  const bctx = base.getContext("2d")!;
  map.drawBase(bctx);
  drawBaseLines(bctx);
  map.ctx.drawImage(base, 0, 0);
}

function drawBaseLines(ctx: CanvasRenderingContext2D) {
  // lighter 合成の淡い線。陸揚げ地点などケーブルが集まる所ほど自然に明るく滲む。
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = "rgba(127, 227, 224, 0.05)";
  ctx.lineWidth = 1 * map.dpr;
  for (const sp of screenPaths) {
    ctx.beginPath();
    ctx.moveTo(sp.pts[0], sp.pts[1]);
    for (let i = 1; i < sp.cum.length; i++) ctx.lineTo(sp.pts[i * 2], sp.pts[i * 2 + 1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

let lastTs = performance.now();
function tick(ts: number) {
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  const ctx = map.ctx;

  // 背景静止画へ向かって残像をフェードさせ、その上に微光を重ねる
  if (base) {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.12;
    ctx.drawImage(base, 0, 0);
    ctx.globalAlpha = 1;
  }

  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const p of particles) {
    const sp = screenPaths[p.path];
    p.s += p.v * dt;
    if (p.s > sp.total) {
      p.s = 0;
      p.seg = 0;
    }
    const [hx, hy, seg] = posAt(sp, p.s, p.seg);
    p.seg = seg;
    const [tx, ty] = posAt(sp, Math.max(p.s - p.tail, 0), 0);
    // 明るい個体はわずかに白波寄り、それ以外はシアン
    const c = p.bright > 0.82 ? "216, 255, 244" : "127, 227, 224";
    ctx.strokeStyle = `rgba(${c}, ${0.06 + p.bright * 0.26})`;
    ctx.lineWidth = (0.6 + p.bright * 1.0) * map.dpr;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  requestAnimationFrame(tick);
}

window.addEventListener("resize", () => {
  map.resize();
  projectPaths();
  rebuildBase();
  if (!reducedMotion) seedParticles();
});

// ---- 起動 --------------------------------------------------------------
async function boot() {
  statusEl.textContent = "海底ケーブルを集めています…";
  try {
    const [res] = await Promise.all([fetchCables(), map.init()]);
    cables = res.lines;
    cableCount = res.count;
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  if (!cables.length) {
    statusEl.textContent = "海底ケーブルデータがありません";
    return;
  }
  statusEl.textContent = "";
  infoEl.textContent = `日本近海の海底ケーブル ${cableCount.toLocaleString()} 経路`;
  projectPaths();
  rebuildBase();
  if (reducedMotion) return; // アニメなし: ケーブル網の静止画のみ
  seedParticles();
  requestAnimationFrame(tick);
}

void boot();
