// うみ PWA サービスワーカー（依存なし・スコープ /umi/）
//
// - ナビゲーション: ネットワーク優先 → 失敗時はキャッシュ → start_url シェル（オフライン表示）
// - 静的アセット（ハッシュ付きJS/CSS/画像）: stale-while-revalidate で高速化＆オフライン化
// - 「海しる」等の外部APIは同一オリジン外なので SW を通さない（常にネットワーク）
// パスは SW 自身の位置（/umi/sw.js）基準の相対で、GitHub Pages の /umi/ 配下で正しく解決される。

// CacheStorage はスコープではなく「オリジン」単位で共有される。かいしょう
// （/umi/console/）の SW と同居するため、自分のプレフィックスのキャッシュ
// だけを世代管理し、他アプリのキャッシュには触れない。
const PREFIX = "umi-";
const CACHE = PREFIX + "v1";
const OFFLINE_URL = "./"; // start_url（オフライン時のフォールバック）
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest", "./icons/umi-192.png", "./icons/umi-512.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部API等は素通し

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match(OFFLINE_URL)))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});

function cachePut(req, res) {
  if (!res || res.status !== 200 || res.type === "opaque") return;
  caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
}
