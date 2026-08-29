import { defineConfig, type Plugin } from "vite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * 各PWAのService Workerに、そのアプリのハッシュ付きアセットを注入する。
 *
 * 初回訪問では SW がまだページを制御していないため、エントリJS/CSS は
 * CacheStorage に入らない。precache に含めないと「インストール直後に
 * オフラインで開くとシェルだけ出てアプリが起動しない」状態になる。
 * ビルド後のHTMLから参照アセット（script/modulepreload/stylesheet）を
 * 収集し、SW内のプレースホルダへ埋め込む。
 */
function pwaPrecache(): Plugin {
  return {
    name: "pwa-precache",
    apply: "build",
    closeBundle() {
      const dist = resolve(__dirname, "dist");
      // うみは複数ページ、かいしょうは console/ 配下の1ページ
      const apps = [
        { sw: join(dist, "sw.js"), html: ["index.html", "kuroshio.html", "tide.html", "koe.html",
            "nemuri.html", "nami.html", "michi.html", "koori.html", "suji.html"] },
        { sw: join(dist, "console", "sw.js"), html: [join("console", "index.html")] },
      ];
      for (const app of apps) {
        if (!existsSync(app.sw)) continue;
        const assets = new Set<string>();
        for (const rel of app.html) {
          const file = join(dist, rel);
          if (!existsSync(file)) continue;
          const html = readFileSync(file, "utf8");
          // src="/umi/assets/…" / href="/umi/assets/…"（modulepreload と CSS を含む）
          for (const m of html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)) assets.add(m[1]);
        }
        const list = [...assets].sort();
        const sw = readFileSync(app.sw, "utf8");
        const injected = sw.replace(
          "/* __PRECACHE_ASSETS__ */",
          list.map((a) => JSON.stringify(a)).join(", ")
        );
        writeFileSync(app.sw, injected);
        this.info?.(`pwa-precache: ${app.sw} に ${list.length} 件のアセットを注入`);
      }
    },
  };
}

// GitHub Pages (https://ishikawa3.github.io/umi/) 配下で配信するため
export default defineConfig({
  base: "/umi/",
  plugins: [pwaPrecache()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        kuroshio: resolve(__dirname, "kuroshio.html"),
        tide: resolve(__dirname, "tide.html"),
        koe: resolve(__dirname, "koe.html"),
        nemuri: resolve(__dirname, "nemuri.html"),
        nami: resolve(__dirname, "nami.html"),
        michi: resolve(__dirname, "michi.html"),
        koori: resolve(__dirname, "koori.html"),
        suji: resolve(__dirname, "suji.html"),
        // かいしょう（業務システム風・three.js）は独立サイトとして同居（PLAN4）
        console: resolve(__dirname, "console/index.html"),
      },
    },
  },
});
