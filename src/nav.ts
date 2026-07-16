/** 全ページ共通の作品ナビゲーション（右下・縦書き） */

const PAGES = [
  { id: "nagare",   title: "ながれ",   href: "./",          desc: "潮流" },
  { id: "kuroshio", title: "くろしお", href: "./kuroshio.html", desc: "海流" },
  { id: "shiodoki", title: "しおどき", href: "./tide.html",  desc: "潮汐" },
  { id: "koe",      title: "こえ",     href: "./koe.html",   desc: "警報" },
  { id: "nemuri",   title: "ねむり",   href: "./nemuri.html", desc: "沈船" },
  { id: "nami",     title: "なみ",     href: "./nami.html",  desc: "波浪" },
  { id: "michi",    title: "みち",     href: "./michi.html", desc: "航路" },
  { id: "koori",    title: "こおり",   href: "./koori.html", desc: "海氷" },
];

export function mountNav(current: string) {
  const nav = document.createElement("nav");
  nav.className = "hud hud-nav";
  nav.setAttribute("aria-label", "作品一覧");
  for (const p of PAGES) {
    const a = document.createElement("a");
    a.href = p.href;
    a.textContent = p.title;
    a.dataset.desc = p.desc;
    if (p.id === current) {
      a.className = "current";
      a.setAttribute("aria-current", "page");
    }
    nav.appendChild(a);
  }
  document.body.appendChild(nav);
}
