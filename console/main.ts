// かいしょう / KAISHŌ VTS Console
//   フェーズ14: 土台（3D海図＋UIシェル）
//   フェーズ15: 航行警報レイヤ（ピン／一覧／種別フィルタ／インスペクタ／ティッカー）
//   フェーズ16: 海況レイヤ（潮流の3D粒子＋波浪ヒートマップ／レイヤトグル／凡例）
//
// データ層は うみ本体の src/api.ts を共有する（PLAN4 0.1）。

import "./style.css";
import { fetchAreas, fetchNavWarnings, fetchCurrents, fetchWaves, type Area } from "../src/api";
import { VectorField } from "../src/field";
import { TIME_SPAN_BACK_H, TIME_SPAN_FWD_H, TIME_STEP_MIN } from "../src/config";
import { formatJst } from "../src/time";
import { Globe } from "./scene";
import { WarningsLayer, CATEGORIES, toConsoleWarnings, type ConsoleWarning } from "./warnings";
import { WavesLayer } from "./waves";
import { CurrentsLayer, compass8 } from "./currents";

const JAPAN_BBOX: [number, number, number, number] = [122, 24, 148, 46];

const $ = (id: string) => document.getElementById(id)!;
const chartEl = $("chart");
const clockEl = $("clock");
const ledEl = $("conn-led");
const connTextEl = $("conn-text");
const coordEl = $("st-coord");
const zoomEl = $("st-zoom");
const countEl = $("st-count");
const inspectorEl = $("inspector-body");
const tickerEl = $("ticker");
const warnCountEl = $("warn-count");
const warningListEl = $("warning-list");
const filterListEl = $("filter-list");
const warnFilterSection = $("warn-filter-section");
const areaSection = $("area-section");
const areaSelect = $("area-select") as HTMLSelectElement;
const legendSection = $("legend-section");
const legendEl = $("legend");
const timeCtl = $("time-ctl");
const timeSlider = $("time-slider") as HTMLInputElement;
const timeLabel = $("time-label");
const timePlayBtn = $("time-play") as HTMLButtonElement;
const tooltip = $("tooltip");

// ---- 3D 海図とレイヤ -----------------------------------------------------
const globe = new Globe(chartEl);
globe.start();
window.addEventListener("resize", () => globe.resize());

const warnings = new WarningsLayer(globe);
const waves = new WavesLayer(globe);
const currents = new CurrentsLayer(globe);

// ---- 時間軸（潮流用。config を流用） ------------------------------------
const STEP_MS = TIME_STEP_MIN * 60_000;
const now = new Date();
now.setMinutes(Math.floor(now.getMinutes() / TIME_STEP_MIN) * TIME_STEP_MIN, 0, 0);
const t0 = now.getTime() - TIME_SPAN_BACK_H * 3600_000;
const steps = ((TIME_SPAN_BACK_H + TIME_SPAN_FWD_H) * 60) / TIME_STEP_MIN;
let head = (TIME_SPAN_BACK_H * 60) / TIME_STEP_MIN;
timeSlider.min = "0";
timeSlider.max = String(steps);
timeSlider.value = String(head);
// 判定・表示・取得はすべて Math.round(head) の整数ステップで統一する（丸めの不整合回避）
const roundStep = () => Math.round(head);
const stepDate = (step: number) => new Date(t0 + step * STEP_MS);
function stepLabel(step: number): void {
  timeLabel.textContent = formatJst(stepDate(step)); // 他画面と同じ書式に統一
}

// ---- ズーム表示 ----------------------------------------------------------
function updateZoomReadout(): void {
  const d = globe.cameraDistance;
  const z = Math.round((1 - (d - 1.2) / (4.2 - 1.2)) * 100);
  zoomEl.textContent = `ズーム ${Math.max(0, Math.min(100, z))}`;
}
updateZoomReadout();

// ---- JST 時計 ------------------------------------------------------------
const jstFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
function tickClock(): void {
  clockEl.textContent = `${jstFmt.format(new Date()).replace(/\//g, "-")} JST`;
}
tickClock();
setInterval(tickClock, 1000);

// ---- レイヤパネル --------------------------------------------------------
let rowByVisibleIndex: (HTMLElement | undefined)[] = [];

interface LayerDef {
  key: string; label: string; phase: string;
  live?: boolean; checked?: boolean;
  onToggle?: (v: boolean) => void;
}
const LAYERS: LayerDef[] = [
  { key: "warnings", label: "航行警報", phase: "P15", live: true, checked: true,
    onToggle: (v) => { warnings.setVisible(v); warnFilterSection.hidden = !v; } },
  { key: "currents", label: "潮流", phase: "P16", live: true,
    onToggle: (v) => {
      currents.setVisible(v);
      areaSection.hidden = !v;
      timeCtl.hidden = !v;
      updateLegend();
      if (v) void ensureCurrents();
    } },
  { key: "waves", label: "波浪", phase: "P16", live: true,
    onToggle: (v) => { waves.setVisible(v); updateLegend(); if (v) void ensureWaves(); } },
  { key: "tide", label: "検潮所", phase: "P17" },
  { key: "traffic", label: "通航量", phase: "P18" },
];
function buildLayerPanel(): void {
  const list = $("layer-list");
  list.textContent = "";
  for (const l of LAYERS) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!l.checked;
    cb.disabled = !l.live;
    if (l.live && l.onToggle) cb.addEventListener("change", () => l.onToggle!(cb.checked));
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = l.label;
    const tag = document.createElement("span");
    tag.className = "layer-tag";
    tag.textContent = l.live ? "稼働" : l.phase;
    row.append(cb, name, tag);
    list.appendChild(row);
  }
}
buildLayerPanel();

// ---- 凡例（アクティブなレイヤに追従） ------------------------------------
function legendBar(label: string, cLow: string, cHigh: string, lo: string, hi: string): string {
  return `<div class="lg-row"><div class="lg-label">${label}</div>` +
    `<div class="lg-bar" style="background:linear-gradient(90deg, ${cLow}, ${cHigh})"></div>` +
    `<div class="lg-ticks"><span>${lo}</span><span>${hi}</span></div></div>`;
}
function updateLegend(): void {
  const parts: string[] = [];
  if (currents.isVisible()) parts.push(legendBar("流速 kt", "#a7d8d2", "#ffffff", "0", currents.refSpeed().toFixed(1)));
  if (waves.isVisible()) {
    const r = waves.range();
    parts.push(legendBar("有義波高 m", "#3f9f9a", "#f4fbfa", r.lo.toFixed(1), r.hi.toFixed(1)));
  }
  legendSection.hidden = parts.length === 0;
  legendEl.innerHTML = parts.join("");
}

// ---- 種別フィルタ（航行警報） -------------------------------------------
function buildFilterChips(): void {
  filterListEl.textContent = "";
  const active = warnings.activeFilter();
  const all = document.createElement("button");
  all.className = "filter-chip" + (active === null ? " active" : "");
  all.textContent = `全件 ${warnings.total()}`;
  all.addEventListener("click", () => { warnings.setFilter(null); refreshAfterFilter(); });
  filterListEl.appendChild(all);
  for (const cat of CATEGORIES) {
    const count = warnings.countByCategory(cat.key);
    if (!count) continue;
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (active === cat.key ? " active" : "");
    chip.style.setProperty("--chip-color", cat.color);
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.background = cat.color;
    chip.append(dot, document.createTextNode(`${cat.label} ${count}`));
    chip.addEventListener("click", () => {
      warnings.setFilter(active === cat.key ? null : cat.key);
      refreshAfterFilter();
    });
    filterListEl.appendChild(chip);
  }
}
function refreshAfterFilter(): void {
  buildFilterChips();
  buildWarningList();
}

// ---- 航行警報 一覧・インスペクタ ----------------------------------------
function splitName(name: string): { code: string; subject: string } {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(name.trim());
  return m ? { code: m[1], subject: m[2] } : { code: "", subject: name };
}
function buildWarningList(): void {
  const vis = warnings.visibleWarnings();
  const order = vis.map((w, i) => ({ w, i })).sort((a, b) => b.w.num - a.w.num);
  warningListEl.textContent = "";
  rowByVisibleIndex = [];
  warnCountEl.textContent = `${vis.length}件`;
  for (const { w, i } of order) {
    const row = document.createElement("button");
    row.className = "warn-row";
    row.dataset.vindex = String(i);
    const dot = document.createElement("span");
    dot.className = "warn-dot";
    dot.style.background = w.category.color;
    const label = document.createElement("span");
    label.className = "warn-label";
    label.textContent = splitName(w.name).subject || w.name;
    row.append(dot, label);
    row.addEventListener("pointerenter", () => warnings.highlight(i));
    row.addEventListener("pointerleave", () => warnings.highlight(-1));
    row.addEventListener("click", () => openInspector(w));
    warningListEl.appendChild(row);
    rowByVisibleIndex[i] = row;
  }
}
function field(label: string, value: string, mono = false): HTMLElement {
  const el = document.createElement("div");
  el.className = "insp-field";
  const k = document.createElement("div");
  k.className = "insp-k";
  k.textContent = label;
  const v = document.createElement("div");
  v.className = "insp-v" + (mono ? " mono" : "");
  v.textContent = value;
  el.append(k, v);
  return el;
}
function openInspector(w: ConsoleWarning): void {
  const { code, subject } = splitName(w.name);
  const ns = w.lat >= 0 ? "N" : "S";
  const ew = w.lon >= 0 ? "E" : "W";
  const pos = `${Math.abs(w.lat).toFixed(3)}°${ns} ${Math.abs(w.lon).toFixed(3)}°${ew}`;
  inspectorEl.textContent = "";
  inspectorEl.classList.add("has-detail");
  const tag = document.createElement("span");
  tag.className = "insp-cat";
  tag.style.setProperty("--chip-color", w.category.color);
  tag.textContent = w.category.label;
  inspectorEl.append(tag);
  if (code) inspectorEl.append(field("警報番号", code, true));
  inspectorEl.append(field("件名", subject || "—"));
  inspectorEl.append(field("位置", pos, true));
  inspectorEl.append(field("電文", w.body || "（本文なし）", true));
}
warnings.onHighlight((index) => {
  for (const row of rowByVisibleIndex) row?.classList.remove("hot");
  if (index >= 0) {
    const row = rowByVisibleIndex[index];
    if (row) { row.classList.add("hot"); row.scrollIntoView({ block: "nearest" }); }
  }
});

// ---- 海況データの遅延ロード --------------------------------------------
let currentArea: Area | null = null;
let areasList: Area[] = [];
let currentsInit = false;
let wavesInit = false;
let currentStep = roundStep(); // いま読み込み中／表示中の整数ステップ
let loadEpoch = 0; // 非同期取得の世代（古い結果で上書きしないための番兵）
const fieldCache = new Map<string, VectorField>();

async function loadField(area: Area, step: number): Promise<VectorField> {
  const key = `${area.code}:${step}`;
  const cached = fieldCache.get(key);
  if (cached) return cached;
  const samples = await fetchCurrents(area.code, stepDate(step));
  const f = new VectorField(samples);
  fieldCache.set(key, f);
  return f;
}
/** currentArea / currentStep の場を取得して反映。await 後に状態が変わっていたら破棄。 */
async function applyStep(): Promise<void> {
  const area = currentArea;
  const step = currentStep;
  if (!area) return;
  const myEpoch = ++loadEpoch;
  try {
    const f = await loadField(area, step);
    // 解決後、まだ最新の要求（同世代・同海域・同ステップ）である場合のみ反映
    if (myEpoch !== loadEpoch || currentArea !== area || currentStep !== step) return;
    currents.setField(f);
    updateLegend();
  } catch { /* 取得失敗時は前の場のまま */ }
}
async function selectArea(area: Area): Promise<void> {
  currentArea = area;
  currents.setArea(area);
  currentStep = roundStep();
  stepLabel(currentStep);
  await applyStep();
}
async function ensureCurrents(): Promise<void> {
  if (currentsInit) return;
  currentsInit = true;
  timeLabel.textContent = "取得中…";
  try {
    areasList = await fetchAreas();
    areaSelect.innerHTML = "";
    for (const a of areasList) {
      const o = document.createElement("option");
      o.value = a.code;
      o.textContent = a.nameJa;
      areaSelect.appendChild(o);
    }
    const init = areasList.find((a) => a.code === "S01") ?? areasList[0];
    if (init) { areaSelect.value = init.code; await selectArea(init); }
  } catch {
    currentsInit = false; // 再試行を許す
    timeLabel.textContent = "潮流取得失敗";
  }
}
async function ensureWaves(): Promise<void> {
  if (wavesInit) return;
  wavesInit = true;
  try {
    waves.setData(await fetchWaves(JAPAN_BBOX));
    updateLegend();
  } catch { wavesInit = false; }
}

areaSelect.addEventListener("change", () => {
  const a = areasList.find((x) => x.code === areaSelect.value);
  if (a) void selectArea(a);
});
timeSlider.addEventListener("input", () => {
  head = Number(timeSlider.value);
  const step = roundStep();
  stepLabel(step);
  // 丸め後のステップが変わったときだけ取得（ドラッグ中の同一ステップ多発を防ぐ）
  if (step !== currentStep) {
    currentStep = step;
    void applyStep();
  }
});

// ---- 時刻の再生 ----------------------------------------------------------
let timePlaying = true;
timePlayBtn.addEventListener("click", () => {
  timePlaying = !timePlaying;
  timePlayBtn.textContent = timePlaying ? "❚❚" : "▶";
});

// ---- 毎フレーム（粒子更新＋時刻送り） -----------------------------------
let lastMs = performance.now();
globe.onFrame((ms) => {
  const dt = Math.min((ms - lastMs) / 1000, 0.1);
  lastMs = ms;
  if (timePlaying && currents.isVisible() && currentArea) {
    head += dt / 10; // 実時間10秒 ≈ 1コマ（30分）
    if (head >= steps) head = 0;
    timeSlider.value = String(head);
    const step = roundStep();
    stepLabel(step); // 表示は常に丸めステップに一致
    // 判定・取得も同じ丸めステップで（floor/round の不整合を解消）
    if (step !== currentStep) {
      currentStep = step;
      void applyStep();
    }
  }
  currents.update(dt);
});

// ---- 海図のポインタ操作 --------------------------------------------------
function showTip(x: number, y: number, text: string): void {
  tooltip.textContent = text;
  tooltip.style.left = `${x + 14}px`;
  tooltip.style.top = `${y + 14}px`;
  tooltip.classList.add("visible");
}
function hideTip(): void { tooltip.classList.remove("visible"); }

chartEl.addEventListener("pointermove", (ev) => {
  const idx = warnings.pickAt(ev.clientX, ev.clientY);
  warnings.highlight(idx);

  const ll = globe.latLonAtPointer(ev.clientX, ev.clientY);
  if (ll) {
    const ns = ll.lat >= 0 ? "N" : "S";
    const ew = ll.lon >= 0 ? "E" : "W";
    coordEl.textContent = `緯経 ${Math.abs(ll.lat).toFixed(2)}°${ns} ${Math.abs(ll.lon).toFixed(2)}°${ew}`;
  } else {
    coordEl.textContent = "緯経 —";
  }
  updateZoomReadout();

  if (idx >= 0) {
    showTip(ev.clientX, ev.clientY, splitName(warnings.visibleWarnings()[idx].name).subject);
    chartEl.style.cursor = "pointer";
    return;
  }
  let tip = "";
  if (ll) {
    if (currents.isVisible()) {
      const r = currents.readoutAt(ll.lat, ll.lon);
      if (r) tip = `流速 ${r.kt.toFixed(2)} kt ・ ${compass8(r.dir)}`;
    }
    if (!tip && waves.isVisible()) {
      const r = waves.readoutAt(ll.lat, ll.lon);
      if (r) tip = `有義波高 ${r.height.toFixed(2)} m`;
    }
  }
  if (tip) { showTip(ev.clientX, ev.clientY, tip); chartEl.style.cursor = "crosshair"; }
  else { hideTip(); chartEl.style.cursor = "grab"; }
});
chartEl.addEventListener("pointerleave", () => {
  warnings.highlight(-1);
  hideTip();
  coordEl.textContent = "緯経 —";
});
chartEl.addEventListener("click", (ev) => {
  const idx = warnings.pickAt(ev.clientX, ev.clientY);
  if (idx >= 0) openInspector(warnings.visibleWarnings()[idx]);
});

// ---- 警報ティッカー ------------------------------------------------------
function buildTicker(list: ConsoleWarning[]): void {
  const heads = [...list].sort((a, b) => b.num - a.num).slice(0, 30)
    .map((w) => splitName(w.name).subject || w.name);
  if (!heads.length) { tickerEl.textContent = "有効な航行警報はありません"; return; }
  const text = heads.join("　·　");
  tickerEl.innerHTML = "";
  const inner = document.createElement("span");
  inner.className = "ticker-inner";
  inner.textContent = text + "　·　" + text + "　·　";
  tickerEl.appendChild(inner);
}

// ---- 接続ステータス ------------------------------------------------------
function setConn(state: "checking" | "ok" | "down", detail: string): void {
  ledEl.dataset.state = state;
  connTextEl.textContent = detail;
}

// ---- 起動（航行警報を先に。海況はトグルで遅延ロード） --------------------
async function boot(): Promise<void> {
  setConn("checking", "海しる 接続確認中…");
  tickerEl.textContent = "航行警報を取得中…";
  try {
    const list = toConsoleWarnings(await fetchNavWarnings(JAPAN_BBOX));
    warnings.setData(list);
    buildFilterChips();
    buildWarningList();
    buildTicker(list);
    setConn("ok", `海しる 接続良好・警報 ${list.length}`);
    countEl.textContent = `警報 ${list.length}件`;
    inspectorEl.textContent = "対象未選択 — 海図のピンか一覧から警報を選ぶと電文を表示します";
  } catch {
    setConn("down", "海しる 未接続");
    countEl.textContent = "警報 —";
    tickerEl.textContent = "航行警報を取得できませんでした";
    inspectorEl.textContent = "対象未選択";
  }
}
void boot();
