// かいしょう / KAISHŌ VTS Console — フェーズ14: 土台
//
// うみ（データアート）の陰画としての「穏やかな運用コンソール」。
// three.js の 3D 海図（地球儀）＋ライト・パステルの業務UIシェルを立てる。
// データ層は うみ本体の src/api.ts を共有する（PLAN4 0.1）。

import "./style.css";
import { Globe } from "./scene";
import { fetchAreas } from "../src/api";

const chartEl = document.getElementById("chart")!;
const clockEl = document.getElementById("clock")!;
const ledEl = document.getElementById("conn-led")!;
const connTextEl = document.getElementById("conn-text")!;
const coordEl = document.getElementById("st-coord")!;
const zoomEl = document.getElementById("st-zoom")!;
const countEl = document.getElementById("st-count")!;
const inspectorEl = document.getElementById("inspector-body")!;
const tickerEl = document.getElementById("ticker")!;

// ---- 3D 海図 ------------------------------------------------------------
const globe = new Globe(chartEl);
globe.start();
window.addEventListener("resize", () => globe.resize());

function updateZoomReadout(): void {
  // カメラ距離（1.2=接近, 4.2=引き）を 0..100 のズーム値に写像
  const d = globe.cameraDistance;
  const z = Math.round((1 - (d - 1.2) / (4.2 - 1.2)) * 100);
  zoomEl.textContent = `ズーム ${Math.max(0, Math.min(100, z))}`;
}

chartEl.addEventListener("pointermove", (ev) => {
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
chartEl.addEventListener("pointerleave", () => (coordEl.textContent = "緯経 —"));
updateZoomReadout();

// ---- JST 時計（毎秒更新） ------------------------------------------------
const jstFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
function tickClock(): void {
  // "2026/07/21 14:03:22" 形式 → 見やすく整形
  const parts = jstFmt.format(new Date()).replace(/\//g, "-");
  clockEl.textContent = `${parts} JST`;
}
tickClock();
setInterval(tickClock, 1000);

// ---- レイヤパネル（この時点では空機能のトグル） --------------------------
interface LayerDef {
  key: string;
  label: string;
  phase: string; // 実装フェーズ（未実装であることを明示）
}
const LAYERS: LayerDef[] = [
  { key: "warnings", label: "航行警報", phase: "P15" },
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
    cb.disabled = true; // 未実装レイヤは操作不可（データはフェーズ15以降で接続）
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = l.label;
    const tag = document.createElement("span");
    tag.className = "layer-tag";
    tag.textContent = l.phase;
    row.append(cb, name, tag);
    list.appendChild(row);
  }
}
buildLayerPanel();

// ---- 接続ステータス: 共有 api.ts で海しるへ疎通確認 ----------------------
function setConn(state: "checking" | "ok" | "down", detail: string): void {
  ledEl.dataset.state = state;
  connTextEl.textContent = detail;
}
async function checkConnection(): Promise<void> {
  setConn("checking", "海しる 接続確認中…");
  try {
    const areas = await fetchAreas();
    setConn("ok", `海しる 接続良好・海域 ${areas.length}`);
    countEl.textContent = `海域 ${areas.length}`;
  } catch {
    // 隔離環境やオフラインでは疎通しないことがある（本番ブラウザでは接続可）
    setConn("down", "海しる 未接続");
    countEl.textContent = "海域 —";
  }
}
void checkConnection();

// ---- インスペクタ・ティッカーの初期状態 ----------------------------------
inspectorEl.textContent = "対象未選択 — 海図上の要素を選ぶと詳細を表示します（フェーズ15以降）";
tickerEl.textContent = "航行警報ティッカーはフェーズ15で稼働します";
