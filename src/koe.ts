import "./style.css";
import { arcgisQuery } from "./api";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { mountNav } from "./nav";

mountNav("koe");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const countEl = document.getElementById("koe-count")!;
const listEl = document.getElementById("warning-list")!;
const panel = document.getElementById("detail-panel") as HTMLElement;
const panelTitle = document.getElementById("panel-title")!;
const panelBody = document.getElementById("panel-body")!;
const panelClose = document.getElementById("panel-close")!;
const tooltip = document.getElementById("tooltip")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

interface Warning {
  name: string;
  body: string;
  lon: number;
  lat: number;
  num: number; // 警報番号（並び順用）
  seed: number; // 明滅の位相
}

let warnings: Warning[] = [];
let highlighted: Warning | null = null;

/** HTML混じりの電文をプレーンテキストへ */
function cleanDescription(html: string): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "06-260085 豊後水道、…" → 260085 */
function warningNumber(name: string): number {
  const m = /^\d{2}-(\d+)/.exec(name ?? "");
  return m ? Number(m[1]) : 0;
}

function centroid(geom: any): [number, number] | null {
  if (geom.type === "Point") return [geom.coordinates[0], geom.coordinates[1]];
  let ring: [number, number][] | null = null;
  if (geom.type === "Polygon") ring = geom.coordinates[0];
  else if (geom.type === "MultiPolygon") ring = geom.coordinates[0]?.[0];
  if (!ring?.length) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length];
}

async function fetchLayer(layer: number): Promise<Warning[]> {
  const out: Warning[] = [];
  // 1000件超に備えてページング
  for (let offset = 0; offset < 5000; offset += 1000) {
    const gj = await arcgisQuery("navigational-warnings/v2", layer, JAPAN_BBOX,
      offset ? { resultOffset: String(offset) } : {});
    for (const f of gj.features ?? []) {
      const c = centroid(f.geometry);
      if (!c) continue;
      const name = f.properties.name ?? "";
      out.push({
        name,
        body: cleanDescription(f.properties.description),
        lon: c[0],
        lat: c[1],
        num: warningNumber(name),
        seed: Math.random() * Math.PI * 2,
      });
    }
    if (!gj.exceededTransferLimit) break;
  }
  return out;
}

// ---- 描画 --------------------------------------------------------------
const AMBER = "232, 196, 104";

function tick(ts: number) {
  map.drawBase();
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  for (const w of warnings) {
    const [x, y] = map.toScreen(w.lon, w.lat);
    const hl = w === highlighted;
    const pulse = 0.5 + 0.5 * Math.sin(ts / 1400 + w.seed);
    const rad = (hl ? 4.2 : 2.0 + pulse * 0.7) * map.dpr;
    ctx.fillStyle = `rgba(${AMBER}, ${hl ? 0.28 : 0.08 + pulse * 0.05})`;
    ctx.beginPath();
    ctx.arc(x, y, rad * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${AMBER}, ${hl ? 0.95 : 0.4 + pulse * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    if (hl) {
      ctx.strokeStyle = `rgba(${AMBER}, 0.7)`;
      ctx.lineWidth = 1 * map.dpr;
      ctx.beginPath();
      ctx.arc(x, y, rad + 6 * map.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
  requestAnimationFrame(tick);
}

// ---- リストとの連動 ------------------------------------------------------
function openPanel(w: Warning) {
  panelTitle.textContent = w.name;
  panelBody.textContent = w.body;
  panel.hidden = false;
}

function buildList() {
  const items = [...warnings].sort((a, b) => b.num - a.num).slice(0, 20);
  listEl.textContent = "";
  for (const w of items) {
    const el = document.createElement("button");
    el.className = "warning-item";
    // "06-260085 豊後水道、灯台消灯" → 番号部を落として本文だけ
    el.textContent = w.name.replace(/^\S+\s*/, "");
    el.addEventListener("pointerenter", () => (highlighted = w));
    el.addEventListener("pointerleave", () => (highlighted = null));
    el.addEventListener("click", () => openPanel(w));
    listEl.appendChild(el);
  }
}

function nearestWarning(cssX: number, cssY: number, maxCss: number): Warning | null {
  let best = Infinity;
  let hit: Warning | null = null;
  for (const w of warnings) {
    const [x, y] = map.toScreen(w.lon, w.lat);
    const d = Math.hypot(x - cssX * map.dpr, y - cssY * map.dpr);
    if (d < best) {
      best = d;
      hit = w;
    }
  }
  return best < maxCss * map.dpr ? hit : null;
}

canvas.addEventListener("pointermove", (ev) => {
  const w = nearestWarning(ev.clientX, ev.clientY, 14);
  highlighted = w;
  if (w) {
    tooltip.classList.add("visible");
    tooltip.style.left = `${ev.clientX + 14}px`;
    tooltip.style.top = `${ev.clientY + 14}px`;
    tooltip.textContent = w.name.replace(/^\S+\s*/, "");
  } else {
    tooltip.classList.remove("visible");
  }
});
canvas.addEventListener("pointerleave", () => {
  tooltip.classList.remove("visible");
  highlighted = null;
});
canvas.addEventListener("click", (ev) => {
  const w = nearestWarning(ev.clientX, ev.clientY, 14);
  if (w) openPanel(w);
});
panelClose.addEventListener("click", () => (panel.hidden = true));
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") panel.hidden = true;
});
window.addEventListener("resize", () => map.resize());

// ---- 起動 --------------------------------------------------------------
async function boot() {
  statusEl.textContent = "航行警報を取得中…";
  try {
    const [pointsResult, polysResult] = await Promise.allSettled([
      fetchLayer(1),
      fetchLayer(3),
    ]).then((r) => r);
    warnings = [
      ...(pointsResult.status === "fulfilled" ? pointsResult.value : []),
      ...(polysResult.status === "fulfilled" ? polysResult.value : []),
    ];
    await map.init();
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  statusEl.textContent = "";
  countEl.textContent = `有効な警報 ${warnings.length}件`;
  buildList();
  requestAnimationFrame(tick);
}

void boot();
