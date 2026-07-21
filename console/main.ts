// かいしょう / KAISHŌ VTS Console
//   フェーズ14: 土台（3D海図＋UIシェル）
//   フェーズ15: 航行警報レイヤ（ピン／一覧／種別フィルタ／インスペクタ／ティッカー）
//   フェーズ16: 海況レイヤ（潮流の3D粒子＋波浪ヒートマップ／レイヤトグル／凡例）
//
// データ層は うみ本体の src/api.ts を共有する（PLAN4 0.1）。

import "./style.css";
import {
  fetchAreas, fetchNavWarnings, fetchCurrents, fetchWaves,
  fetchTideStations, fetchTideDay, type Area, type TideStation,
} from "../src/api";
import { VectorField } from "../src/field";
import { TIME_SPAN_BACK_H, TIME_SPAN_FWD_H, TIME_STEP_MIN } from "../src/config";
import { formatJst } from "../src/time";
import { Globe } from "./scene";
import { WarningsLayer, CATEGORIES, toConsoleWarnings, type ConsoleWarning } from "./warnings";
import { WavesLayer } from "./waves";
import { CurrentsLayer, compass8 } from "./currents";
import { TideLayer, tideAt, tideNorm, type TideEntry } from "./tide";
import { TrafficLayer } from "./traffic";
import { latLonToVec3, projectToScreen, isFacingCamera } from "./geo";

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
const rpTabs = $("rp-tabs");
const tideTableEl = $("tide-table");
const tideCountEl = $("tide-count");
const tideNameEl = $("tide-name");
const tideHiloEl = $("tide-hilo");
const tideCurveEl = $("tide-curve") as HTMLCanvasElement;

// ---- 3D 海図とレイヤ -----------------------------------------------------
const globe = new Globe(chartEl);
globe.start();
window.addEventListener("resize", () => globe.resize());

const warnings = new WarningsLayer(globe);
const waves = new WavesLayer(globe);
const currents = new CurrentsLayer(globe);
const tide = new TideLayer(globe);
const traffic = new TrafficLayer(globe);

// ---- クラスタ表示（ズームで密集地点の件数バブルが出る） ------------------
const clusterEl = document.createElement("div");
clusterEl.className = "cluster-overlay";
chartEl.appendChild(clusterEl);
const CLUSTER_PX = 30; // この画面距離内のマーカーを1グループに束ねる

/** いま地図に出ているマーカーの世界座標と色を集める */
function currentMarkers(): { v: ReturnType<typeof latLonToVec3>; color: string }[] {
  const out: { v: ReturnType<typeof latLonToVec3>; color: string }[] = [];
  if (warnings.isVisible()) for (const w of warnings.visibleWarnings()) out.push({ v: latLonToVec3(w.lat, w.lon, 1.02), color: w.category.color });
  if (tide.isVisible()) for (const e of tideEntries) out.push({ v: latLonToVec3(e.station.lat, e.station.lon, 1.02), color: "#5ee0d8" });
  return out;
}
/** マーカーを画面上で束ね、2件以上のかたまりに件数バブルを出す */
function renderClusters(): void {
  const rect = globe.renderer.domElement.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  const pts: { x: number; y: number; color: string }[] = [];
  for (const m of currentMarkers()) {
    if (!isFacingCamera(m.v, globe.camera)) continue; // 地球の裏側は除外
    const s = projectToScreen(m.v, globe.camera, W, H);
    if (s) pts.push({ x: s.x, y: s.y, color: m.color });
  }
  const used = new Array(pts.length).fill(false);
  clusterEl.textContent = "";
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    let sx = pts[i].x, sy = pts[i].y, n = 1; used[i] = true;
    for (let j = i + 1; j < pts.length; j++) {
      if (used[j]) continue;
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < CLUSTER_PX) { sx += pts[j].x; sy += pts[j].y; n++; used[j] = true; }
    }
    if (n < 2) continue; // 単独マーカーはそのまま（3Dピンが見える）
    const bub = document.createElement("div");
    bub.className = "cluster-bubble";
    bub.textContent = String(n);
    bub.style.left = `${sx / n}px`;
    bub.style.top = `${sy / n}px`;
    clusterEl.appendChild(bub);
  }
}
let lastCluster = 0;
globe.onFrame((ms) => {
  if (ms - lastCluster < 120) return; // 約8fpsに間引き
  lastCluster = ms;
  renderClusters();
});

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
    onToggle: (v) => { warnings.setVisible(v); warnFilterSection.hidden = !v; updateRightTabs(v ? "warnings" : null); } },
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
  { key: "tide", label: "検潮所", phase: "P17", live: true,
    onToggle: (v) => { tide.setVisible(v); updateRightTabs(v ? "tide" : null); if (v) void ensureTide(); } },
  { key: "traffic", label: "通航量", phase: "P18", live: true,
    onToggle: (v) => { traffic.setVisible(v); updateLegend(); if (v) void ensureTraffic(); } },
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

// ---- 右パネルのタブ（航行警報 / 検潮所） --------------------------------
type RightTab = "warnings" | "tide";
const RIGHT_PANELS: { key: RightTab; label: string; el: string; visible: () => boolean }[] = [
  { key: "warnings", label: "航行警報", el: "rp-warnings", visible: () => warnings.isVisible() },
  { key: "tide", label: "検潮所", el: "rp-tide", visible: () => tide.isVisible() },
];
let activeTab: RightTab | null = "warnings";

/** レイヤのON/OFFに応じて右パネルのタブを再構成。prefer を最前面にする */
function updateRightTabs(prefer: RightTab | null): void {
  const avail = RIGHT_PANELS.filter((p) => p.visible());
  if (prefer && avail.some((p) => p.key === prefer)) activeTab = prefer;
  if (!avail.some((p) => p.key === activeTab)) activeTab = avail[0]?.key ?? null;

  rpTabs.textContent = "";
  rpTabs.hidden = avail.length <= 1;
  for (const p of avail) {
    const btn = document.createElement("button");
    btn.className = "rp-tab" + (p.key === activeTab ? " active" : "");
    btn.textContent = p.label;
    btn.setAttribute("aria-pressed", String(p.key === activeTab));
    btn.addEventListener("click", () => { activeTab = p.key; updateRightTabs(p.key); });
    rpTabs.appendChild(btn);
  }
  for (const p of RIGHT_PANELS) {
    ($(p.el) as HTMLElement).hidden = p.key !== activeTab || !p.visible();
  }
}
updateRightTabs("warnings"); // 初期状態（航行警報のみ表示）を反映

// ---- 凡例（アクティブなレイヤに追従） ------------------------------------
function legendBar(label: string, cLow: string, cHigh: string, lo: string, hi: string): string {
  return `<div class="lg-row"><div class="lg-label">${label}</div>` +
    `<div class="lg-bar" style="background:linear-gradient(90deg, ${cLow}, ${cHigh})"></div>` +
    `<div class="lg-ticks"><span>${lo}</span><span>${hi}</span></div></div>`;
}
function updateLegend(): void {
  const parts: string[] = [];
  if (currents.isVisible()) parts.push(legendBar("流速 kt", "#2f7d84", "#eafffd", "0", currents.refSpeed().toFixed(1)));
  if (waves.isVisible()) {
    const r = waves.range();
    parts.push(legendBar("有義波高 m", "#1f5a68", "#eafffb", r.lo.toFixed(1), r.hi.toFixed(1)));
  }
  if (traffic.isVisible()) parts.push(legendBar("通航量（4クラス）", "#1c5566", "#eafffd", "閑散", "過密"));
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
  } catch { wavesInit = false; showToast("波浪データを取得できませんでした"); }
}
let trafficInit = false;
async function ensureTraffic(): Promise<void> {
  if (trafficInit) return;
  trafficInit = true;
  try {
    const count = await traffic.load();
    updateLegend();
    if (count === 0) showToast("通航量データがありません");
  } catch { trafficInit = false; showToast("通航量データを取得できませんでした"); }
}

// ---- 検潮所（フェーズ17） -----------------------------------------------
let tideInit = false;
let tideEntries: TideEntry[] = [];
let tideSort: "name" | "level" | "trend" = "level";
let tideSelected = -1;
const MINUTES = 1440;

function jstNow(): Date { return new Date(Date.now() + 9 * 3600_000); }
function jstMinute(): number { const n = jstNow(); return n.getUTCHours() * 60 + n.getUTCMinutes(); }
function jstDateStr(): string {
  const n = jstNow();
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return p(n.getUTCFullYear(), 4) + p(n.getUTCMonth() + 1) + p(n.getUTCDate());
}
function fmtMinute(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = Math.floor(minute % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 全国の検潮所を緯度経度グリッドで代表局に間引く（負荷配慮） */
function thinStations(all: TideStation[], cap = 60): TideStation[] {
  const cell = 1.2;
  const picked = new Map<string, TideStation>();
  for (const s of all) {
    const key = `${Math.floor(s.lon / cell)},${Math.floor(s.lat / cell)}`;
    if (!picked.has(key)) picked.set(key, s);
  }
  let out = [...picked.values()];
  if (out.length > cap) {
    const step = out.length / cap;
    out = Array.from({ length: cap }, (_, i) => out[Math.floor(i * step)]);
  }
  return out;
}

async function ensureTide(): Promise<void> {
  if (tideInit) return;
  tideInit = true;
  tideCountEl.textContent = "取得中…";
  try {
    const all = await fetchTideStations();
    const shown = thinStations(all);
    const date = jstDateStr();
    tideEntries = shown.map((station) => ({ station, day: null }));
    tide.setData(tideEntries);
    // 12件ずつのバッチで当日潮位を取得（429を避ける）
    for (let i = 0; i < tideEntries.length; i += 12) {
      const batch = tideEntries.slice(i, i + 12);
      await Promise.all(batch.map(async (e) => {
        try { const d = await fetchTideDay(e.station.code, date); if (d.tide.length) e.day = d; } catch { /* skip */ }
      }));
      tide.refresh(jstMinute());
      buildTideTable();
      tideCountEl.textContent = i + 12 < tideEntries.length
        ? `取得中 ${Math.min(i + 12, tideEntries.length)}/${tideEntries.length}` : `${tideEntries.length}局`;
    }
    tide.refresh(jstMinute());
    buildTideTable();
  } catch {
    tideInit = false;
    tideCountEl.textContent = "取得失敗";
  }
}

function tideTrend(e: TideEntry, minute: number): number {
  if (!e.day) return 0;
  return tideAt(e.day, minute) - tideAt(e.day, Math.max(0, minute - 10));
}

function buildTideTable(): void {
  const minute = jstMinute();
  const rows = tideEntries.map((e, i) => ({
    e, i,
    cm: e.day ? tideAt(e.day, minute) : null,
    norm: e.day ? tideNorm(e.day, minute) : -1,
    trend: tideTrend(e, minute),
  }));
  rows.sort((a, b) => {
    if (tideSort === "name") return a.e.station.nameJa.localeCompare(b.e.station.nameJa, "ja");
    if (tideSort === "trend") return b.trend - a.trend;
    return b.norm - a.norm; // level: 正規化潮位の高い順
  });

  tideTableEl.textContent = "";
  const header = document.createElement("div");
  header.className = "tide-row tide-head";
  for (const [key, label] of [["name", "検潮所"], ["level", "潮位"], ["trend", "増減"]] as const) {
    const c = document.createElement("button");
    c.className = "tide-cell th" + (tideSort === key ? " sorted" : "");
    c.textContent = label;
    c.addEventListener("click", () => { tideSort = key; buildTideTable(); });
    header.appendChild(c);
  }
  tideTableEl.appendChild(header);

  tideRowByEntry = [];
  for (const r of rows) {
    const row = document.createElement("button");
    row.className = "tide-row" + (r.i === tideSelected ? " hot" : "");
    row.dataset.eindex = String(r.i);
    const name = document.createElement("span");
    name.className = "tide-cell name";
    name.textContent = r.e.station.nameJa;
    const lvl = document.createElement("span");
    lvl.className = "tide-cell num";
    lvl.textContent = r.cm == null ? "—" : `${r.cm}cm`;
    const tr = document.createElement("span");
    tr.className = "tide-cell num";
    tr.textContent = r.cm == null ? "" : r.trend > 1 ? "↑" : r.trend < -1 ? "↓" : "→";
    tr.style.color = r.trend > 1 ? "#5ee0d8" : r.trend < -1 ? "#f0b64e" : "var(--fg-dim)";
    row.append(name, lvl, tr);
    row.addEventListener("pointerenter", () => tide.highlight(r.i));
    row.addEventListener("pointerleave", () => tide.highlight(-1));
    row.addEventListener("click", () => selectTide(r.i));
    tideTableEl.appendChild(row);
    tideRowByEntry[r.i] = row;
  }
}

let tideRowByEntry: (HTMLElement | undefined)[] = [];
tide.onHighlight((index) => {
  for (const row of tideRowByEntry) row?.classList.remove("hover");
  if (index >= 0) tideRowByEntry[index]?.classList.add("hover");
});

/** ±90分窓で満潮・干潮の極値を探す */
function tideExtrema(t: number[]): { i: number; kind: "high" | "low" }[] {
  const out: { i: number; kind: "high" | "low" }[] = [];
  const win = Math.round((90 / MINUTES) * t.length);
  for (let i = 0; i < t.length; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(t.length - 1, i + win);
    let isMax = true, isMin = true;
    for (let j = lo; j <= hi; j++) { if (t[j] > t[i]) isMax = false; if (t[j] < t[i]) isMin = false; if (!isMax && !isMin) break; }
    const last = out[out.length - 1];
    if ((isMax || isMin) && (!last || i - last.i > win)) out.push({ i, kind: isMax ? "high" : "low" });
  }
  return out;
}

function selectTide(index: number): void {
  tideSelected = index;
  for (const row of tideRowByEntry) row?.classList.remove("hot");
  tideRowByEntry[index]?.classList.add("hot");
  drawTideCurve();
}

function drawTideCurve(): void {
  const e = tideEntries[tideSelected];
  const ctx = tideCurveEl.getContext("2d")!;
  // 表示サイズ(CSS px)×DPR で描画バッファを合わせ、座標系はCSS pxに揃える（HiDPIでもぼやけない）
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = tideCurveEl.clientWidth || 300;
  const H = tideCurveEl.clientHeight || 120;
  const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (tideCurveEl.width !== bw || tideCurveEl.height !== bh) { tideCurveEl.width = bw; tideCurveEl.height = bh; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!e || !e.day) { tideNameEl.textContent = "検潮所を選択"; tideHiloEl.textContent = ""; return; }
  const d = e.day;
  tideNameEl.textContent = `${e.station.nameJa}　${e.station.nameEn}`;
  const pad = 6;
  const X = (min: number) => pad + (min / (MINUTES - 1)) * (W - pad * 2);
  const Y = (cm: number) => H - pad - ((cm - d.min) / (d.max - d.min || 1)) * (H - pad * 2);
  // グリッド（低コントラスト）
  ctx.strokeStyle = "rgba(110,150,180,0.18)";
  ctx.lineWidth = 1;
  for (let hh = 0; hh <= 24; hh += 6) { const x = X((hh / 24) * (MINUTES - 1)); ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, H - pad); ctx.stroke(); }
  // 潮位曲線
  ctx.strokeStyle = "#5ee0d8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(d.tide.length / (W * 2)));
  for (let i = 0; i < d.tide.length; i += step) {
    const px = X((i / d.tide.length) * MINUTES), py = Y(d.tide[i]);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  // 現在時刻マーカー
  const min = jstMinute();
  const cx = X(min), cy = Y(tideAt(d, min));
  ctx.fillStyle = "#eafffd";
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  // 満干潮ラベル
  const ex = tideExtrema(d.tide).map((x) => {
    const m = (x.i / d.tide.length) * MINUTES;
    return `${x.kind === "high" ? "満" : "干"} ${fmtMinute(m)} ${d.tide[x.i]}cm`;
  });
  tideHiloEl.textContent = `現在 ${tideAt(d, min)}cm　${ex.join("　")}`;
}

// 監視盤として毎分「現在潮位」を更新（棒の高さ・一覧・曲線マーカー）
let lastTideMinute = jstMinute();
setInterval(() => {
  if (!tide.isVisible() || !tideEntries.length) return;
  const m = jstMinute();
  if (m === lastTideMinute) return;
  lastTideMinute = m;
  tide.refresh(m);
  buildTideTable();
  if (tideSelected >= 0) drawTideCurve();
}, 5000);

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

const toastEl = $("toast");
let toastTimer = 0;
function showToast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("visible"), 4000);
}

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
  // 検潮所ピン（警報の次に優先）
  if (tide.isVisible()) {
    const ti = tide.pickAt(ev.clientX, ev.clientY);
    tide.highlight(ti);
    if (ti >= 0) {
      const e = tide.entryAt(ti);
      const cm = e?.day ? tideAt(e.day, jstMinute()) : null;
      showTip(ev.clientX, ev.clientY, e ? `${e.station.nameJa}${cm != null ? `　${cm} cm` : ""}` : "");
      chartEl.style.cursor = "pointer";
      return;
    }
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
    if (!tip && traffic.isVisible()) {
      const r = traffic.readoutAt(ll.lat, ll.lon);
      if (r) tip = `通航量 ${r}`;
    }
  }
  if (tip) { showTip(ev.clientX, ev.clientY, tip); chartEl.style.cursor = "crosshair"; }
  else { hideTip(); chartEl.style.cursor = "grab"; }
});
chartEl.addEventListener("pointerleave", () => {
  warnings.highlight(-1);
  tide.highlight(-1);
  hideTip();
  coordEl.textContent = "緯経 —";
});
chartEl.addEventListener("click", (ev) => {
  const idx = warnings.pickAt(ev.clientX, ev.clientY);
  if (idx >= 0) { openInspector(warnings.visibleWarnings()[idx]); return; }
  if (tide.isVisible()) {
    const ti = tide.pickAt(ev.clientX, ev.clientY);
    if (ti >= 0) { updateRightTabs("tide"); selectTide(ti); }
  }
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
