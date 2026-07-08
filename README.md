# うみ — 海しるAPIでみる日本の海

**https://ishikawa3.github.io/umi/**

海上保安庁「[海しる](https://portal.msil.go.jp/)」（海洋状況表示システム）の公開APIを使った、
日本の海のデータアート集。フレームワークなしの Vite + TypeScript + Canvas 2D。

| 作品 | 内容 | 主なAPI |
|---|---|---|
| [ながれ](https://ishikawa3.github.io/umi/) | 潮流のフローフィールド。数千の粒子が実際の流向・流速で泳ぐ | 潮流推算 v3 |
| [くろしお](https://ishikawa3.github.io/umi/kuroshio.html) | 黒潮・対馬暖流・宗谷暖流の流軸を流れる光 | 海洋速報 v2 |
| [しおどき](https://ishikawa3.github.io/umi/tide.html) | 全国の検潮所が潮位で明滅する「呼吸する日本地図」＋潮位曲線 | 潮汐推算 v3 |
| [こえ](https://ishikawa3.github.io/umi/koe.html) | 航行警報 — いま海で起きていることば | 航行警報 v2 |

共通の道具立て:

- `src/api.ts` — 海しるAPIクライアント（429リトライ・v2 ArcGIS形式の汎用クエリ）
- `src/landmask.ts` — [国土地理院 淡色地図タイル](https://maps.gsi.go.jp/development/ichiran.html)の
  海色判定から水域マスク／陸シルエットを生成（海しるは陸のデータを持たないため）
- `src/japanmap.ts` — 日本全域ページ共通のメルカトル投影＋背景
- `src/render.ts` — 単一色相シーケンシャルランプと粒子描画
- 等深線 v2 — ながれページの海底地形の背景線

## 開発

```sh
npm install
npm run dev      # 開発サーバー
npm run build    # dist/ に静的ビルド
```

mainにpushするとGitHub Actionsで自動デプロイ。認証は `Ocp-Apim-Subscription-Key`
ヘッダー。`src/config.ts` のキーはポータル公開の**試用キー**（予告なく停止されうる）。
継続運用時は[利用方法](https://portal.msil.go.jp/howtouse)から個別キーを申請して差し替える。

拡張の設計は `docs/PLAN.md`（第1期・完了）と `docs/PLAN2.md`（第2期）に。

## 注意

推算値・速報は鑑賞用。航海には海上保安庁刊行の潮汐表・海図・水路通報を使用のこと（API利用規約より）。
