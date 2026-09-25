# ASIST の紹介ページ

ASIST を紹介する 1 ページのサイトです。ビルドの道具はリポジトリの Vite をそのまま使います。

```bash
npm run website         # http://localhost:5194 。同じ tailnet の端末からも Tailscale の名前で開けます
npm run website:build   # website/dist に書き出します
```

- `index.html` が文章と構成、`src/style.css` が見た目です。`src/main.js` は、スクロールで各段を表示するだけです。
- `public/img/` のクレイ・ジオラマの絵は、OpenAI Images API(gpt-image-2.5-flare)で生成しました。ヒーローの絵のロボットは、頭だけに見えないように、あとから画像の編集で体を描き足しています。
- `public/cards/` のカードと `public/img/home.jpg` のホーム画面は、`npm run demo` の simple のテーマで撮ったものです。`public/icons/` は、アプリの Dock のアイコンを縮小したものです。アプリの見た目が変わったら撮り直します。
- 日記のカードの文面は、demo の固定のデータから引用しています。
- [紹介動画](../promotions/x-promo-video/)は、ここの画像を参照して作ります。画像を差し替えると、次に作る動画にも反映されます。
