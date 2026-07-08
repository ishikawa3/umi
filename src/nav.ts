/** 全ページ共通の作品ナビゲーション（右下・縦書き） */

const PAGES = [
  { id: "nagare", title: "ながれ", href: "./" },
  { id: "kuroshio", title: "くろしお", href: "./kuroshio.html" },
  { id: "shiodoki", title: "しおどき", href: "./tide.html" },
  { id: "koe", title: "こえ", href: "./koe.html" },
  { id: "nemuri", title: "ねむり", href: "./nemuri.html" },
];

export function mountNav(current: string) {
  const nav = document.createElement("nav");
  nav.className = "hud hud-nav";
  nav.setAttribute("aria-label", "作品一覧");
  for (const p of PAGES) {
    const a = document.createElement("a");
    a.href = p.href;
    a.textContent = p.title;
    if (p.id === current) {
      a.className = "current";
      a.setAttribute("aria-current", "page");
    }
    nav.appendChild(a);
  }
  document.body.appendChild(nav);
}
