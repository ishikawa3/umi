// かいしょう — 波浪レイヤ（フェーズ16）
//
// 有義波高（wave-analysis/v2）を球面の点描ヒートマップに。うみ「なみ」の陰画。
// 高波域を白い泡のように明るく（淡ティール→白の単一色相ランプ）。静的描画。

import * as THREE from "three";
import type { WaveSample } from "../src/api";
import { latLonToVec3 } from "./geo";
import { softDisc } from "./sprite";

const WAVE_R = 1.007;
const LOW = new THREE.Color("#1f5a68"); // 穏やか（暗い海に近い）
const HIGH = new THREE.Color("#eafffb"); // 高波（明るい白い泡）

export interface WaveReadout {
  height: number;
  lat: number;
  lon: number;
}

/** 有義波高の点描レイヤ。p5..p95 で正規化して当日の実データに追従（絶対固定にしない） */
export class WavesLayer {
  private readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly capacity: number;
  private samples: WaveSample[] = [];
  private lo = 0;
  private hi = 1;

  constructor(globe: { add(o: THREE.Object3D): void }, capacity = 8000) {
    this.capacity = capacity;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size: 0.05,
      map: softDisc(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
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

  /** 色スケール範囲（凡例用）。単位 m */
  range(): { lo: number; hi: number } {
    return { lo: this.lo, hi: this.hi };
  }

  setData(samples: WaveSample[]): void {
    this.samples = samples;
    const heights = samples.map((s) => s.height).sort((a, b) => a - b);
    if (heights.length) {
      this.lo = heights[Math.floor(heights.length * 0.05)];
      this.hi = heights[Math.floor(heights.length * 0.95)];
      if (this.hi - this.lo < 0.1) this.hi = this.lo + 0.1;
    }
    const n = Math.min(samples.length, this.capacity);
    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const p = latLonToVec3(s.lat, s.lon, WAVE_R);
      pos.setXYZ(i, p.x, p.y, p.z);
      const t = THREE.MathUtils.clamp((s.height - this.lo) / (this.hi - this.lo), 0, 1);
      c.copy(LOW).lerp(HIGH, t);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
    this.points.geometry.computeBoundingSphere();
  }

  /** ホバー地点の最近傍サンプルの有義波高。近傍に無ければ null */
  readoutAt(lat: number, lon: number, maxDeg = 0.6): WaveReadout | null {
    let best = maxDeg * maxDeg;
    let hit: WaveSample | null = null;
    for (const s of this.samples) {
      const dlat = s.lat - lat;
      const dlon = (s.lon - lon) * Math.cos((lat * Math.PI) / 180);
      const d2 = dlat * dlat + dlon * dlon;
      if (d2 < best) {
        best = d2;
        hit = s;
      }
    }
    return hit ? { height: hit.height, lat: hit.lat, lon: hit.lon } : null;
  }
}
