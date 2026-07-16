/** Date → "YYYY.MM.DD HH:MM JST"（JST表示用の共通フォーマッタ） */
export function formatJst(d: Date): string {
  const j = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}.${p(j.getUTCMonth() + 1)}.${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())} JST`;
}
