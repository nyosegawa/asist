# X に投稿する紹介動画

X に投稿するための 40 秒の動画です。1920×1080、30fps で、H.264 と AAC で書き出します。できた動画はコミットせず、必要なときに作ります。

```bash
npm run promo:video   # promotions/x-promo-video/out/asist-promo.mp4 ができます(2 分ほど)
```

Google Chrome、ffmpeg、[uv](https://docs.astral.sh/uv/) が要ります。見出しの書体は Google Fonts から読み込むので、ネットワークにつながっている必要があります。

## 作り方

`npm run promo:video` は、次の 3 つを順に実行します。途中の段だけをやり直すこともできます。

1. `node scripts/render.mjs` が、headless Chrome で `index.html` を開き、GSAP のタイムラインを 1 コマずつ進めて `out/frames/` に JPEG を書き出します。効果音を鳴らす時刻も `out/cues.json` に書き出します。`node scripts/render.mjs 3.5 14.5` のように秒を渡すと、その時刻の静止画だけを `out/stills/` に書き出します。
2. `uv run scripts/audio.py` が、BGM に効果音を重ねて `out/audio.wav` を作ります。
3. `sh scripts/encode.sh` が、ffmpeg でコマと音声をまとめます。音量は -20 LUFS です。

絵と動きは `index.html` と `timeline.js` にあります。ブラウザーで `index.html#play` を開くと音なしで通して再生し、`index.html#t=12.5` のように開くとその秒で止まります。画像は `website/public/` のものを参照しています。

| 秒 | 場面 |
|---|---|
| 0–8 | 「ねぇ ASIST、今日の予定は?」にロボットが予定のカードで答え、見出しを出す |
| 8–14.8 | カード。質問ごとに天気、為替、メールの下書きのカードが出て、最後に 8 枚が扇形に並ぶ |
| 14.8–18.6 | 実際のアプリの画面。最後に Dock へ寄って次の場面につなぐ |
| 18.6–23.2 | ミニアプリ。Dock の各アイコンに手書きのラベルが付く |
| 23.2–29 | Agent。依頼、承認、codex か claude への引き渡し、完了までを見せる |
| 29–33.8 | 記憶。夜に書かれる日記 |
| 33.8–40 | 「さあ、はじめましょう。」とサイトの URL(asist-agent.com) |

## BGM

`assets/bgm/musicbox.mp3` は、Gemini API の Lyria 3.5 で作ったオルゴールの曲です。`python3 scripts/bgm.py musicbox` で作り直せます。API キーは環境変数 `GEMINI_API_KEY` か `~/.config/gemini/api_key` から読み、料金は 1 曲 $0.08 です。曲は 58 秒あるので、40 秒で切って最後をフェードアウトさせています。生成した音声には、Google の SynthID の透かしが入っています。

## 効果音

効果音は `scripts/sfx.py` が numpy で合成します。画面で起きる出来事を 11 種類に分け、それぞれにオルゴール(`musicbox`)、クレイ(`clay`)、Mac の画面(`mac`)の 3 通りの音を用意しています。`uv run scripts/sfx.py` を実行すると、33 の音を 1 つずつ `out/sfx/` に書き出します。

動画ではクレイの音を使い、鳴らす場面を絞っています。カードが出る瞬間、手書きのラベル、Dock へ寄るところ、記憶の場面は無音です。どの出来事にどの音を当てるかは `scripts/audio.py` の `KIND` にあり、`--sfx` でパターンを、`--sfx-db` で効果音全体の音量を変えられます。`--sfx none` にすると効果音を入れません。
