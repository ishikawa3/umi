import "./style.css";
import {
  fetchAreas, fetchCurrents, fetchContours,
  type Area, type CurrentSample,
} from "./api";
import { VectorField } from "./field";
import { buildLandMask, type LandMask } from "./landmask";
import { mountNav } from "./nav";

mountNav("nagare");
import { FlowRenderer, speedColor } from "./render";
import { TIME_SPAN_BACK_H, TIME_SPAN_FWD_H, TIME_STEP_MIN } from "./config";

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const areaChips = document.getElementById("area-chips")!;
const areaTitle = document.getElementById("area-title")!;
const areaSub = document.getElementById("area-sub")!;
const timeSlider = document.getElementById("time-slider") as HTMLInputElement;
const timeLabel = document.getElementById("time-label")!;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const shareBtn = document.getElementById("share") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const legendCanvas = document.getElementById("legend-ramp") as HTMLCanvasElement;
const legendMax = document.getElementById("legend-max")!;
const tooltip = document.getElementById("tooltip")!;
const drawerToggle = document.getElementById("drawer-toggle") as HTMLButtonElement;
const drawerOverlay = document.getElementById("drawer-overlay")!;
const drawerEl = document.getElementById("area-drawer")!;
const kbHint = document.getElementById("kb-hint")!;

// prefers-reduced-motion
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const renderer = new FlowRenderer(canvas, reducedMotion);

// ---- 時間軸 ----------------------------------------------------------
const STEP_MS = TIME_STEP_MIN * 60_000;
const now = new Date();
now.setMinutes(Math.floor(now.getMinutes() / TIME_STEP_MIN) * TIME_STEP_MIN, 0, 0);
const t0 = now.getTime() - TIME_SPAN_BACK_H * 3600_000;
const steps = ((TIME_SPAN_BACK_H + TIME_SPAN_FWD_H) * 60) / TIME_STEP_MIN;
timeSlider.min = "0";
timeSlider.max = String(steps);
timeSlider.value = String((TIME_SPAN_BACK_H * 60) / TIME_STEP_MIN);

const stepToDate = (s: number) => new Date(t0 + s * STEP_MS);
const fmtJst = (d: Date) => {
  const j = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}.${p(j.getUTCMonth() + 1)}.${p(j.getUTCDate())} ` +
    `${p(j.getUTCHours())}:${p(j.getUTCMinutes())} JST`;
};

// ---- 状態 ------------------------------------------------------------
let areas: Area[] = [];
let currentArea: Area | null = null;
let playing = true;
/** 再生ヘッド（step単位・小数）。整数間を補間して描く */
let head = Number(timeSlider.value);
const fieldCache = new Map<string, VectorField>();
const inflight = new Map<string, Promise<VectorField>>();
let epoch = 0; // 海域切替の世代（古いfetch結果を捨てる）

function fieldKey(area: Area, step: number) {
  return `${area.code}:${step}`;
}

async function loadField(area: Area, step: number): Promise<VectorField> {
  const key = fieldKey(area, Math.round(step));
  const cached = fieldCache.get(key);
  if (cached) return cached;
  let p = inflight.get(key);
  if (!p) {
    p = fetchCurrents(area.code, stepToDate(Math.round(step)))
      .then((samples: CurrentSample[]) => {
        const f = new VectorField(samples);
        fieldCache.set(key, f);
        inflight.delete(key);
        return f;
      })
      .catch((e) => {
        inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
  }
  return p;
}

async function applyHead() {
  if (!currentArea) return;
  const myEpoch = epoch;
  const s0 = Math.floor(head);
  const s1 = Math.min(s0 + 1, steps);
  try {
    statusEl.textContent = fieldCache.has(fieldKey(currentArea, s0)) ? "" : "潮流データ取得中…";
    const fa = await loadField(currentArea, s0);
    if (myEpoch !== epoch) return;
    renderer.setFields(fa, fieldCache.get(fieldKey(currentArea, s1)) ?? null, head - s0);
    statusEl.textContent = "";
    updateLegend();
    if (reducedMotion) renderer.frame(0);
    // 次のフレームを先読み
    void loadField(currentArea, s1).then(() => {
      if (myEpoch !== epoch || !currentArea) return;
      const f0 = fieldCache.get(fieldKey(currentArea, Math.floor(head)));
      const f1 = fieldCache.get(fieldKey(currentArea, Math.min(Math.floor(head) + 1, steps)));
      if (f0) {
        renderer.setFields(f0, f1 ?? null, head - Math.floor(head));
        if (reducedMotion) renderer.frame(0);
      }
    });
  } catch (e) {
    if (myEpoch === epoch) statusEl.textContent = "データ取得に失敗しました（再試行します）";
  }
  timeLabel.textContent = fmtJst(stepToDate(head));
}

function updateLegend() {
  const maxKt = renderer.refKt;
  const ctx = legendCanvas.getContext("2d")!;
  const w = legendCanvas.width;
  const h = legendCanvas.height;
  for (let x = 0; x < w; x++) {
    const [r, g, b] = speedColor((x / w) * maxKt, maxKt);
    ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.fillRect(x, 0, 1, h);
  }
  legendMax.textContent = `${maxKt.toFixed(1)} kt`;
}

// ---- 海域切替 --------------------------------------------------------
const maskCache = new Map<string, LandMask | null>();
async function loadMask(area: Area): Promise<LandMask | null> {
  if (maskCache.has(area.code)) return maskCache.get(area.code)!;
  const mask = await buildLandMask(area.bbox);
  maskCache.set(area.code, mask);
  return mask;
}

async function selectArea(area: Area) {
  epoch++;
  currentArea = area;
  areaTitle.textContent = area.nameJa;
  areaSub.textContent = area.nameEn;
  for (const el of areaChips.children) {
    el.classList.toggle("active", (el as HTMLElement).dataset.code === area.code);
  }
  // ドロワー内チップも同期
  for (const el of drawerEl.querySelectorAll(".chip")) {
    (el as HTMLElement).classList.toggle("active", (el as HTMLElement).dataset.code === area.code);
  }
  // B-1: URLハッシュを更新して共有・リロード後も同じ海域を開く
  history.replaceState(null, "", `#${area.code}`);
  statusEl.textContent = "潮流データ取得中…";
  const myEpoch = epoch;
  const [contours, mask] = await Promise.all([
    fetchContours(area.bbox).catch(() => []),
    loadMask(area),
  ]);
  if (myEpoch !== epoch) return;
  renderer.setArea(area, contours, mask);
  await applyHead();
}

// ---- UI --------------------------------------------------------------
timeSlider.addEventListener("input", () => {
  head = Number(timeSlider.value);
  void applyHead();
});

function togglePlay() {
  playing = !playing;
  playBtn.textContent = playing ? "❚❚" : "▶";
  playBtn.setAttribute("aria-label", playing ? "一時停止" : "再生");
}

playBtn.addEventListener("click", togglePlay);

// B-3: スクリーンショット/共有
shareBtn.addEventListener("click", async () => {
  // 現在時刻と海域名をcanvasに重ねて書き出す
  const tmp = document.createElement("canvas");
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const tc = tmp.getContext("2d")!;
  tc.drawImage(canvas, 0, 0);
  const label = currentArea ? `${currentArea.nameJa}  ${timeLabel.textContent ?? ""}` : (timeLabel.textContent ?? "");
  tc.font = `${14 * renderer.dpr}px "Hiragino Mincho ProN", serif`;
  tc.fillStyle = "rgba(226,238,248,0.75)";
  tc.fillText(label, 20 * renderer.dpr, tmp.height - 20 * renderer.dpr);
  tmp.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], "umi.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "うみ — 潮流のかたち" }).catch(() => {/* cancel */});
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "umi.png";
      a.click();
      URL.revokeObjectURL(url);
    }
  }, "image/png");
});

// E-1: ドロワー開閉
function openDrawer() {
  drawerEl.classList.add("open");
  drawerOverlay.classList.add("visible");
  drawerToggle.setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  drawerEl.classList.remove("open");
  drawerOverlay.classList.remove("visible");
  drawerToggle.setAttribute("aria-expanded", "false");
}
drawerToggle.addEventListener("click", () => {
  drawerEl.classList.contains("open") ? closeDrawer() : openDrawer();
});
drawerOverlay.addEventListener("click", closeDrawer);

// B-2: キーボードショートカット
// 初回5秒でヒントを非表示
setTimeout(() => kbHint.classList.add("hidden"), 5000);
window.addEventListener("keydown", (ev) => {
  // テキスト入力中は無視
  const tag = (ev.target as Element)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (ev.key === " ") {
    ev.preventDefault();
    togglePlay();
  } else if (ev.key === "ArrowRight") {
    ev.preventDefault();
    head = Math.min(Number(timeSlider.value) + 1, steps);
    timeSlider.value = String(head);
    void applyHead();
  } else if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    head = Math.max(Number(timeSlider.value) - 1, 0);
    timeSlider.value = String(head);
    void applyHead();
  }
});

canvas.addEventListener("pointermove", (ev) => {
  const probe = renderer.probe(ev.clientX, ev.clientY);
  if (!probe) {
    tooltip.classList.remove("visible");
    return;
  }
  tooltip.classList.add("visible");
  tooltip.style.left = `${ev.clientX + 14}px`;
  tooltip.style.top = `${ev.clientY + 14}px`;
  tooltip.textContent = `${probe.kt.toFixed(2)} kt / ${Math.round(probe.dir)}°`;
});
canvas.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));

window.addEventListener("resize", () => {
  renderer.resize();
  if (reducedMotion) renderer.frame(0);
});

// ---- メインループ ----------------------------------------------------
let lastTs = performance.now();
function tick(ts: number) {
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  if (playing && currentArea) {
    // 実時間1秒 ≈ 潮流3分。30分刻み1コマ ≈ 10秒
    const prev = head;
    head = Math.min(head + dt / 10, steps);
    if (head >= steps) head = 0;
    if (Math.floor(head) !== Math.floor(prev)) {
      void applyHead();
    } else {
      renderer.setLerp(head - Math.floor(head));
      timeLabel.textContent = fmtJst(stepToDate(head));
      timeSlider.value = String(head);
    }
  }
  renderer.frame(dt);
  requestAnimationFrame(tick);
}
// ---- 起動 ------------------------------------------------------------
async function boot() {
  statusEl.textContent = "海域一覧を取得中…";
  try {
    areas = await fetchAreas();
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  for (const a of areas) {
    // デスクトップ用チップ
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.dataset.code = a.code;
    chip.textContent = a.nameJa;
    chip.addEventListener("click", () => void selectArea(a));
    areaChips.appendChild(chip);
    // E-1: ドロワー用チップ
    const dc = document.createElement("button");
    dc.className = "chip";
    dc.dataset.code = a.code;
    dc.textContent = a.nameJa;
    dc.addEventListener("click", () => { void selectArea(a); closeDrawer(); });
    drawerEl.appendChild(dc);
  }
  // B-1: URLハッシュから初期海域を選ぶ（なければ来島海峡 S01）
  const hashCode = location.hash.slice(1);
  const initial = areas.find((a) => a.code === hashCode)
    ?? areas.find((a) => a.code === "S01")
    ?? areas[0];
  await selectArea(initial);
  if (!reducedMotion) requestAnimationFrame(tick);
  else {
    // reduced motion: アニメなしで1枚だけ描画
    renderer.frame(0);
  }
}

void boot();
