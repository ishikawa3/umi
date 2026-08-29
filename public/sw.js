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

// ビルド時に、このアプリのエントリJS/CSS（ハッシュ付き）が注入される。
// 初回訪問では SW がまだページを制御しておらず、これらは CacheStorage に
// 入らないため、precache に含めないとオフライン起動でアプリが動かない。
const BUILD_ASSETS = [/* __PRECACHE_ASSETS__ */];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // プリキャッシュの失敗は握りつぶさない。握りつぶすとシェル未取得のまま
  // インストール成功扱いになり、オフライン復帰が壊れていても気づけない。
  // ここで reject させればインストールが失敗し、次の読み込みで再試行される。
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([...PRECACHE, ...BUILD_ASSETS])));
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

// この SW のスコープは /umi/ なので、かいしょうの SW が有効になるまでは
// /umi/console/ 配下もこの SW の制御下に入ってしまう。かいしょうは独立アプリで
// 自前の SW がオフラインを担うため、ここでは一切扱わず素通しする。
// （console のHTML/アセットを umi-* に取り込む、console のナビゲーションに
//   うみのシェルを返す、といった混線を防ぐ）
const CONSOLE_PATH = new URL("./console/", self.location).pathname;
// 末尾スラッシュ無し（/umi/console）へのナビゲーションも同じ領分なので除外する
const CONSOLE_PATH_BARE = CONSOLE_PATH.slice(0, -1);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部API等は素通し
  // かいしょうの領分は触らない（/umi/console と /umi/console/... の両方）
  if (url.pathname === CONSOLE_PATH_BARE || url.pathname.startsWith(CONSOLE_PATH)) return;

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
// 同居する かいしょう（kaisho-*）のエントリまで拾ってしまう。
// 例えば umi-v2 へ上げても kaisho-v1 に残る同一URLの古いコピーを返してしまい、
// 世代更新が効かない。自分の CACHE だけを検索対象にする。
function fromCache(req) {
  // ignoreVary が必要な理由: Vite はモジュールscriptに crossorigin を付けるため
  // ページからのアセット要求は CORS モードになり Origin ヘッダを伴う。一方
  // install の addAll は同一オリジン要求で Origin を送らない。配信側が
  // Vary: Origin を返すと両者が別物とみなされ、precache 済みでも一致しない。
  // ここで扱うのはハッシュ付きアセットとシェルだけで内容交渉はしないため、
  // URL 一致で引く。
  return caches.open(CACHE).then((c) => c.match(req, { ignoreVary: true }));
}

// waitUntil(undefined) が例外になるブラウザがあるため、常に Promise を返す
function cachePut(req, res) {
  if (!res || res.status !== 200 || res.type === "opaque") return Promise.resolve();
  return caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
}
