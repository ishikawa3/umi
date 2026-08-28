// かいしょう PWA サービスワーカー（依存なし・スコープ /umi/console/）
//
// うみ本体（/umi/sw.js・スコープ /umi/）とは別スコープの独立アプリとして動く。
// console 配下のページは、より限定的なこの登録が優先して制御する。
// - ナビゲーション: ネットワーク優先 → 失敗時はキャッシュ → start_url シェル
// - 静的アセット: stale-while-revalidate
// - 「海しる」等の外部APIは同一オリジン外なので SW を通さない
// パスは SW 自身の位置（/umi/console/sw.js）基準の相対。

const CACHE = "kaisho-v1";
const OFFLINE_URL = "./"; // start_url（/umi/console/）
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest", "./icons/kaisho-192.png", "./icons/kaisho-512.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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
