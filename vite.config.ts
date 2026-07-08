import { defineConfig } from "vite";
import { resolve } from "node:path";

// GitHub Pages (https://ishikawa3.github.io/umi/) 配下で配信するため
export default defineConfig({
  base: "/umi/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        kuroshio: resolve(__dirname, "kuroshio.html"),
        tide: resolve(__dirname, "tide.html"),
        koe: resolve(__dirname, "koe.html"),
        nemuri: resolve(__dirname, "nemuri.html"),
      },
    },
  },
});
