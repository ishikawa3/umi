// かいしょう — 潮流レイヤ（フェーズ16）
//
// うみ「ながれ」の粒子機構を球面へ。VectorField(src/field.ts)のIDWを lon/lat 空間で
// そのまま使い、粒子を流向に沿って移流し、球面上の three.js Points として描く。
// 色は流速の単一色相ランプ（淡→白＝速い。海のティール上でも視認できる明度差）。

import * as THREE from "three";
import type { Area } from "../src/api";
import { VectorField } from "../src/field";
import { latLonToVec3 } from "./geo";
import { softDisc } from "./sprite";

const CUR_R = 1.008;
// 流速(kt)→1秒あたりの移流量(度)。物理厳密ではなく視認性のための倍率（向きは正しい）
const FLOW_SCALE = 0.06;
const SLOW = new THREE.Color("#2f7d84"); // 遅い（暗いシアン）
const FAST = new THREE.Color("#eafffd"); // 速い（明るいシアン白）

export interface CurrentReadout {
  kt: number;
  dir: number; // 流れて行く方角（北=0、時計回り）
}

const COMPASS8 = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
export function compass8(dir: number): string {
  return COMPASS8[Math.round((((dir % 360) + 360) % 360) / 45) % 8];
}

export class CurrentsLayer {
  private readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly capacity: number;

  private field: VectorField | null = null;
  private bbox: [number, number, number, number] = [122, 24, 148, 46];
  private refKt = 1;

  // 粒子の平行配列
  private lon: Float64Array;
  private lat: Float64Array;
  private life: Float32Array;
  private readonly tmp = new Float32Array(2);
  private readonly color = new THREE.Color();

  constructor(globe: { add(o: THREE.Object3D): void }, capacity = 2600) {
    this.capacity = capacity;
    this.lon = new Float64Array(capacity);
    this.lat = new Float64Array(capacity);
    this.life = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: 0.02,
      map: softDisc(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.group.visible = false;
    globe.add(this.group);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  isVisible(): boolean {
    return this.group.visible;
  }

  refSpeed(): number {
    return this.refKt;
  }

  /** 海域を切り替え、粒子を bbox 内へ再配置（場は setField で与える） */
  setArea(area: Area): void {
    this.bbox = area.bbox;
    for (let i = 0; i < this.capacity; i++) this.seed(i);
  }

  /** ベクトル場を差し替え（時刻変更時）。粒子はそのまま新しい流れに従う */
  setField(field: VectorField): void {
    this.field = field;
    this.refKt = Math.max(field.p90Kt, 0.1);
  }

  private seed(i: number): void {
    const [x0, y0, x1, y1] = this.bbox;
    this.lon[i] = x0 + Math.random() * (x1 - x0);
    this.lat[i] = y0 + Math.random() * (y1 - y0);
    this.life[i] = 1 + Math.random() * 3; // 秒
  }

  /** 毎フレーム更新（Globe.onFrame から dt 秒で呼ぶ） */
  update(dtSec: number): void {
    if (!this.group.visible || !this.field) return;
    const dt = Math.min(dtSec, 0.05);
    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute("color") as THREE.BufferAttribute;
    let count = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) this.seed(i);
      const ok = this.field.lookup(this.lon[i], this.lat[i], this.tmp);
      if (!ok) {
        this.life[i] = 0;
        // 場外の粒子は球の内側へ退避し、海に隠して非表示にする
        pos.setXYZ(count, 0, 0, 0);
        col.setXYZ(count, 0, 0, 0);
        count++;
        continue;
      }
      const u = this.tmp[0]; // 東向き kt
      const v = this.tmp[1]; // 北向き kt
      const cosLat = Math.max(Math.cos((this.lat[i] * Math.PI) / 180), 0.2);
      this.lon[i] += (u * FLOW_SCALE * dt) / cosLat;
      this.lat[i] += v * FLOW_SCALE * dt;
      this.life[i] -= dt;

      const p = latLonToVec3(this.lat[i], this.lon[i], CUR_R);
      pos.setXYZ(count, p.x, p.y, p.z);
      const speed = Math.hypot(u, v);
      const t = THREE.MathUtils.clamp(speed / this.refKt, 0, 1);
      this.color.copy(SLOW).lerp(FAST, t);
      col.setXYZ(count, this.color.r, this.color.g, this.color.b);
      count++;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.points.geometry.setDrawRange(0, count);
  }

  /** ホバー地点の流速・流向。場外なら null */
  readoutAt(lat: number, lon: number): CurrentReadout | null {
    if (!this.field) return null;
    if (!this.field.lookup(lon, lat, this.tmp)) return null;
    const u = this.tmp[0];
    const v = this.tmp[1];
    const kt = Math.hypot(u, v);
    const dir = (((Math.atan2(u, v) * 180) / Math.PI) + 360) % 360;
    return { kt, dir };
  }
}
