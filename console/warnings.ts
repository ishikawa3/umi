// かいしょう — 航行警報レイヤ（フェーズ15）
//
// 海しる navigational-warnings/v2 を、地球儀上の点として描く運用レイヤ。
// うみ「こえ」の陰画。色は PLAN4 0.6 の機能色3色（正常シアン／注意アンバー／
// 危険レッド）に、こえの種別を写像する。危険系はやわらかく明滅。

import * as THREE from "three";
import type { NavWarning } from "../src/api";
import { latLonToVec3, isFacingCamera } from "./geo";
import type { Globe } from "./scene";

export interface WarningCategory {
  key: string;
  label: string;
  color: string; // 0.6 の機能色
  danger?: boolean; // 明滅させる危険種別
}

// こえの5種別を機能色3色（危険レッド/注意アンバー/正常シアン）へ写像（ダーク地で高輝度）
export const CATEGORIES: WarningCategory[] = [
  { key: "wreck", label: "沈没・座礁", color: "#ff6b5e", danger: true },
  { key: "work", label: "工事・作業", color: "#f0b64e" },
  { key: "exercise", label: "演習・訓練", color: "#f0b64e" },
  { key: "light", label: "灯台・標識", color: "#5ee0d8" },
  { key: "other", label: "その他", color: "#5ee0d8" },
];
const CAT_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function detectCategory(name: string, body: string): WarningCategory {
  const text = name + " " + body;
  if (/沈没|沈船|座礁/.test(text)) return CAT_BY_KEY.get("wreck")!;
  if (/工事|作業|設置|撤去/.test(text)) return CAT_BY_KEY.get("work")!;
  if (/演習|訓練/.test(text)) return CAT_BY_KEY.get("exercise")!;
  if (/灯台|灯浮標|消灯|点灯|標識/.test(text)) return CAT_BY_KEY.get("light")!;
  return CAT_BY_KEY.get("other")!;
}

export interface ConsoleWarning extends NavWarning {
  category: WarningCategory;
  seed: number; // 明滅位相
}

export function toConsoleWarnings(raw: NavWarning[]): ConsoleWarning[] {
  return raw.map((r) => ({
    ...r,
    category: detectCategory(r.name, r.body),
    seed: Math.random() * Math.PI * 2,
  }));
}

const PIN_RADIUS = 1.02; // 海(半径1)の上に浮かせる。裏側は海に隠れる（depthTest）

/** 地球儀に警報ピンを載せ、フィルタ・ハイライト・明滅を管理するレイヤ */
export class WarningsLayer {
  private readonly globe: Globe;
  private readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly halo: THREE.Mesh;
  private readonly capacity: number;

  private all: ConsoleWarning[] = [];
  private visible: ConsoleWarning[] = [];
  private filter: string | null = null;
  private highlighted = -1;
  private onHighlightCb: ((index: number) => void) | null = null;

  // 明滅対象（visible配列内のindex）と各インスタンスの基本色
  private baseColors: THREE.Color[] = [];
  private readonly tmpColor = new THREE.Color(); // pulse で毎フレーム再利用（clone回避）

  constructor(globe: Globe, capacity = 2000) {
    this.globe = globe;
    this.capacity = capacity;

    const geo = new THREE.SphereGeometry(0.0075, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff }); // 実色は instanceColor
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // instanceColor バッファを確保
    this.mesh.setColorAt(0, new THREE.Color(0xffffff));

    const haloGeo = new THREE.SphereGeometry(0.015, 16, 16);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
      depthTest: false,
    });
    this.halo = new THREE.Mesh(haloGeo, haloMat);
    this.halo.visible = false;
    this.halo.renderOrder = 3;

    this.group.add(this.mesh, this.halo);
    this.group.visible = true;
    globe.add(this.group);
    globe.onFrame((t) => this.pulse(t));
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  isVisible(): boolean {
    return this.group.visible;
  }

  onHighlight(cb: (index: number) => void): void {
    this.onHighlightCb = cb;
  }

  setData(warnings: ConsoleWarning[]): void {
    this.all = warnings;
    this.rebuild();
  }

  setFilter(key: string | null): void {
    this.filter = key;
    this.highlighted = -1;
    this.halo.visible = false;
    this.rebuild();
  }

  activeFilter(): string | null {
    return this.filter;
  }

  visibleWarnings(): ConsoleWarning[] {
    return this.visible;
  }

  countByCategory(key: string): number {
    return this.all.filter((w) => w.category.key === key).length;
  }

  total(): number {
    return this.all.length;
  }

  private rebuild(): void {
    this.visible = this.filter ? this.all.filter((w) => w.category.key === this.filter) : this.all;
    const n = Math.min(this.visible.length, this.capacity);
    this.baseColors = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const w = this.visible[i];
      m.setPosition(latLonToVec3(w.lat, w.lon, PIN_RADIUS));
      this.mesh.setMatrixAt(i, m);
      const c = new THREE.Color(w.category.color);
      this.baseColors.push(c);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private pulse(tMs: number): void {
    if (!this.group.visible || this.mesh.count === 0 || !this.mesh.instanceColor) return;
    let touched = false;
    // 描画中のインスタンス数（= baseColors.length）までに限定。visible が capacity を
    // 超えても範囲外 index を触らない。Color は tmpColor を再利用して割り当てを避ける。
    for (let i = 0; i < this.mesh.count; i++) {
      const w = this.visible[i];
      if (!w.category.danger) continue;
      const b = 0.7 + 0.3 * Math.sin(tMs / 900 + w.seed);
      this.tmpColor.copy(this.baseColors[i]).multiplyScalar(b);
      this.mesh.setColorAt(i, this.tmpColor);
      touched = true;
    }
    if (touched) this.mesh.instanceColor.needsUpdate = true;
  }

  /** ポインタ位置の最も手前の（かつ地球のこちら側の）ピンのindex。無ければ -1 */
  pickAt(cssX: number, cssY: number): number {
    if (!this.group.visible) return -1;
    const hits = this.globe.raycastAt(cssX, cssY, [this.mesh]);
    for (const h of hits) {
      const id = h.instanceId;
      if (id == null || id >= this.visible.length) continue;
      const w = this.visible[id];
      if (!isFacingCamera(latLonToVec3(w.lat, w.lon, PIN_RADIUS), this.globe.camera)) continue;
      return id;
    }
    return -1;
  }

  highlight(index: number): void {
    if (index === this.highlighted) return;
    this.highlighted = index;
    if (index < 0 || index >= this.visible.length) {
      this.halo.visible = false;
    } else {
      const w = this.visible[index];
      this.halo.position.copy(latLonToVec3(w.lat, w.lon, PIN_RADIUS));
      (this.halo.material as THREE.MeshBasicMaterial).color.set(w.category.color);
      this.halo.visible = true;
    }
    this.onHighlightCb?.(index);
  }

  highlightedIndex(): number {
    return this.highlighted;
  }
}
