import "./style.css";
import {
  fetchTideStations, fetchTideDay, toMsilDate,
  type TideStation, type TideDay,
} from "./api";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { speedColor } from "./render";
import { moonAge, tideName, drawMoon } from "./moon";
import { mountNav } from "./nav";

mountNav("shiodoki");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const titleEl = document.getElementById("station-title")!;
const subEl = document.getElementById("station-sub")!;
const timeSlider = document.getElementById("time-slider") as HTMLInputElement;
const timeLabel = document.getElementById("time-label")!;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const tooltip = document.getElementById("tooltip")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

const MINUTES = 1440;
timeSlider.min = "0";
timeSlider.max = String(MINUTES - 1);

let stations: TideStation[] = [];
let shown: TideStation[] = []; // 間引き後の表示地点
const tideCache = new Map<string, TideDay>();
let selected: TideStation | null = null;
let head = 0; // 現在時刻（分, 0..1439, 小数可）
let playing = true;
const dateStr = toMsilDate(new Date()); // 今日（JST）固定

// ---- データ取得 --------------------------------------------------------
/** 全国313地点を緯度経度グリッドで約60点に間引く */
function thinStations(all: TideStation[]): TideStation[] {
  const cell = 1.15; // 度
  const picked = new Map<string, TideStation>();
  for (const s of all) {
    const key = `${Math.floor(s.lon / cell)},${Math.floor(s.lat / cell)}`;
    if (!picked.has(key)) picked.set(key, s);
  }
  let out = [...picked.values()];
  if (out.length > 72) {
    const step = out.length / 72;
    out = Array.from({ length: 72 }, (_, i) => out[Math.floor(i * step)]);
  }
  return out;
}

async function loadTide(s: TideStation): Promise<TideDay | null> {
  const hit = tideCache.get(s.code);
  if (hit) return hit;
  try {
    const d = await fetchTideDay(s.code, dateStr);
    if (d.tide.length) tideCache.set(s.code, d);
    return d.tide.length ? d : null;
  } catch {
    return null;
  }
}

/** 表示地点の潮位をまとめて取得（12件ずつのバッチで429を避ける） */
async function loadAll() {
  for (let i = 0; i < shown.length; i += 12) {
    await Promise.all(shown.slice(i, i + 12).map(loadTide));
    statusEl.textContent = i + 12 < shown.length ? `潮位データ取得中… ${Math.min(i + 12, shown.length)}/${shown.length}` : "";
  }
  statusEl.textContent = "";
}

// ---- 描画 --------------------------------------------------------------
function tideAt(d: TideDay, minute: number): number {
  const idx = Math.min(Math.floor((minute / MINUTES) * d.tide.length), d.tide.length - 1);
  return d.tide[idx];
}

/** 当日のmin/maxで0..1に正規化（地点間の絶対値比較は無意味なため） */
function normTide(d: TideDay, minute: number): number {
  return (tideAt(d, minute) - d.min) / (d.max - d.min || 1);
}

function fmtMinute(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = Math.floor(minute % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function drawStations() {
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  for (const s of shown) {
    const d = tideCache.get(s.code);
    if (!d) continue;
    const t = normTide(d, head);
    const [x, y] = map.toScreen(s.lon, s.lat);
    const [r, g, b] = speedColor(t, 1);
    const rad = (1.6 + 3.6 * t) * map.dpr;
    // 外側のにじみ＋芯
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.10 + t * 0.12})`;
    ctx.beginPath();
    ctx.arc(x, y, rad * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.45 + t * 0.45})`;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    if (selected?.code === s.code) {
      ctx.strokeStyle = "rgba(226, 238, 248, 0.8)";
      ctx.lineWidth = 1 * map.dpr;
      ctx.beginPath();
      ctx.arc(x, y, rad + 5 * map.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

/** 選択地点の1日の潮位曲線（画面下部に直接描く） */
function drawCurve() {
  if (!selected) return;
  const d = tideCache.get(selected.code);
  if (!d) return;
  const ctx = map.ctx;
  const W = canvas.width;
  const H = canvas.height;
  const x0 = W * 0.08;
  const x1 = W * 0.92;
  const y0 = H * 0.72;
  const y1 = H * 0.9;
  const X = (minute: number) => x0 + (minute / (MINUTES - 1)) * (x1 - x0);
  const Y = (cm: number) => {
    const t = (cm - d.min) / (d.max - d.min || 1);
    return y1 - t * (y1 - y0);
  };

  // 読みやすさのための淡い下地（枠は描かない）
  const grad = ctx.createLinearGradient(0, y0 - H * 0.06, 0, H);
  grad.addColorStop(0, "rgba(4, 7, 15, 0)");
  grad.addColorStop(0.35, "rgba(4, 7, 15, 0.6)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, y0 - H * 0.06, W, H - y0 + H * 0.06);

  // 曲線
  ctx.strokeStyle = "rgba(127, 227, 224, 0.85)";
  ctx.lineWidth = 1.5 * map.dpr;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(d.tide.length / (x1 - x0)));
  for (let i = 0; i < d.tide.length; i += step) {
    const px = X((i / d.tide.length) * MINUTES);
    const py = Y(d.tide[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // 満潮・干潮の極値ラベル
  ctx.fillStyle = "rgba(226, 238, 248, 0.55)";
  ctx.font = `${10.5 * map.dpr}px "Hiragino Mincho ProN", serif`;
  ctx.textAlign = "center";
  for (const ex of extrema(d.tide)) {
    const minute = (ex.i / d.tide.length) * MINUTES;
    const px = X(minute);
    const py = Y(d.tide[ex.i]);
    // 画面下端に近い干潮ラベルはクレジットと重なるため点の上へ逃がす
    const below = ex.kind === "low" && py + 20 * map.dpr < H * 0.93;
    ctx.fillText(`${fmtMinute(minute)}  ${d.tide[ex.i]}cm`, px, py + (below ? 14 : -8) * map.dpr);
  }

  // 現在時刻の点
  const cx = X(head);
  const cy = Y(tideAt(d, head));
  ctx.fillStyle = "rgba(216, 255, 244, 0.4)";
  ctx.beginPath();
  ctx.arc(cx, cy, 6 * map.dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d8fff4";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.4 * map.dpr, 0, Math.PI * 2);
  ctx.fill();
}

interface Extremum { i: number; kind: "high" | "low"; }
/** ±90分の窓で極値（満潮・干潮）を探す */
function extrema(tide: number[]): Extremum[] {
  const out: Extremum[] = [];
  const win = Math.round((90 / MINUTES) * tide.length);
  for (let i = 0; i < tide.length; i++) {
    const lo = Math.max(0, i - win);
    const hi = Math.min(tide.length - 1, i + win);
    let isMax = true;
    let isMin = true;
    for (let j = lo; j <= hi; j++) {
      if (tide[j] > tide[i]) isMax = false;
      if (tide[j] < tide[i]) isMin = false;
      if (!isMax && !isMin) break;
    }
    // 平坦部の連続検出を避ける（直前の極値から窓幅以上離す）
    const last = out[out.length - 1];
    if ((isMax || isMin) && (!last || i - last.i > win)) {
      out.push({ i, kind: isMax ? "high" : "low" });
    }
  }
  return out;
}

let lastTs = performance.now();
function tick(ts: number) {
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  if (playing) {
    head += dt * 3; // 実時間1秒 = 潮汐3分（潮流ページと同じ速度感）
    if (head >= MINUTES) head = 0;
    timeSlider.value = String(Math.floor(head));
  }
  timeLabel.textContent = `${dateStr.slice(0, 4)}.${dateStr.slice(4, 6)}.${dateStr.slice(6)} ${fmtMinute(head)} JST`;
  map.drawBase();
  drawStations();
  drawCurve();
  requestAnimationFrame(tick);
}

// ---- UI ----------------------------------------------------------------
function nearestStation(cssX: number, cssY: number, maxCss: number): TideStation | null {
  let best = Infinity;
  let hit: TideStation | null = null;
  for (const s of shown) {
    const [x, y] = map.toScreen(s.lon, s.lat);
    const d = Math.hypot(x - cssX * map.dpr, y - cssY * map.dpr);
    if (d < best) {
      best = d;
      hit = s;
    }
  }
  return best < maxCss * map.dpr ? hit : null;
}

canvas.addEventListener("click", async (ev) => {
  const s = nearestStation(ev.clientX, ev.clientY, 24);
  if (!s) return;
  selected = s;
  titleEl.textContent = s.nameJa;
  subEl.textContent = s.nameEn;
  if (!tideCache.get(s.code)) {
    statusEl.textContent = "潮位データ取得中…";
    await loadTide(s);
    statusEl.textContent = "";
  }
});

canvas.addEventListener("pointermove", (ev) => {
  // 地点の上では地点名、（地点がなければ）曲線の帯では時刻と潮位を出す
  const s = nearestStation(ev.clientX, ev.clientY, 16);
  const d = selected ? tideCache.get(selected.code) : undefined;
  const yCss = ev.clientY * map.dpr;
  if (!s && d && yCss > canvas.height * 0.7) {
    const x0 = canvas.width * 0.08;
    const x1 = canvas.width * 0.92;
    const t = (ev.clientX * map.dpr - x0) / (x1 - x0);
    if (t >= 0 && t <= 1) {
      const minute = t * (MINUTES - 1);
      tooltip.classList.add("visible");
      tooltip.style.left = `${ev.clientX + 14}px`;
      tooltip.style.top = `${ev.clientY - 30}px`;
      tooltip.textContent = `${fmtMinute(minute)}  潮位 ${tideAt(d, minute)} cm`;
      return;
    }
  }
  if (s) {
    const sd = tideCache.get(s.code);
    tooltip.classList.add("visible");
    tooltip.style.left = `${ev.clientX + 14}px`;
    tooltip.style.top = `${ev.clientY + 14}px`;
    tooltip.textContent = sd ? `${s.nameJa}  ${tideAt(sd, head)} cm` : s.nameJa;
  } else {
    tooltip.classList.remove("visible");
  }
});
canvas.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));

timeSlider.addEventListener("input", () => {
  head = Number(timeSlider.value);
});
playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "❚❚" : "▶";
});
window.addEventListener("resize", () => map.resize());

function drawLegend() {
  const ctx = legendCanvas.getContext("2d")!;
  for (let x = 0; x < legendCanvas.width; x++) {
    const [r, g, b] = speedColor(x / legendCanvas.width, 1);
    ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.fillRect(x, 0, 1, legendCanvas.height);
  }
}

// ---- 起動 --------------------------------------------------------------
async function boot() {
  statusEl.textContent = "検潮地点を取得中…";
  try {
    [stations] = await Promise.all([fetchTideStations(), map.init()]);
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  shown = thinStations(stations);
  // 現在時刻（JST）から開始
  const now = new Date(Date.now() + 9 * 3600_000);
  head = now.getUTCHours() * 60 + now.getUTCMinutes();
  timeSlider.value = String(Math.floor(head));
  drawLegend();
  // 月齢と潮名（潮汐は月が起こす）
  const age = moonAge(new Date());
  drawMoon(document.getElementById("moon") as HTMLCanvasElement, age);
  document.getElementById("moon-label")!.textContent = `月齢 ${age.toFixed(1)} ・ ${tideName(age)}`;
  requestAnimationFrame(tick);
  await loadAll();
}

void boot();
