// かいしょう — 粒子・点描のやわらかい円スプライト（painterly。四角い点を避ける）

import * as THREE from "three";

let cached: THREE.Texture | null = null;

/** 中心が濃く外周が透明な放射グラデーションの円テクスチャ（共有） */
export function softDisc(): THREE.Texture {
  if (cached) return cached;
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  cached = new THREE.CanvasTexture(c);
  return cached;
}
