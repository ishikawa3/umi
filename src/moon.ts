/** 月齢と潮名（大潮・中潮・小潮・長潮・若潮）。潮汐は月が起こすので、しおどきに添える。 */

const SYNODIC = 29.530588853;

/** 既知の新月（2000-01-06 18:14 UTC）からの経過で月齢を求める */
export function moonAge(d: Date): number {
  const newMoon = Date.UTC(2000, 0, 6, 18, 14);
  const days = (d.getTime() - newMoon) / 86_400_000;
  return ((days % SYNODIC) + SYNODIC) % SYNODIC;
}

/** 月齢からの潮名（釣り暦などで使われる一般的な対応） */
export function tideName(age: number): string {
  const n = Math.round(age) % 30;
  if ([0, 1, 2, 14, 15, 16, 29].includes(n)) return "大潮";
  if ([7, 8, 9, 21, 22, 23].includes(n)) return "小潮";
  if (n === 10 || n === 24) return "長潮";
  if (n === 11 || n === 25) return "若潮";
  return "中潮";
}

/** 小さな月を満ち欠け付きで描く */
export function drawMoon(canvas: HTMLCanvasElement, age: number) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const cx = w / 2;
  const cy = w / 2;
  const r = w / 2 - 1.5;
  const p = age / SYNODIC; // 0=新月, 0.5=満月
  ctx.clearRect(0, 0, w, w);
  // 影の円
  ctx.fillStyle = "rgba(226, 238, 248, 0.16)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // 明部（右から満ち、右から欠ける）
  const k = Math.cos(2 * Math.PI * p);
  ctx.fillStyle = "rgba(226, 238, 248, 0.9)";
  ctx.beginPath();
  if (p <= 0.5) {
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false); // 右半分
    ctx.ellipse(cx, cy, r * Math.abs(k), r, 0, Math.PI / 2, -Math.PI / 2, k > 0);
  } else {
    ctx.arc(cx, cy, r, Math.PI / 2, (3 * Math.PI) / 2, false); // 左半分
    ctx.ellipse(cx, cy, r * Math.abs(k), r, 0, (3 * Math.PI) / 2, Math.PI / 2, k > 0);
  }
  ctx.fill();
}
