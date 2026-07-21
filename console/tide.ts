// かいしょう — 検潮所レイヤ（フェーズ17）
//
// 全国の検潮所を、現在潮位で球面から突き出す「棒（ステム＋ヘッド）」の監視盤として。
// うみ「しおどき」の陰画。潮位は当日 min/max で正規化（地点間の絶対値比較は無意味）。

import * as THREE from "three";
import type { TideStation, TideDay } from "../src/api";
import { latLonToVec3, isFacingCamera } from "./geo";
import type { Globe } from "./scene";

const BASE_R = 1.006;
const BAR = 0.07; // 正規化潮位1.0のときの棒の高さ（半径比）
const LOW = new THREE.Color("#2c6b74"); // 低潮位（暗いシアン）
const HIGH = new THREE.Color("#eafffd"); // 高潮位（明るいシアン白）

export interface TideEntry {
  station: TideStation;
  day: TideDay | null;
}

const MINUTES = 1440;
export function tideAt(day: TideDay, minute: number): number {
  const idx = Math.min(Math.floor((minute / MINUTES) * day.tide.length), day.tide.length - 1);
  return day.tide[idx];
}
/** 当日 min/max で 0..1 に正規化 */
export function tideNorm(day: TideDay, minute: number): number {
  return (tideAt(day, minute) - day.min) / (day.max - day.min || 1);
}

export class TideLayer {
  private readonly globe: Globe;
  private readonly group = new THREE.Group();
  private readonly heads: THREE.InstancedMesh;
  private readonly stems: THREE.LineSegments;
  private readonly halo: THREE.Mesh;
  private readonly capacity: number;

  private entries: TideEntry[] = [];
  private tops: THREE.Vector3[] = []; // 各棒の先端（ピック・ハロー用）
  private highlighted = -1;
  private onHighlightCb: ((index: number) => void) | null = null;
  private readonly color = new THREE.Color();

  constructor(globe: Globe, capacity = 400) {
    this.globe = globe;
    this.capacity = capacity;

    const headGeo = new THREE.SphereGeometry(0.009, 10, 10);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.heads = new THREE.InstancedMesh(headGeo, headMat, capacity);
    this.heads.count = 0;
    this.heads.frustumCulled = false;
    this.heads.setColorAt(0, new THREE.Color(0xffffff));

    const stemGeo = new THREE.BufferGeometry();
    stemGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 2 * 3), 3));
    stemGeo.setDrawRange(0, 0);
    const stemMat = new THREE.LineBasicMaterial({ color: new THREE.Color("#5ee0d8"), transparent: true, opacity: 0.6 });
    this.stems = new THREE.LineSegments(stemGeo, stemMat);
    this.stems.frustumCulled = false;

    const haloGeo = new THREE.SphereGeometry(0.016, 16, 16);
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthTest: false });
    this.halo = new THREE.Mesh(haloGeo, haloMat);
    this.halo.visible = false;
    this.halo.renderOrder = 3;

    this.group.add(this.stems, this.heads, this.halo);
    this.group.visible = false;
    globe.add(this.group);
  }

  setVisible(v: boolean): void { this.group.visible = v; }
  isVisible(): boolean { return this.group.visible; }
  /** 現在の各棒の先端（ヘッド）の世界座標。潮位で高さが変わるためクラスタ位置に使う */
  headPositions(): readonly THREE.Vector3[] { return this.tops; }
  onHighlight(cb: (index: number) => void): void { this.onHighlightCb = cb; }
  count(): number { return this.entries.length; }
  entryAt(index: number): TideEntry | null { return this.entries[index] ?? null; }

  setData(entries: TideEntry[]): void {
    this.entries = entries.slice(0, this.capacity);
  }

  /** 現在時刻(分)の潮位で棒の高さ・色を再計算 */
  refresh(minute: number): void {
    const n = this.entries.length;
    const m = new THREE.Matrix4();
    const stemPos = this.stems.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.tops = [];
    let count = 0;
    for (let i = 0; i < n; i++) {
      const e = this.entries[i];
      const { lat, lon } = e.station;
      const norm = e.day ? THREE.MathUtils.clamp(tideNorm(e.day, minute), 0, 1) : 0;
      const base = latLonToVec3(lat, lon, BASE_R);
      const top = latLonToVec3(lat, lon, BASE_R + norm * BAR);
      this.tops.push(top);
      // ステム
      stemPos.setXYZ(count * 2, base.x, base.y, base.z);
      stemPos.setXYZ(count * 2 + 1, top.x, top.y, top.z);
      // ヘッド
      m.setPosition(top);
      this.heads.setMatrixAt(count, m);
      this.color.copy(LOW).lerp(HIGH, norm);
      this.heads.setColorAt(count, this.color);
      count++;
    }
    this.heads.count = count;
    this.heads.instanceMatrix.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
    stemPos.needsUpdate = true;
    this.stems.geometry.setDrawRange(0, count * 2);
    this.stems.geometry.computeBoundingSphere();
    if (this.highlighted >= 0) this.highlight(this.highlighted, true);
  }

  /** ポインタ位置の最も手前の（こちら側の）検潮所 index。無ければ -1 */
  pickAt(cssX: number, cssY: number): number {
    if (!this.group.visible || this.heads.count === 0) return -1;
    const hits = this.globe.raycastAt(cssX, cssY, [this.heads]);
    for (const h of hits) {
      const id = h.instanceId;
      if (id == null || id >= this.entries.length) continue;
      if (!isFacingCamera(this.tops[id], this.globe.camera)) continue;
      return id;
    }
    return -1;
  }

  highlight(index: number, force = false): void {
    if (index === this.highlighted && !force) return;
    this.highlighted = index;
    if (index < 0 || index >= this.tops.length) {
      this.halo.visible = false;
    } else {
      this.halo.position.copy(this.tops[index]);
      this.halo.visible = true;
    }
    if (!force) this.onHighlightCb?.(index);
  }
}
