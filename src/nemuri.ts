import "./style.css";
import { arcgisQuery } from "./api";
import { JapanMap, JAPAN_BBOX } from "./japanmap";
import { mountNav } from "./nav";

mountNav("nemuri");

const canvas = document.getElementById("sea") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const countEl = document.getElementById("wreck-count")!;

const map = new JapanMap(canvas, JAPAN_BBOX);

interface Wreck {
  lon: number;
  lat: number;
  seed: number; // 明滅の位相
  slow: number; // 明滅の速さの個体差
}

let wrecks: Wreck[] = [];

/** 沈船は属性を持たない（位置だけが残っている）。全ページ取得する */
async function fetchWrecks(): Promise<Wreck[]> {
  const out: Wreck[] = [];
  for (let page = 0; page < 10; page++) {
    const gj = await arcgisQuery("wrecks/v2", 1, JAPAN_BBOX, {
      outFields: "OBJECTID",
      resultOffset: String(page * 1000),
    });
    for (const f of gj.features ?? []) {
      out.push({
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        seed: Math.random() * Math.PI * 2,
        slow: 0.6 + Math.random() * 0.8,
      });
    }
    statusEl.textContent = `沈船の位置を集めています… ${out.length}`;
    if (!gj.exceededTransferLimit) break;
  }
  return out;
}

function tick(ts: number) {
  map.drawBase();
  const ctx = map.ctx;
  ctx.globalCompositeOperation = "lighter";
  for (const w of wrecks) {
    const [x, y] = map.toScreen(w.lon, w.lat);
    // 眠るようにゆっくり明滅する
    const breath = 0.5 + 0.5 * Math.sin((ts / 3200) * w.slow + w.seed);
    const a = 0.08 + breath * 0.3;
    ctx.fillStyle = `rgba(160, 200, 235, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, (0.7 + breath * 0.6) * map.dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
  requestAnimationFrame(tick);
}

window.addEventListener("resize", () => map.resize());

async function boot() {
  statusEl.textContent = "沈船の位置を集めています…";
  try {
    const [w] = await Promise.all([fetchWrecks(), map.init()]);
    wrecks = w;
  } catch {
    statusEl.textContent = "海しるAPIに接続できませんでした";
    return;
  }
  statusEl.textContent = "";
  countEl.textContent = `日本の海に眠る沈船 ${wrecks.length.toLocaleString()}隻`;
  requestAnimationFrame(tick);
}

void boot();
