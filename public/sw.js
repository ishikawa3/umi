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
  // プリキャッシュの失敗は握りつぶさない。握りつぶすとシェル未取得のまま
  // インストール成功扱いになり、オフライン復帰が壊れていても気づけない。
  // ここで reject させればインストールが失敗し、次の読み込みで再試行される。
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
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
        .catch(async (err) => {
          const hit = (await fromCache(req)) || (await fromCache(OFFLINE_URL));
          if (hit) return hit;
          throw err; // 下記と同じ理由で undefined を返さない
        })
    );
    return;
  }

  event.respondWith(
    fromCache(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { cachePut(req, res.clone()); return res; })
        // キャッシュが無いまま undefined を返すと respondWith が TypeError になり、
        // 本来のネットワークエラーが隠れる（オフライン初回など）。エラーを伝播させる。
        .catch((err) => { if (cached) return cached; throw err; });
      return cached || network;
    })
  );
});

// 引数なしの caches.match() はオリジン内の全キャッシュを横断するため、
// 同居する かいしょう（kaisho-*）のエントリまで拾ってしまう。
// 例えば umi-v2 へ上げても kaisho-v1 に残る同一URLの古いコピーを返してしまい、
// 世代更新が効かない。自分の CACHE だけを検索対象にする。
function fromCache(req) {
  return caches.open(CACHE).then((c) => c.match(req));
}

function cachePut(req, res) {
  if (!res || res.status !== 200 || res.type === "opaque") return;
  caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
}
