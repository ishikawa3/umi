// 船舶通航量（AIS統計）ラスタの取得と分類。みち（src/michi.ts）とかいしょう（console/traffic.ts）で共用。
//
// 海しるは通航量を4クラスに色分けしたラスタ(PNG)で提供する。指定した bbox を
// 経緯度座標系（等緯度経度）の width×height で書き出させ、画素ごとにクラス(0..4)へ分類して返す。

import { msilFetchRaw, MsilHttpError } from "./api";

export type LonLatBBox = [number, number, number, number]; // [xmin, ymin, xmax, ymax]

export interface TrafficRaster {
  /** 行優先（行0が北端）のクラス格子。0=無データ, 1..4=閑散→過密 */
  classes: Uint8Array;
  /** 取得できた統計の年（"2024" など） */
  year: string;
}

/** クラス(1..4) の表示名。classes の値 − 1 で引く */
export const TRAFFIC_CLASS_LABEL = ["閑散", "中", "多い", "過密"];

// 取得元。年単位の統計で、新しい順に試す。
// - 2024年: 海しるAPI v3 の ArcGIS ImageService（2026/11 時点でベータ版）。
//   公式のラスター関数 vessel_traffic_raster_template で、2020年版と同じ4色に色付けして書き出す
// - 2020年: v2（2017–2020 のみ。2027年12月末に提供終了予定）。ベータ版が使えないときの控え
interface TrafficSource {
  year: string;
  path: string;
  params: Record<string, string>;
  /** これより粗い解像度（度/px）では取れない取得元の上限。指定時は細かく取って縮める */
  maxDegPerPx?: number;
}
const SOURCES: TrafficSource[] = [
  {
    year: "2024",
    path: "/arcgis/rest/services/ImageService/v3/vessel_traffic_2024/ImageServer/exportImage",
    params: {
      format: "png32",
      renderingRule: JSON.stringify({ rasterFunction: "vessel_traffic_raster_template" }),
      // 分類は色の一致で行うので、補間で中間色を作らせない
      interpolation: "RSP_NearestNeighbor",
    },
    // 元の画素は約464m。概観（ピラミッド）が約8倍までしか無いらしく、それより粗く書き出すと
    // 全面透明の画像が返る（26°を640pxで頼む＝約0.041°/pxで空、0.036°/pxなら取れる。2026/11 実測）。
    // 余裕をみて 0.025°/px より粗い要求は細かく取ってから縮める
    maxDegPerPx: 0.025,
  },
  {
    year: "2020",
    path: "/monthly-vessel-traffic-amount/v2/2020/MapServer/export",
    // 分類前提のロスレスなパレットPNGを固定する
    params: { format: "png8", layers: "show:0" },
  },
];

// 公式ラスタの5色パレット → 通航量の4クラス（低→高）。白は背景（無データ）。
const CLASS_COLORS: { rgb: [number, number, number]; cls: number }[] = [
  { rgb: [0, 112, 255], cls: 1 }, // 青 = 閑散
  { rgb: [152, 230, 0], cls: 2 }, // 緑 = 中
  { rgb: [255, 170, 0], cls: 3 }, // 橙 = 多い
  { rgb: [214, 47, 39], cls: 4 }, // 赤 = 過密
];

/** ピクセルRGB → クラス(1..4)。背景(白)や不明色は 0。 */
function classify(r: number, g: number, b: number): number {
  // 白背景（253,253,253 近傍）は無データ
  if (r > 235 && g > 235 && b > 235) return 0;
  let best = 0;
  let bestD = Infinity;
  for (const c of CLASS_COLORS) {
    const dr = r - c.rgb[0];
    const dg = g - c.rgb[1];
    const db = b - c.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = c.cls;
    }
  }
  // どのクラス色にも遠すぎる（アンチエイリアス縁など）は捨てる
  return bestD < 90 * 90 ? best : 0;
}

/**
 * 全域を1枚（1400px）で export させると海しる側の描画に約40秒かかり、
 * 約30秒で中継側に打ち切られる（CORSヘッダの無いエラーになり、ブラウザでは取得失敗）。
 * 3×3 に分けて並行に取る（1枚あたり数秒）。それでも描画時間にはばらつきがあり、
 * まれに1枚だけ打ち切られるので、中継の打ち切りと 5xx のタイルだけ1回取り直す。
 * 打ち切りも、CORS ヘッダの無い 4xx（海しるの 404 等）も、ブラウザからは同じ TypeError に見える。
 * 打ち切りは約30秒待たされてから起きるので、時間のかかった TypeError だけを打ち切りとみなす。
 * すぐに失敗したもの（直らない 4xx・オフライン）は取り直さず、すぐ次の取得元へ移る。
 * 画像は経緯度座標系（imageSR=4326）なので、ピクセル境界から各タイルの bbox を
 * 線形に求めれば継ぎ目なくつながる。
 */
const TILE_SPLIT = 3;

/** 中継の打ち切りとみなす経過時間（打ち切りは約30秒後に起きる） */
const CUTOFF_LIKE_MS = 15_000;

/** 取り直す価値のある失敗か（中継の打ち切り・5xx） */
function retryable(e: unknown, signal: AbortSignal, elapsedMs: number): boolean {
  if (signal.aborted) return false;
  if (e instanceof MsilHttpError) return e.status >= 500;
  return e instanceof TypeError && elapsedMs >= CUTOFF_LIKE_MS;
}

async function loadTile(
  src: TrafficSource, bbox: LonLatBBox, w: number, h: number,
  c0: number, c1: number, r0: number, r1: number, signal: AbortSignal
): Promise<ImageBitmap> {
  const [x0, y0, x1, y1] = bbox;
  const lon0 = x0 + (c0 / w) * (x1 - x0);
  const lon1 = x0 + (c1 / w) * (x1 - x0);
  const lat1 = y1 - (r0 / h) * (y1 - y0); // 行0が北端
  const lat0 = y1 - (r1 / h) * (y1 - y0);
  // 429リトライ・認証ヘッダ・非OK例外化を api.ts に集約（msilFetchRaw 経由）
  const res = await msilFetchRaw(src.path, {
    bbox: `${lon0},${lat0},${lon1},${lat1}`,
    // bbox を経緯度で解釈させる（サーバのデフォルトSRに依存しない）
    bboxSR: "4326",
    imageSR: "4326",
    size: `${c1 - c0},${r1 - r0}`,
    f: "image",
    ...src.params,
  }, signal);
  return createImageBitmap(await res.blob());
}

/** 1つの取得元からタイルを並行に取り、width×height の RGBA を返す。1枚でも取れなければ失敗 */
async function loadSource(src: TrafficSource, bbox: LonLatBBox, w: number, h: number): Promise<Uint8ClampedArray> {
  // オフスクリーンにタイルを並べてからピクセルを読む
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d", { willReadFrequently: true })!;
  const cuts = (n: number) =>
    Array.from({ length: TILE_SPLIT + 1 }, (_, i) => Math.round((n * i) / TILE_SPLIT));
  const cols = cuts(w);
  const rows = cuts(h);
  // 1枚でも取れなければこの取得元は諦めるので、残りのタイル（と取り直し）も止める。
  // 止めないと、次の取得元へ移ったあとも裏で要求が続き、429 や遅延の原因になる
  const ctrl = new AbortController();
  const { signal } = ctrl;
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < TILE_SPLIT; i++) {
    for (let j = 0; j < TILE_SPLIT; j++) {
      const [c0, c1, r0, r1] = [cols[i], cols[i + 1], rows[j], rows[j + 1]];
      const t0 = performance.now();
      jobs.push(
        loadTile(src, bbox, w, h, c0, c1, r0, r1, signal)
          .catch((e) => {
            if (!retryable(e, signal, performance.now() - t0)) throw e;
            return loadTile(src, bbox, w, h, c0, c1, r0, r1, signal); // 1回だけ取り直す
          })
          .then((bmp) => {
            if (!signal.aborted) octx.drawImage(bmp, c0, r0, c1 - c0, r1 - r0);
            bmp.close(); // 描いたら不要。export 画像を早期に解放する
          })
          .catch((e) => {
            ctrl.abort();
            throw e;
          })
      );
    }
  }
  await Promise.all(jobs);
  return octx.getImageData(0, 0, w, h).data;
}

/** 1つの取得元のクラス格子（width×height）。解像度の上限があれば細かく取ってから縮める */
async function loadClasses(src: TrafficSource, bbox: LonLatBBox, width: number, height: number): Promise<Uint8Array> {
  const degPerPx = Math.max((bbox[2] - bbox[0]) / width, (bbox[3] - bbox[1]) / height);
  const k = src.maxDegPerPx ? Math.max(1, Math.ceil(degPerPx / src.maxDegPerPx)) : 1;
  const fw = width * k;
  const fh = height * k;
  const data = await loadSource(src, bbox, fw, fh);
  const out = new Uint8Array(width * height);
  // k×k のブロックごとに最も多いクラス（過密寄り）を採る。細い航路が縮小で消えないように
  for (let y = 0; y < fh; y++) {
    const row = ((y / k) | 0) * width;
    for (let x = 0, p = y * fw * 4; x < fw; x++, p += 4) {
      const cls = classify(data[p], data[p + 1], data[p + 2]);
      const i = row + ((x / k) | 0);
      if (cls > out[i]) out[i] = cls;
    }
  }
  return out;
}

/**
 * bbox（経緯度）の通航量を width×height のクラス格子で取得する。
 * 2024年版（v3 ベータ）を優先し、取れなければ 2020年版（v2）に戻る。どちらも取れなければ例外。
 * 全面が無データの結果も「取れなかった」とみなして次へ移る（ベータ版が空画像を返すことがあるため）。
 * 最後の取得元の結果は、空でもそのまま返す。
 */
export async function fetchTrafficRaster(bbox: LonLatBBox, width: number, height: number): Promise<TrafficRaster> {
  let lastError: unknown;
  for (let s = 0; s < SOURCES.length; s++) {
    const src = SOURCES[s];
    let classes: Uint8Array;
    try {
      classes = await loadClasses(src, bbox, width, height);
    } catch (e) {
      console.warn(`[traffic] ${src.year}年の通航量を取得できませんでした`, e);
      lastError = e;
      continue;
    }
    if (s < SOURCES.length - 1 && !classes.some((c) => c !== 0)) {
      console.warn(`[traffic] ${src.year}年の通航量が全面無データでした。次の取得元を試します`);
      continue;
    }
    return { classes, year: src.year };
  }
  throw new Error("通航量を取得できませんでした", { cause: lastError });
}

/** 非0（描画対象）画素のインデックス一覧 */
export function activeIndices(classes: Uint8Array): Int32Array {
  let n = 0;
  for (let i = 0; i < classes.length; i++) if (classes[i]) n++;
  const out = new Int32Array(n);
  for (let i = 0, k = 0; i < classes.length; i++) if (classes[i]) out[k++] = i;
  return out;
}
