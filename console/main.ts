// かいしょう / KAISHŌ VTS Console
//   フェーズ14: 土台（3D海図＋UIシェル）
//   フェーズ15: 航行警報レイヤ（ピン／一覧／種別フィルタ／インスペクタ／ティッカー）
//
// データ層は うみ本体の src/api.ts を共有する（PLAN4 0.1）。

import "./style.css";
import { Globe } from "./scene";
import { fetchAreas, fetchNavWarnings } from "../src/api";
import { WarningsLayer, CATEGORIES, toConsoleWarnings, type ConsoleWarning } from "./warnings";

// 航行警報の取得範囲（日本全域。src/japanmap.ts の JAPAN_BBOX と同値）
const JAPAN_BBOX: [number, number, number, number] = [122, 24, 148, 46];

const chartEl = document.getElementById("chart")!;
const clockEl = document.getElementById("clock")!;
const ledEl = document.getElementById("conn-led")!;
const connTextEl = document.getElementById("conn-text")!;
const coordEl = document.getElementById("st-coord")!;
const zoomEl = document.getElementById("st-zoom")!;
const countEl = document.getElementById("st-count")!;
const inspectorEl = document.getElementById("inspector-body")!;
const tickerEl = document.getElementById("ticker")!;
const warnCountEl = document.getElementById("warn-count")!;
const warningListEl = document.getElementById("warning-list")!;
const filterListEl = document.getElementById("filter-list")!;

// ---- 3D 海図 ------------------------------------------------------------
const globe = new Globe(chartEl);
globe.start();
window.addEventListener("resize", () => globe.resize());

const layer = new WarningsLayer(globe);

function updateZoomReadout(): void {
  const d = globe.cameraDistance;
  const z = Math.round((1 - (d - 1.2) / (4.2 - 1.2)) * 100);
  zoomEl.textContent = `ズーム ${Math.max(0, Math.min(100, z))}`;
}
updateZoomReadout();

// ---- JST 時計（毎秒更新） ------------------------------------------------
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

// ---- 状態 ----------------------------------------------------------------
// 一覧の表示順（番号降順）と layer.visibleWarnings() の index を対応づける
let rowByVisibleIndex: (HTMLElement | undefined)[] = [];

// ---- レイヤパネル（航行警報のみ稼働。他はフェーズ表示） --------------------
interface LayerDef { key: string; label: string; phase: string; live?: boolean }
const LAYERS: LayerDef[] = [
  { key: "warnings", label: "航行警報", phase: "P15", live: true },
  { key: "currents", label: "潮流", phase: "P16" },
  { key: "waves", label: "波浪", phase: "P16" },
  { key: "tide", label: "検潮所", phase: "P17" },
  { key: "traffic", label: "通航量", phase: "P18" },
];
function buildLayerPanel(): void {
  const list = document.getElementById("layer-list")!;
  list.textContent = "";
  for (const l of LAYERS) {
    const row = document.createElement("label");
    row.className = "layer-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!l.live;
    cb.disabled = !l.live;
    if (l.live) cb.addEventListener("change", () => layer.setVisible(cb.checked));
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

// ---- 種別フィルタ --------------------------------------------------------
function buildFilterChips(): void {
  filterListEl.textContent = "";
  const active = layer.activeFilter();

  const all = document.createElement("button");
  all.className = "filter-chip" + (active === null ? " active" : "");
  all.textContent = `全件 ${layer.total()}`;
  all.addEventListener("click", () => { layer.setFilter(null); refreshAfterFilter(); });
  filterListEl.appendChild(all);

  for (const cat of CATEGORIES) {
    const count = layer.countByCategory(cat.key);
    if (!count) continue;
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (active === cat.key ? " active" : "");
    chip.style.setProperty("--chip-color", cat.color);
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.background = cat.color;
    chip.append(dot, document.createTextNode(`${cat.label} ${count}`));
    chip.addEventListener("click", () => {
      layer.setFilter(active === cat.key ? null : cat.key);
      refreshAfterFilter();
    });
    filterListEl.appendChild(chip);
  }
}
function refreshAfterFilter(): void {
  buildFilterChips();
  buildWarningList();
}

// ---- 一覧テーブル --------------------------------------------------------
/** "06-260085 豊後水道、灯台消灯" → { code:"06-260085", subject:"豊後水道、灯台消灯" } */
function splitName(name: string): { code: string; subject: string } {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(name.trim());
  return m ? { code: m[1], subject: m[2] } : { code: "", subject: name };
}

function buildWarningList(): void {
  const vis = layer.visibleWarnings();
  // 表示順は番号降順。visible index を保持して連動に使う
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
    row.addEventListener("pointerenter", () => layer.highlight(i));
    row.addEventListener("pointerleave", () => layer.highlight(-1));
    row.addEventListener("click", () => openInspector(w));
    warningListEl.appendChild(row);
    rowByVisibleIndex[i] = row;
  }
}

// ---- インスペクタ --------------------------------------------------------
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

// ---- ピン ↔ 一覧の連動ハイライト ----------------------------------------
layer.onHighlight((index) => {
  for (const row of rowByVisibleIndex) row?.classList.remove("hot");
  if (index >= 0) {
    const row = rowByVisibleIndex[index];
    if (row) {
      row.classList.add("hot");
      row.scrollIntoView({ block: "nearest" });
    }
  }
});

// ---- 海図のポインタ操作 --------------------------------------------------
chartEl.addEventListener("pointermove", (ev) => {
  const idx = layer.pickAt(ev.clientX, ev.clientY);
  layer.highlight(idx);
  chartEl.style.cursor = idx >= 0 ? "pointer" : "grab";

  const ll = globe.latLonAtPointer(ev.clientX, ev.clientY);
  if (ll) {
    const ns = ll.lat >= 0 ? "N" : "S";
    const ew = ll.lon >= 0 ? "E" : "W";
    coordEl.textContent = `緯経 ${Math.abs(ll.lat).toFixed(2)}°${ns} ${Math.abs(ll.lon).toFixed(2)}°${ew}`;
  } else {
    coordEl.textContent = "緯経 —";
  }
  updateZoomReadout();
});
chartEl.addEventListener("pointerleave", () => {
  layer.highlight(-1);
  coordEl.textContent = "緯経 —";
});
chartEl.addEventListener("click", (ev) => {
  const idx = layer.pickAt(ev.clientX, ev.clientY);
  if (idx >= 0) openInspector(layer.visibleWarnings()[idx]);
});

// ---- 警報ティッカー ------------------------------------------------------
function buildTicker(warnings: ConsoleWarning[]): void {
  const heads = [...warnings]
    .sort((a, b) => b.num - a.num)
    .slice(0, 30)
    .map((w) => splitName(w.name).subject || w.name);
  if (!heads.length) {
    tickerEl.textContent = "有効な航行警報はありません";
    return;
  }
  const text = heads.join("　·　");
  tickerEl.innerHTML = "";
  const inner = document.createElement("span");
  inner.className = "ticker-inner";
  // シームレスなループのため二重化
  inner.textContent = text + "　·　" + text + "　·　";
  tickerEl.appendChild(inner);
}

// ---- 接続ステータス ------------------------------------------------------
function setConn(state: "checking" | "ok" | "down", detail: string): void {
  ledEl.dataset.state = state;
  connTextEl.textContent = detail;
}

// ---- 起動 ----------------------------------------------------------------
async function boot(): Promise<void> {
  setConn("checking", "海しる 接続確認中…");
  tickerEl.textContent = "航行警報を取得中…";
  try {
    const raw = await fetchNavWarnings(JAPAN_BBOX);
    const warnings = toConsoleWarnings(raw);
    layer.setData(warnings);
    buildFilterChips();
    buildWarningList();
    buildTicker(warnings);
    setConn("ok", `海しる 接続良好・警報 ${warnings.length}`);
    countEl.textContent = `警報 ${warnings.length}件`;
    inspectorEl.textContent = "対象未選択 — 海図のピンか一覧から警報を選ぶと電文を表示します";
  } catch {
    // 隔離環境等で疎通しない場合。海域数だけでも取れれば接続表示に反映
    try {
      const areas = await fetchAreas();
      setConn("down", `海しる 一部応答（海域 ${areas.length}・警報は取得失敗）`);
    } catch {
      setConn("down", "海しる 未接続");
    }
    countEl.textContent = "警報 —";
    tickerEl.textContent = "航行警報を取得できませんでした";
    inspectorEl.textContent = "対象未選択";
  }
}
void boot();
