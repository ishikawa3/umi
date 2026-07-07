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

async function msilFetch(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": MSIL_KEY },
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`MSIL API ${res.status}: ${path}`);
    return res.json();
  }
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

/** 等深線（20m/50m/100m/150m/200m 層）を海域bboxで取得 */
export async function fetchContours(bbox: [number, number, number, number]): Promise<ContourLine[]> {
  const [xmin, ymin, xmax, ymax] = bbox;
  const layers = [10, 11, 12, 13, 14];
  const results = await Promise.allSettled(
    layers.map((layer) =>
      msilFetch(`/depth-contour/v2/MapServer/${layer}/query`, {
        f: "geojson",
        geometry: JSON.stringify({ xmin, ymin, xmax, ymax }),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        outFields: "Depth",
        returnGeometry: "true",
      })
    )
  );
  const lines: ContourLine[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.features) continue;
    for (const f of r.value.features) {
      const g = f.geometry;
      const paths: [number, number][][] =
        g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
      lines.push({ depth: f.properties.Depth, paths });
    }
  }
  return lines;
}
