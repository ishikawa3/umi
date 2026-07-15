import "./style.css";
import { fetchWaves, type WaveSample } from "./api";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { speedColor } from "./render";
import { mountNav } from "./nav";

mountNav("nami");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const waveMetaEl = document.getElementById("wave-meta")!;
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const legendMax = document.getElementById("legend-max")!;
const tooltip = document.getElementById("tooltip")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

// 波高の目安最大値 [m]（色スケール上限）
const MAX_HEIGHT_M = 6;

let samples: WaveSample[] = [];

// 現在時刻（JST）を6時間刻みに丸める
function getBaseTime(): Date {
  const now = new Date(Date.now() + 9 * 3600_000);
  const h = now.getUTCHours();
  const snapped = Math.floor(h / 6) * 6;
  now.setUTCHours(snapped, 0, 0, 0);
  return new Date(now.getTime() - 9 * 3600_000); // back to UTC
}

function fmtJst(d: Date): string {
  const j = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}.${p(j.getUTCMonth() + 1)}.${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())} JST`;
}

// ---- 描画 ----------------------------------------------------------------
function drawWaves() {
  map.drawBase();
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  for (const s of samples) {
    const [x, y] = map.toScreen(s.lon, s.lat);
    const [r, g, b] = speedColor(s.height, MAX_HEIGHT_M);
    const t = Math.min(s.height / MAX_HEIGHT_M, 1);
    const rad = (1.4 + 4.2 * t) * map.dpr;
    // 外側のにじみ
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.08 + t * 0.10})`;
    ctx.beginPath();
    ctx.arc(x, y, rad * 2.2, 0, Math.PI * 2);
    ctx.fill();
    // 芯
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.4 + t * 0.45})`;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    // 波向き矢印（波が来る方向）
    if (s.height > 0.3) {
      const rad2 = (s.dir * Math.PI) / 180;
      const len = (3 + t * 6) * map.dpr;
      // 波の進行方向（波向きの逆）
      const dx = Math.sin(rad2) * len;
      const dy = -Math.cos(rad2) * len;
      ctx.strokeStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.3 + t * 0.35})`;
      ctx.lineWidth = (0.8 + t * 0.8) * map.dpr;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - dx * 0.5, y - dy * 0.5);
      ctx.lineTo(x + dx * 0.5, y + dy * 0.5);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawLegend() {
  const ctx = legendCanvas.getContext("2d")!;
  for (let x = 0; x < legendCanvas.width; x++) {
    const [r, g, b] = speedColor((x / legendCanvas.width) * MAX_HEIGHT_M, MAX_HEIGHT_M);
    ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.fillRect(x, 0, 1, legendCanvas.height);
  }
  legendMax.textContent = `${MAX_HEIGHT_M} m`;
}

// ---- UI -----------------------------------------------------------------
canvas.addEventListener("pointermove", (ev) => {
  if (!samples.length) { tooltip.classList.remove("visible"); return; }
  const cx = ev.clientX * map.dpr;
  const cy = ev.clientY * map.dpr;
  let best = Infinity;
  let bestS: WaveSample | null = null;
  for (const s of samples) {
    const [x, y] = map.toScreen(s.lon, s.lat);
    const d = Math.hypot(x - cx, y - cy);
    if (d < best) { best = d; bestS = s; }
  }
  if (bestS && best < 24 * map.dpr) {
    tooltip.classList.add("visible");
    tooltip.style.left = `${ev.clientX + 14}px`;
    tooltip.style.top = `${ev.clientY + 14}px`;
    tooltip.textContent = `波高 ${bestS.height.toFixed(1)} m  波向 ${Math.round(bestS.dir)}°`;
  } else {
    tooltip.classList.remove("visible");
  }
});
canvas.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));
window.addEventListener("resize", () => { map.resize(); drawWaves(); });

// ---- 起動 ---------------------------------------------------------------
async function boot() {
  statusEl.textContent = "波浪データ取得中…";
  try {
    await map.init();
    const base = getBaseTime();
    const result = await fetchWaves(JAPAN_BBOX);
    if (!result.length) {
      statusEl.textContent = "波浪データがありません";
      return;
    }
    samples = result;
    statusEl.textContent = "";
    const maxH = Math.max(...result.map((s) => s.height));
    waveMetaEl.textContent = `最大有義波高 ${maxH.toFixed(1)} m（解析時刻: ${fmtJst(base)}）`;
    drawLegend();
    drawWaves();
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
  }
}

void boot();

