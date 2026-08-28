// かいしょう PWA サービスワーカー（依存なし・スコープ /umi/console/）
//
// うみ本体（/umi/sw.js・スコープ /umi/）とは別スコープの独立アプリとして動く。
// console 配下のページは、より限定的なこの登録が優先して制御する。
// - ナビゲーション: ネットワーク優先 → 失敗時はキャッシュ → start_url シェル
// - 静的アセット: stale-while-revalidate
// - 「海しる」等の外部APIは同一オリジン外なので SW を通さない
// パスは SW 自身の位置（/umi/console/sw.js）基準の相対。

// CacheStorage はスコープではなく「オリジン」単位で共有される。うみ（/umi/）の
// SW と同居するため、自分のプレフィックスのキャッシュだけを世代管理し、
// 他アプリのキャッシュには触れない。
const PREFIX = "kaisho-";
const CACHE = PREFIX + "v1";
const OFFLINE_URL = "./"; // start_url（/umi/console/）
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest", "./icons/kaisho-192.png", "./icons/kaisho-512.png"];

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
        .then((res) => {
          // 書き込みを fetch イベントの寿命に紐づけ、応答直後に SW が止まっても
          // 途中で打ち切られないようにする（応答自体は待たせない）
          event.waitUntil(cachePut(req, res.clone()));
          return res;
        })
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
        .then((res) => { event.waitUntil(cachePut(req, res.clone())); return res; })
        // キャッシュが無いまま undefined を返すと respondWith が TypeError になり、
        // 本来のネットワークエラーが隠れる（オフライン初回など）。エラーを伝播させる。
        .catch((err) => { if (cached) return cached; throw err; });
      // cached を即返す場合、背景の再検証が SW 停止で打ち切られないよう延命する。
      // respondWith が解決する前（＝イベントが有効なうち）に呼ぶ必要がある。
      event.waitUntil(network.catch(() => {}));
      return cached || network;
    })
  );
});

// 引数なしの caches.match() はオリジン内の全キャッシュを横断するため、
// 同居する うみ（umi-*）のエントリまで拾ってしまう。
// 例えば kaisho-v2 へ上げても umi-v1 に残る同一URLの古いコピーを返してしまい、
// 世代更新が効かない。自分の CACHE だけを検索対象にする。
function fromCache(req) {
  return caches.open(CACHE).then((c) => c.match(req));
}

// waitUntil(undefined) が例外になるブラウザがあるため、常に Promise を返す
function cachePut(req, res) {
  if (!res || res.status !== 200 || res.type === "opaque") return Promise.resolve();
  return caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
}
