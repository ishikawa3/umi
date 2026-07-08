import "./style.css";
import { arcgisQuery } from "./api";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { mountNav } from "./nav";

mountNav("kuroshio");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const infoEl = document.getElementById("bulletin-info")!;
const tooltip = document.getElementById("tooltip")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

interface Stream {
  name: string; // 海流の種別
  emphasis: number; // 1=主役(黒潮), それ未満は淡く
  paths: [number, number][][]; // lon/lat
  date: string;
  issue: string;
}

interface Particle {
  path: number; // screenPaths内のindex
  s: number; // 弧長位置(px)
  v: number; // 速度(px/s)
  tail: number; // 尾の長さ(px)
  seg: number; // 現在のセグメントindex（単調前進のキャッシュ）
  bright: number; // 個体差 0..1
  off: number; // 流軸からの横ずれ(px)
}

interface ScreenPath {
  stream: Stream;
  pts: Float32Array; // x0,y0,x1,y1,...
  cum: Float32Array; // 累積弧長
  total: number;
}

let streams: Stream[] = [];
let screenPaths: ScreenPath[] = [];
let particles: Particle[] = [];

const LAYERS = [
  { layer: 6, emphasis: 1.0 }, // 黒潮
  { layer: 8, emphasis: 0.4 }, // 対馬暖流
  { layer: 9, emphasis: 0.4 }, // 宗谷暖流
];

/** "R8(2026)/06/23" → "2026/06/23" */
function parseEraDate(s: string): string {
  const m = /\((\d{4})\)\/(\d{2})\/(\d{2})/.exec(s ?? "");
  return m ? `${m[1]}/${m[2]}/${m[3]}` : (s ?? "");
}

/** "R8年第115号" → 115（比較用） */
function issueNumber(s: string): number {
  const m = /第(\d+)号/.exec(s ?? "");
  return m ? Number(m[1]) : -1;
}

async function fetchStream(layer: number, emphasis: number): Promise<Stream | null> {
  const gj = await arcgisQuery("quick-bulletin/v2", layer, JAPAN_BBOX);
  const fs: any[] = gj.features ?? [];
  if (!fs.length) return null;
  // 最新の速報号数だけを使う（過去号が混ざって返ることがある）
  const latest = Math.max(...fs.map((f) => issueNumber(f.properties["速報号数"])));
  const use = fs.filter((f) => issueNumber(f.properties["速報号数"]) === latest);
  const paths: [number, number][][] = [];
  for (const f of use) {
    const g = f.geometry;
    if (g.type === "LineString") paths.push(g.coordinates);
    else if (g.type === "MultiLineString") paths.push(...g.coordinates);
  }
  const p = use[0].properties;
  return {
    name: p["海流の種別"] ?? "海流",
    emphasis,
    paths,
    date: parseEraDate(p["解析対象日"]),
    issue: p["速報号数"] ?? "",
  };
}

function projectPaths() {
  screenPaths = [];
  for (const st of streams) {
    for (const path of st.paths) {
      if (path.length < 2) continue;
      const pts = new Float32Array(path.length * 2);
      const cum = new Float32Array(path.length);
      let total = 0;
      for (let i = 0; i < path.length; i++) {
        const [x, y] = map.toScreen(path[i][0], path[i][1]);
        pts[i * 2] = x;
        pts[i * 2 + 1] = y;
        if (i > 0) {
          total += Math.hypot(x - pts[i * 2 - 2], y - pts[i * 2 - 1]);
        }
        cum[i] = total;
      }
      if (total > 4) screenPaths.push({ stream: st, pts, cum, total });
    }
  }
}

function seedParticles() {
  particles = [];
  for (let pi = 0; pi < screenPaths.length; pi++) {
    const sp = screenPaths[pi];
    // 長さに比例した数（主役ほど濃く）
    const count = Math.max(2, Math.round((sp.total / 30) * (0.5 + sp.stream.emphasis)));
    for (let i = 0; i < count; i++) {
      particles.push({
        path: pi,
        s: Math.random() * sp.total,
        v: (26 + Math.random() * 30) * map.dpr,
        tail: (8 + Math.random() * 12) * map.dpr,
        seg: 0,
        bright: Math.random(),
        off: (Math.random() - 0.5) * 7 * map.dpr,
      });
    }
  }
}

/** 弧長sの位置。segは前回位置のキャッシュ（前進のみ想定） */
function posAt(sp: ScreenPath, s: number, segHint: number): [number, number, number] {
  let i = segHint;
  const n = sp.cum.length;
  if (s < sp.cum[i]) i = 0; // 巻き戻し（wrap）した場合
  while (i < n - 2 && sp.cum[i + 1] < s) i++;
  const segLen = sp.cum[i + 1] - sp.cum[i] || 1;
  const t = (s - sp.cum[i]) / segLen;
  return [
    sp.pts[i * 2] + (sp.pts[i * 2 + 2] - sp.pts[i * 2]) * t,
    sp.pts[i * 2 + 1] + (sp.pts[i * 2 + 3] - sp.pts[i * 2 + 1]) * t,
    i,
  ];
}

/** 背景（海＋陸＋基準線）の静止画。トレイルはこの画像へ向かってフェードする */
let base: HTMLCanvasElement | null = null;
function rebuildBase() {
  base = document.createElement("canvas");
  base.width = canvas.width;
  base.height = canvas.height;
  const bctx = base.getContext("2d")!;
  map.drawBase(bctx);
  drawBaseLines(bctx);
  // トレイルの初期化
  map.ctx.drawImage(base, 0, 0);
}

function drawBaseLines(ctx: CanvasRenderingContext2D) {
  ctx.globalCompositeOperation = "source-over";
  for (const sp of screenPaths) {
    ctx.strokeStyle = `rgba(127, 227, 224, ${0.05 + sp.stream.emphasis * 0.06})`;
    ctx.lineWidth = 1 * map.dpr;
    ctx.beginPath();
    ctx.moveTo(sp.pts[0], sp.pts[1]);
    for (let i = 1; i < sp.cum.length; i++) ctx.lineTo(sp.pts[i * 2], sp.pts[i * 2 + 1]);
    ctx.stroke();
  }
}

let lastTs = performance.now();
function tick(ts: number) {
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  const ctx = map.ctx;

  // 背景静止画へ向かって残像をフェードさせ、その上に粒子を重ねる
  if (base) {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.13;
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
    const sTail = Math.max(p.s - p.tail, 0);
    const [tx, ty] = posAt(sp, sTail, 0);
    // 流軸に対して垂直方向へ少しずらし、線ではなく「帯」に見せる
    const dx = hx - tx;
    const dy = hy - ty;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * p.off;
    const ny = (dx / len) * p.off;
    const e = sp.stream.emphasis;
    // 明るい個体は白波寄り、暗い個体はシアン
    const c = p.bright > 0.75 ? "216, 255, 244" : "127, 227, 224";
    ctx.strokeStyle = `rgba(${c}, ${(0.12 + p.bright * 0.32) * e + 0.04})`;
    ctx.lineWidth = (0.8 + p.bright * 1.2) * map.dpr * (0.6 + e * 0.4);
    ctx.beginPath();
    ctx.moveTo(tx + nx, ty + ny);
    ctx.lineTo(hx + nx, hy + ny);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  requestAnimationFrame(tick);
}

// ---- ホバー: 最寄りの流軸名を出す ------------------------------------
canvas.addEventListener("pointermove", (ev) => {
  const cx = ev.clientX * map.dpr;
  const cy = ev.clientY * map.dpr;
  let best = Infinity;
  let bestStream: Stream | null = null;
  for (const sp of screenPaths) {
    for (let i = 0; i < sp.cum.length - 1; i++) {
      // 線分との距離
      const ax = sp.pts[i * 2], ay = sp.pts[i * 2 + 1];
      const bx = sp.pts[i * 2 + 2], by = sp.pts[i * 2 + 3];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(cx - (ax + dx * t), cy - (ay + dy * t));
      if (d < best) {
        best = d;
        bestStream = sp.stream;
      }
    }
  }
  if (bestStream && best < 14 * map.dpr) {
    tooltip.classList.add("visible");
    tooltip.style.left = `${ev.clientX + 14}px`;
    tooltip.style.top = `${ev.clientY + 14}px`;
    tooltip.textContent = bestStream.name;
  } else {
    tooltip.classList.remove("visible");
  }
});
canvas.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));

window.addEventListener("resize", () => {
  map.resize();
  projectPaths();
  seedParticles();
  rebuildBase();
});

// ---- 起動 --------------------------------------------------------------
async function boot() {
  statusEl.textContent = "海流データ取得中…";
  try {
    const [results] = await Promise.all([
      Promise.allSettled(LAYERS.map((l) => fetchStream(l.layer, l.emphasis))),
      map.init(),
    ]);
    streams = results
      .filter((r): r is PromiseFulfilledResult<Stream | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((s): s is Stream => s !== null);
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  if (!streams.length) {
    statusEl.textContent = "海流データがありません";
    return;
  }
  statusEl.textContent = "";
  const kuro = streams.find((s) => s.name.includes("黒潮")) ?? streams[0];
  infoEl.textContent = `解析対象日 ${kuro.date}（${kuro.issue}）`;
  projectPaths();
  seedParticles();
  rebuildBase();
  requestAnimationFrame(tick);
}

void boot();
