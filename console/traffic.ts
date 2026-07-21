// かいしょう — 通航量レイヤ（フェーズ18）
//
// 船舶通航量（AIS統計・月間）を、主要港・海峡が動脈のように灯るトラフィックモニタに。
// うみ「みち」の陰画。海しるは通航量を4クラス分類のラスタ(PNG)で提供するため、
// 画素を分類して球面点群として描く（暗＝閑散 → 白＝過密の単一色相ランプ）。静的描画。

import * as THREE from "three";
import { msilFetchRaw } from "../src/api";
import { latLonToVec3 } from "./geo";
import { softDisc } from "./sprite";

const YEAR = "2020"; // AIS統計は年単位(2017–2020)。最新の確定年
const BBOX = [122, 24, 148, 46]; // JAPAN_BBOX
const LON_SPAN = BBOX[2] - BBOX[0]; // 26
const LAT_SPAN = BBOX[3] - BBOX[1]; // 22
const RW = 640;
const RH = Math.round((RW * LAT_SPAN) / LON_SPAN); // 541
const TRAFFIC_R = 1.005;

// 公式ラスタの5色パレット → 通航量4クラス（低→高）。白は背景（無データ）。
const CLASS_COLORS: { rgb: [number, number, number]; cls: number }[] = [
  { rgb: [0, 112, 255], cls: 1 }, // 青 = 閑散
  { rgb: [152, 230, 0], cls: 2 }, // 緑 = 中
  { rgb: [255, 170, 0], cls: 3 }, // 橙 = 多い
  { rgb: [214, 47, 39], cls: 4 }, // 赤 = 過密
];
export const CLASS_LABEL = ["閑散", "中", "多い", "過密"];
// 単一色相ランプ（暗群青＝閑散 → 白＝過密）。0.6 の量表現に沿う
const RAMP = ["#173f4d", "#2f7d84", "#8ecac6", "#f2fbfa"].map((h) => new THREE.Color(h));

function classify(r: number, g: number, b: number): number {
  if (r > 235 && g > 235 && b > 235) return 0; // 白背景＝無データ
  let best = 0, bestD = Infinity;
  for (const c of CLASS_COLORS) {
    const dr = r - c.rgb[0], dg = g - c.rgb[1], db = b - c.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = c.cls; }
  }
  return bestD < 90 * 90 ? best : 0; // AA縁など遠い色は捨てる
}

export class TrafficLayer {
  private readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly capacity: number;
  private grid: Uint8Array | null = null;
  private loaded = false;

  constructor(globe: { add(o: THREE.Object3D): void }, capacity = 60000) {
    this.capacity = capacity;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size: 0.02, map: softDisc(), vertexColors: true,
      transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.group.visible = false;
    globe.add(this.group);
  }

  setVisible(v: boolean): void { this.group.visible = v; }
  isVisible(): boolean { return this.group.visible; }
  isLoaded(): boolean { return this.loaded; }

  /** ラスタを取得・分類して球面点群を構築。描画した点数を返す（0＝無データ） */
  async load(): Promise<number> {
    const res = await msilFetchRaw(
      `/monthly-vessel-traffic-amount/v2/${YEAR}/MapServer/export`,
      {
        bbox: BBOX.join(","), bboxSR: "4326", imageSR: "4326",
        format: "png8", layers: "show:0", size: `${RW},${RH}`, f: "image",
      }
    );
    const bmp = await createImageBitmap(await res.blob());
    const off = document.createElement("canvas");
    off.width = RW; off.height = RH;
    const octx = off.getContext("2d", { willReadFrequently: true })!;
    octx.drawImage(bmp, 0, 0, RW, RH);
    const data = octx.getImageData(0, 0, RW, RH).data;
    bmp.close();

    const grid = new Uint8Array(RW * RH);
    const active: number[] = [];
    for (let i = 0, p = 0; i < grid.length; i++, p += 4) {
      const cls = classify(data[p], data[p + 1], data[p + 2]);
      if (cls) { grid[i] = cls; active.push(i); }
    }
    this.grid = grid;

    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    // 多すぎる場合は間引いて capacity に収める
    const stride = Math.max(1, Math.ceil(active.length / this.capacity));
    let n = 0;
    for (let k = 0; k < active.length && n < this.capacity; k += stride, n++) {
      const idx = active[k];
      const cx = idx % RW, ry = (idx / RW) | 0;
      const lon = BBOX[0] + ((cx + 0.5) / RW) * LON_SPAN;
      const lat = BBOX[3] - ((ry + 0.5) / RH) * LAT_SPAN;
      const v = latLonToVec3(lat, lon, TRAFFIC_R);
      pos.setXYZ(n, v.x, v.y, v.z);
      c.copy(RAMP[grid[idx] - 1]);
      col.setXYZ(n, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
    this.points.geometry.computeBoundingSphere();
    this.loaded = true;
    return active.length;
  }

  /** ホバー地点の通航量クラス（ラベル）。無データなら null */
  readoutAt(lat: number, lon: number): string | null {
    if (!this.grid) return null;
    const col = Math.round(((lon - BBOX[0]) / LON_SPAN) * RW - 0.5);
    const row = Math.round(((BBOX[3] - lat) / LAT_SPAN) * RH - 0.5);
    if (col < 0 || col >= RW || row < 0 || row >= RH) return null;
    const cls = this.grid[row * RW + col];
    return cls ? CLASS_LABEL[cls - 1] : null;
  }
}
