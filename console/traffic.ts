// かいしょう — 通航量レイヤ（フェーズ18）
//
// 船舶通航量（AIS統計・年間。2024年、取れなければ2020年）を、主要港・海峡が動脈のように灯るトラフィックモニタに。
// うみ「みち」の陰画。海しるは通航量を4クラス分類のラスタ(PNG)で提供するため、
// 画素を分類して球面点群として描く（暗＝閑散 → 白＝過密の単一色相ランプ）。静的描画。

import * as THREE from "three";
import { fetchTrafficRaster, activeIndices, TRAFFIC_CLASS_LABEL, type LonLatBBox } from "../src/traffic-raster";
import { latLonToVec3 } from "./geo";
import { softDisc } from "./sprite";

const BBOX: LonLatBBox = [122, 24, 148, 46]; // JAPAN_BBOX
const LON_SPAN = BBOX[2] - BBOX[0]; // 26
const LAT_SPAN = BBOX[3] - BBOX[1]; // 22
const RW = 640;
const RH = Math.round((RW * LAT_SPAN) / LON_SPAN); // 541
const TRAFFIC_R = 1.005;

// 単一色相ランプ（暗いシアン＝閑散 → 明るいシアン白＝過密）
const RAMP = ["#1c5566", "#2f8a94", "#7fd8d2", "#eafffd"].map((h) => new THREE.Color(h));

export class TrafficLayer {
  private readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly capacity: number;
  private grid: Uint8Array | null = null;
  private loaded = false;
  private yearLoaded: string | null = null;

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
  /** 表示中の統計の年（"2024" など）。未取得なら null */
  year(): string | null { return this.yearLoaded; }

  /** ラスタを取得・分類して球面点群を構築。描画した点数を返す（0＝無データ） */
  async load(): Promise<number> {
    // 取得・2024年→2020年の切り替え・色の分類は みち と共通（src/traffic-raster.ts）
    const { classes: grid, year } = await fetchTrafficRaster(BBOX, RW, RH);
    const active = activeIndices(grid);
    this.grid = grid;
    this.yearLoaded = year;

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
    return n; // 実際に描画した点数（間引き後）。0 なら無データ
  }

  /** ホバー地点の通航量クラス（ラベル）。無データなら null */
  readoutAt(lat: number, lon: number): string | null {
    if (!this.grid) return null;
    const col = Math.round(((lon - BBOX[0]) / LON_SPAN) * RW - 0.5);
    const row = Math.round(((BBOX[3] - lat) / LAT_SPAN) * RH - 0.5);
    if (col < 0 || col >= RW || row < 0 || row >= RH) return null;
    const cls = this.grid[row * RW + col];
    return cls ? TRAFFIC_CLASS_LABEL[cls - 1] : null;
  }
}
