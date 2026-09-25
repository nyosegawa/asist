# ASIST の紹介ページ

ASIST を紹介する 1 ページのサイトで、https://asist-agent.com で公開しています。ビルドの道具はリポジトリの Vite をそのまま使い、Cloudflare の Worker(`wrangler.jsonc`、`worker.js`)で配信します。www.asist-agent.com は asist-agent.com に転送します。

```bash
npm run website          # http://localhost:5194 で開きます
npm run website:build    # website/dist に書き出します
npm run website:deploy   # 書き出して Cloudflare に公開します(main から)
```

wrangler は `npm run cf -- <コマンド>` で使います。ログインはこのリポジトリの `.wrangler/config` に保存するので、この Mac でほかのアカウントに wrangler でログインしていても混ざりません。初めて公開する前に `npm run cf -- login` で、asist-agent.com のある Cloudflare のアカウントにログインします。確認と公開の手順は [website のスキル](../skills/website/SKILL.md)にあります。

- `index.html` が文章と構成、`src/style.css` が見た目です。`src/main.js` は、スクロールで各段を表示するだけです。
- `public/img/` のクレイ・ジオラマの絵は、OpenAI Images API(gpt-image-2.5-flare)で生成しました。ヒーローの絵のロボットは、頭だけに見えないように、あとから画像の編集で体を描き足しています。
- `public/img/og.png` は、SNS で共有したときに出る画像(1200×630)です。`og/og.html` に文字を載せ、`node website/og/render.mjs` で書き出します。絵の `og/art.png` は、ヒーローの絵を参照に渡して OpenAI Images API で横長に描き直したものです。
- `public/cards/` のカードと `public/img/home.jpg` のホーム画面は、`npm run demo` の simple のテーマで撮ったものです。`public/icons/` は、アプリの Dock のアイコンを縮小したものです。アプリの見た目が変わったら撮り直します。
- 日記のカードの文面は、demo の固定のデータから引用しています。
- [紹介動画](../promotions/x-promo-video/)は、ここの画像を参照して作ります。画像を差し替えると、次に作る動画にも反映されます。
