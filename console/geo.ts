// かいしょう — 3D海図の座標変換ユーティリティ
//
// 海しるは経度・緯度（EPSG:4326）で返る。地球儀（PLAN4 0.4 A案）に載せるため、
// 緯度経度を半径 R の球面座標 Vector3 に写す。式は PLAN4 記載の
//   (cosφ·cosλ, sinφ, cosφ·sinλ)
// に一致（φ=緯度, λ=経度, いずれもラジアン）。

import * as THREE from "three";

export const EARTH_RADIUS = 1;

/** 緯度経度[度] → 球面上の Vector3（既定は単位球） */
export function latLonToVec3(lat: number, lon: number, radius = EARTH_RADIUS): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(lat);
  const lambda = THREE.MathUtils.degToRad(lon);
  const cosPhi = Math.cos(phi);
  return new THREE.Vector3(
    radius * cosPhi * Math.cos(lambda),
    radius * Math.sin(phi),
    radius * cosPhi * Math.sin(lambda)
  );
}

/** 球面上の Vector3 → 緯度経度[度] */
export function vec3ToLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  const r = v.length() || 1;
  return {
    lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1))),
    lon: THREE.MathUtils.radToDeg(Math.atan2(v.z, v.x)),
  };
}

/** 3D点 → 画面ピクセル座標（近傍探索・ラベル配置用）。カメラ裏側なら null */
export function projectToScreen(
  v: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number
): { x: number; y: number } | null {
  const p = v.clone().project(camera);
  // NDC の z が [-1, 1] の外はクリップ範囲外（z>1: カメラ裏側/近クリップ手前、
  // z<-1: 遠クリップより奥）。どちらも画面座標として無効なので弾く。
  if (p.z < -1 || p.z > 1) return null;
  return {
    x: (p.x * 0.5 + 0.5) * width,
    y: (-p.y * 0.5 + 0.5) * height,
  };
}

/**
 * 地球儀のこちら側（カメラから見えている面）かどうか。
 * 球の裏に回り込んだマーカーを隠すのに使う。
 */
export function isFacingCamera(point: THREE.Vector3, camera: THREE.Camera): boolean {
  const toCam = camera.position.clone().sub(point);
  // 球中心が原点なので、点の法線は point 自身の向き
  return point.dot(toCam) > 0;
}
