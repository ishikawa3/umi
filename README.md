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
| [ねむり](https://ishikawa3.github.io/umi/nemuri.html) | 日本の海に眠る名もなき沈船を、ゆっくり明滅する星図に | 沈船 v3 |
| [なみ](https://ishikawa3.github.io/umi/nami.html) | 有義波高と波向きの点描 ※海しるの波浪データ（wave-analysis）の提供が止まり、v3 にも後継が無いため作品ナビから外した（ページは残す） | 波浪 v2（提供終了） |
| [みち](https://ishikawa3.github.io/umi/michi.html) | 船舶通航量（AIS）を単一色相の航路の光として。主要港・海峡が動脈のように灯る | 船舶通航量 2024（v3 ImageService・ベータ版）。取れないときは 2020（v2） |
| [こおり](https://ishikawa3.github.io/umi/koori.html) | オホーツク海・北海道沖の海氷を白で。オフシーズンは「凍っていない」ことを静かに語る | 海氷 v2 |
| [すじ](https://ishikawa3.github.io/umi/suji.html) | 日本近海の海底ケーブル経路を、微光が流れる海の神経として | 海底ケーブル v3 |
| [なまえ](https://ishikawa3.github.io/umi/namae.html) | 海の底につけられた名前。元号・暦・星・草木・鳥・人名などの系統（公式の「由来分類」）で名づけられた海山の名が、縦書きで浮かび上がる | 海底地形名 v3 |

同じ海しるデータを、この詩的な作品群とは真逆の「業務システム風」に見せる別サイト
[**かいしょう / VTS Console**](https://ishikawa3.github.io/umi/console/)（three.js/WebGL の3D海図）もあります。
設計は `docs/PLAN4.md`。

海しるAPI v2 は2027年12月末に提供終了予定（[v3 リリースノート](https://www.msil.go.jp/data/api/v3-release/)）。
v3 に移行先がある項目（沈船・海底ケーブル・海底地形名・等深線）は v3 に移行済み。海洋速報・海氷・航行警報は
v3 での提供方法が「検討中」のため、当面 v2 のまま（移行対応表で提供開始を確認したら移行する）。

共通の道具立て:

- `src/api.ts` — 海しるAPIクライアント（429リトライ・v2 MapServer の汎用クエリ `arcgisQuery`・v3 FeatureService の全件取得 `featureQueryAll`）
- `src/landmask.ts` — [国土地理院 淡色地図タイル](https://maps.gsi.go.jp/development/ichiran.html)の
  海色判定から水域マスク／陸シルエットを生成（海しるは陸のデータを持たないため）
- `src/japanmap.ts` — 日本全域ページ共通のメルカトル投影＋背景
- `src/render.ts` — 単一色相シーケンシャルランプと粒子描画
- 等深線 v3 — ながれページの海底地形の背景線

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
同じ海しるデータを three.js/WebGL の業務システム風コンソールで見せる別サイトの構想は
`docs/PLAN4.md`（第4期・かいしょう / VTS Console）に。

## 注意

推算値・速報は鑑賞用。航海には海上保安庁刊行の潮汐表・海図・水路通報を使用のこと（API利用規約より）。
