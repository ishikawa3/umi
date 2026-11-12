import { API_BASE, MSIL_KEY } from "./config";

export interface Area {
  code: string;
  nameJa: string;
  nameEn: string;
  // [minLon, minLat, maxLon, maxLat]
  bbox: [number, number, number, number];
}

export interface CurrentSample {
  lon: number;
  lat: number;
  /** 流向（流れて行く方向、北=0°時計回り） */
  dir: number;
  /** 流速 [kt] */
  kt: number;
}

export interface ContourLine {
  depth: number;
  paths: [number, number][][];
}

/**
 * 海しるAPIへの生アクセス。429を指数バックオフでリトライし、非OKは例外化する。
 * バイナリ（画像export等）を扱うページはこの Response を直接使う。
 */
export async function msilFetchRaw(
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<Response> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": MSIL_KEY },
      signal,
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    // 認証キーはヘッダ送信でURLに含まれないため、クエリ込みのURLを出して追跡性を上げる
    if (!res.ok) throw new Error(`MSIL API ${res.status}: ${url}`);
    return res;
  }
}

async function msilFetch(path: string, params?: Record<string, string>): Promise<any> {
  const body = await (await msilFetchRaw(path, params)).json();
  // ArcGIS はクエリの誤りや障害を HTTP 200 + {error:{...}} で返すことがある。
  // 素通しすると features が無い＝「0件」に見えるので、エラーとして扱う
  if (body && typeof body === "object" && body.error) {
    throw new Error(`MSIL API error ${body.error.code ?? ""}: ${body.error.message ?? ""} (${path})`);
  }
  return body;
}

/** bbox（経緯度）で絞る ArcGIS クエリの共通パラメータ。v2 MapServer・v3 FeatureService 共通 */
function envelopeQueryParams(
  bbox: [number, number, number, number],
  extra?: Record<string, string>
): Record<string, string> {
  const [xmin, ymin, xmax, ymax] = bbox;
  return {
    f: "geojson",
    geometry: JSON.stringify({ xmin, ymin, xmax, ymax }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outFields: "*",
    returnGeometry: "true",
    ...extra,
  };
}

export async function fetchAreas(): Promise<Area[]> {
  const gj = await msilFetch("/tidal-current-prediction/v3/area");
  return gj.features.map((f: any): Area => {
    const ring: [number, number][] = f.geometry.coordinates[0];
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    return {
      code: f.properties.areaCode,
      nameJa: f.properties.nameJa,
      nameEn: f.properties.nameEn,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    };
  });
}

/** Date → 海しるAPIの時刻形式 YYYYMMDDhhmm（JST） */
export function toMsilTime(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    p(jst.getUTCFullYear(), 4) +
    p(jst.getUTCMonth() + 1) +
    p(jst.getUTCDate()) +
    p(jst.getUTCHours()) +
    p(jst.getUTCMinutes())
  );
}

/** Date → YYYYMMDD（JST） */
export function toMsilDate(d: Date): string {
  return toMsilTime(d).slice(0, 8);
}

export interface TideStation {
  code: string;
  nameJa: string;
  nameEn: string;
  lon: number;
  lat: number;
}

export async function fetchTideStations(): Promise<TideStation[]> {
  const gj = await msilFetch("/tide-prediction/v3/station");
  return gj.features.map((f: any): TideStation => ({
    code: f.properties.stationCode,
    nameJa: f.properties.nameJa,
    nameEn: f.properties.nameEn,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

export interface TideDay {
  /** 潮位[cm]。1分間隔で1日分（1440個） */
  tide: number[];
  min: number;
  max: number;
}

export async function fetchTideDay(stationCode: string, date: string): Promise<TideDay> {
  const d = await msilFetch("/tide-prediction/v3/data", { stationCode, date });
  const tide: number[] = d.tide ?? [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of tide) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { tide, min, max };
}

export async function fetchCurrents(areaCode: string, time: Date): Promise<CurrentSample[]> {
  const gj = await msilFetch("/tidal-current-prediction/v3/data", {
    areaCode,
    time: toMsilTime(time),
  });
  return (gj.features ?? []).map((f: any): CurrentSample => ({
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    dir: f.properties.currentDirection,
    kt: f.properties.currentSpeedKt,
  }));
}

/**
 * v2系API（ArcGIS REST形式）の汎用クエリ。
 * pathは "depth-contour/v2" のようにバージョンまで含める。
 */
export async function arcgisQuery(
  path: string,
  layer: number,
  bbox: [number, number, number, number],
  extra?: Record<string, string>
): Promise<any> {
  return msilFetch(`/${path}/MapServer/${layer}/query`, envelopeQueryParams(bbox, extra));
}

/**
 * v3 API（ArcGIS FeatureService）の汎用クエリ。1回あたり最大2000件で、
 * 超える分は resultOffset で続きを取り、全件を返す。
 * v2 は2027年12月末に提供終了予定（海しるAPI v3 リリースノート）。
 * v3 に移行先がある項目はこちらを使う。サービス名は移行対応表の「移行先 v3 API」。
 * 層番号・属性名は v2 と異なる（例: 海底地形名は v2 の 1/2/3 → v3 の 0/1/2、属性は小文字化）。
 * resultOffset でページを分けるので、ページ間で重複・欠落しないよう objectid 順に固定する。
 */
const MAX_PAGES = 20;
export async function featureQueryAll(
  service: string,
  layer: number,
  bbox: [number, number, number, number],
  extra?: Record<string, string>,
  onProgress?: (count: number) => void
): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const gj = await msilFetch(
      `/arcgis/rest/services/FeatureService/v3/${service}/FeatureServer/${layer}/query`,
      envelopeQueryParams(bbox, {
        where: "1=1",
        outSR: "4326",
        orderByFields: "objectid",
        resultOffset: String(out.length),
        ...extra,
      })
    );
    const fs: any[] = gj.features ?? [];
    out.push(...fs);
    onProgress?.(out.length);
    // GeoJSON 出力では properties の下に入る
    const exceeded = gj.exceededTransferLimit ?? gj.properties?.exceededTransferLimit;
    if (!exceeded || fs.length === 0) return out;
  }
  // 上限に達してもまだ続きがある: 一部だけを全件のように見せない
  throw new Error(`featureQueryAll: ${service}/${layer} が ${MAX_PAGES} ページを超えました`);
}

/** 等深線（20m/50m/100m/150m/200m）を海域bboxで取得（v3: 1層に depth 属性でまとまっている） */
export async function fetchContours(bbox: [number, number, number, number]): Promise<ContourLine[]> {
  const features = await featureQueryAll("depth_contour", 0, bbox, {
    outFields: "depth",
    where: "depth IN (20, 50, 100, 150, 200)",
  });
  const lines: ContourLine[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const paths: [number, number][][] =
      g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
    lines.push({ depth: f.properties.depth, paths });
  }
  return lines;
}

export interface WaveSample {
  lon: number;
  lat: number;
  /** 有義波高 [m] */
  height: number;
  /** 波向き（北=0°時計回り、波が来る方向） */
  dir: number;
}

/**
 * 波浪解析データを取得する。
 * 海しる wave-analysis/v2 MapServer（layer 0: 波高、layer 1: 波向き）。
 * bbox は日本全域 JAPAN_BBOX を想定。
 */
export async function fetchWaves(bbox: [number, number, number, number]): Promise<WaveSample[]> {
  const gj = await arcgisQuery("wave-analysis/v2", 0, bbox, {
    outFields: "SigWaveHeight,PeakWaveDirection",
  });
  const out: WaveSample[] = [];
  for (const f of gj.features ?? []) {
    // APIのレスポンスフィールド名が大小文字どちらのケースでも来ることがあるため両方試みる
    const h = f.properties.SigWaveHeight ?? f.properties.sigwaveheight ?? null;
    if (h === null) continue;
    out.push({
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      height: Number(h),
      dir: Number(f.properties.PeakWaveDirection ?? f.properties.peakwavedirection ?? 0),
    });
  }
  return out;
}

export interface NavWarning {
  /** 例 "06-260085 豊後水道、灯台消灯" */
  name: string;
  /** HTMLを除去した電文本文 */
  body: string;
  lon: number;
  lat: number;
  /** 警報番号（並び順用。名称先頭の "06-260085" から 260085 を抽出） */
  num: number;
}

/** HTML混じりの電文をプレーンテキストへ（こえ・かいしょう共通） */
function cleanWarningBody(html: string): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/^\s*[［\[].*?[］\]]\s*$/gm, "") // リンク由来の「[利用上の制限事項]」等
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "06-260085 豊後水道、…" → 260085 */
function warningNumber(name: string): number {
  const m = /^\d{2}-(\d+)/.exec(name ?? "");
  return m ? Number(m[1]) : 0;
}

/** 点/面ジオメトリの代表点（重心） */
function geomCentroid(geom: any): [number, number] | null {
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

async function fetchNavLayer(
  layer: number,
  bbox: [number, number, number, number]
): Promise<NavWarning[]> {
  const out: NavWarning[] = [];
  // 1000件超に備えてページング
  for (let offset = 0; offset < 5000; offset += 1000) {
    const gj = await arcgisQuery("navigational-warnings/v2", layer, bbox,
      offset ? { resultOffset: String(offset) } : {});
    for (const f of gj.features ?? []) {
      const c = geomCentroid(f.geometry);
      if (!c) continue;
      const name = f.properties.name ?? f.properties.Name ?? "";
      out.push({
        name,
        body: cleanWarningBody(f.properties.description ?? f.properties.Description),
        lon: c[0],
        lat: c[1],
        num: warningNumber(name),
      });
    }
    if (!gj.exceededTransferLimit) break;
  }
  return out;
}

/**
 * 航行警報（navigational-warnings/v2）を取得する。層1=点・層3=面。
 * 片方の層が失敗しても残りは返す（Promise.allSettled）。
 * こえ（src/koe.ts）と かいしょう（console）の共通データ源。
 */
export async function fetchNavWarnings(
  bbox: [number, number, number, number]
): Promise<NavWarning[]> {
  const results = await Promise.allSettled([fetchNavLayer(1, bbox), fetchNavLayer(3, bbox)]);
  const out: NavWarning[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  return out;
}
