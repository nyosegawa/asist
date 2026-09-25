/** The timestamps of this fixed data are built relative to the time the demo runs. */

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toUTCString()

export const DEMO_NEWS = {
  topic: 'テクノロジー',
  items: [
    { title: '新型スマートフォン各社出そろう、AI機能の端末内処理が焦点に', url: 'https://example.com/1', source: 'ITmedia', date: hoursAgo(1) },
    { title: '国内のEV急速充電器、設置数が前年比1.5倍に', url: 'https://example.com/2', source: '日本経済新聞', date: hoursAgo(3) },
    { title: '次世代通信6Gの周波数割り当て、総務省が方針案を公表', url: 'https://example.com/3', source: 'Impress Watch', date: hoursAgo(5) },
    { title: 'ローカルLLMの実用化が進む、Apple Siliconで高速推論', url: 'https://example.com/4', source: 'ASCII.jp', date: hoursAgo(9) },
    { title: '国産ロケットの次の打ち上げ、来月上旬に決定', url: 'https://example.com/5', source: 'NHK', date: hoursAgo(14) },
    { title: '大学がプログラミングの授業を必修化、来年度から', url: 'https://example.com/6', source: '朝日新聞', date: hoursAgo(26) }
  ]
}

export const DEMO_SEARCH = {
  query: 'リアルタイム音声対話 レイテンシ',
  results: [
    {
      title: '音声対話システムの応答遅延を500msに抑える設計パターン',
      url: 'https://example.com/a',
      snippet: '認識の部分結果を使って先回りし、文の途中から合成を始めることで、発話の終わりから応答の開始までを短くする。'
    },
    {
      title: 'VADとセマンティック終了判定の比較検証',
      url: 'https://example.com/b',
      snippet: '無音の長さだけで区切る方式と、意味の切れ目を言語モデルで判定する方式を、割り込みの誤検出率で比べた。'
    },
    { title: 'ストリーミングTTSパイプラインの実装', url: 'https://example.com/c', snippet: '文単位で合成し、再生と並行して次の文を作るキューの作り方。' },
    { title: '相槌の自動生成と挿入タイミング', url: 'https://example.com/d', snippet: '相槌を先に用意しておき、応答の生成待ちに再生する。' },
    { title: 'Whisperの部分転写を高速化する', url: 'https://example.com/e', snippet: '末尾2秒だけを再転写して部分結果を更新する。' }
  ]
}

/**
 * The same search answered by Gemini, in the shape the Gemini API returns it: each source is a Google
 * redirect titled with its domain, the cited ones come first, and the Search Suggestions block is
 * HTML with its own stylesheet that the terms of the API require to be shown as it is.
 */
export const DEMO_SEARCH_GOOGLE = {
  query: 'リアルタイム音声対話 レイテンシ',
  results: [
    { title: 'example.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a', site: 'example.com', cited: true },
    { title: 'example.org', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/b', site: 'example.org', cited: true },
    { title: 'example.net', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/c', site: 'example.net' },
    { title: 'example.jp', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/d', site: 'example.jp' }
  ],
  suggestions: [
    '<style>',
    '.container { align-items: center; border-radius: 8px; display: flex; font-family: Google Sans, Roboto, sans-serif; font-size: 14px; line-height: 20px; padding: 8px 12px; }',
    '.chip { display: inline-block; border: solid 1px; border-radius: 16px; min-width: 14px; padding: 5px 16px; text-align: center; user-select: none; margin: 0 8px; -webkit-tap-highlight-color: transparent; }',
    '.carousel { overflow: auto; scrollbar-width: none; white-space: nowrap; margin-right: -12px; }',
    '.headline { display: flex; margin-right: 4px; }',
    '.gradient-container { position: relative; }',
    '.gradient { position: absolute; transform: translate(3px, -9px); height: 36px; width: 9px; }',
    '@media (prefers-color-scheme: light) {',
    '  .container { background-color: #fafafa; box-shadow: 0 0 0 1px #0000000f; }',
    '  .headline-label { color: #1f1f1f; }',
    '  .chip { background-color: #ffffff; border-color: #d2d2d2; color: #5e5e5e; text-decoration: none; }',
    '  .chip:hover { background-color: #f2f2f2; }',
    '  .chip:focus { background-color: #f2f2f2; }',
    '  .chip:active { background-color: #d8d8d8; border-color: #b6b6b6; }',
    '  .logo-dark { display: none; }',
    '  .gradient { background: linear-gradient(90deg, #fafafa 15%, #fafafa00 100%); }',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  .container { background-color: #1f1f1f; box-shadow: 0 0 0 1px #ffffff26; }',
    '  .headline-label { color: #fff; }',
    '  .chip { background-color: #2c2c2c; border-color: #3c4043; color: #fff; text-decoration: none; }',
    '  .chip:hover { background-color: #353536; }',
    '  .chip:focus { background-color: #353536; }',
    '  .chip:active { background-color: #464849; border-color: #53575b; }',
    '  .logo-light { display: none; }',
    '  .gradient { background: linear-gradient(90deg, #1f1f1f 15%, #1f1f1f00 100%); }',
    '}',
    '</style>',
    '<div class="container">',
    '  <div class="headline">',
    '    <svg class="logo-light" width="18" height="18" viewBox="9 9 35 35" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M42.8622 27.0064C42.8622 25.7839 42.7525 24.6084 42.5487 23.4799H26.3109V30.1568H35.5897C35.1821 32.3041 33.9596 34.1222 32.1258 35.3448V39.6864H37.7213C40.9814 36.677 42.8622 32.2571 42.8622 27.0064V27.0064Z" fill="#4285F4"/><path fill-rule="evenodd" clip-rule="evenodd" d="M26.3109 43.8555C30.9659 43.8555 34.8687 42.3195 37.7213 39.6863L32.1258 35.3447C30.5898 36.3792 28.6306 37.0061 26.3109 37.0061C21.8282 37.0061 18.0195 33.9811 16.6559 29.906H10.9194V34.3573C13.7563 39.9841 19.5712 43.8555 26.3109 43.8555V43.8555Z" fill="#34A853"/><path fill-rule="evenodd" clip-rule="evenodd" d="M16.6559 29.8904C16.3111 28.8559 16.1074 27.7588 16.1074 26.6146C16.1074 25.4704 16.3111 24.3733 16.6559 23.3388V18.8875H10.9194C9.74388 21.2072 9.06992 23.8247 9.06992 26.6146C9.06992 29.4045 9.74388 32.022 10.9194 34.3417L15.3864 30.8621L16.6559 29.8904V29.8904Z" fill="#FBBC05"/><path fill-rule="evenodd" clip-rule="evenodd" d="M26.3109 16.2386C28.85 16.2386 31.107 17.1164 32.9095 18.8091L37.8466 13.8719C34.853 11.082 30.9659 9.3736 26.3109 9.3736C19.5712 9.3736 13.7563 13.245 10.9194 18.8875L16.6559 23.3388C18.0195 19.2636 21.8282 16.2386 26.3109 16.2386V16.2386Z" fill="#EA4335"/></svg>',
    '    <svg class="logo-dark" width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="23" fill="#FFF" r="22"/><path d="M33.76 34.26c2.75-2.06 4.8-5.31 5.8-9.26H24v-6h16.04c.39 1.93.65 3.94.65 6 0 9.94-8.06 18-18 18S4.69 34.94 4.69 25c0-9.94 8.06-18 18-18 4.91 0 9.35 1.97 12.6 5.15L30.43 17c-1.61-1.62-3.83-2.62-6.29-2.62-4.95 0-8.96 4.01-8.96 8.96s4.01 8.96 8.96 8.96c3.69 0 6.86-2.23 8.24-5.42h-8.24v-6h13.87c.87 2.16 1.36 4.53 1.36 7 0 4.09-1.36 7.86-3.63 10.88z" fill="#4285F4"/></svg>',
    '  </div>',
    '  <div class="carousel">',
    '    <a class="chip" href="https://vertexaisearch.cloud.google.com/grounding-api-redirect/q1">リアルタイム音声対話 レイテンシ</a>',
    '    <a class="chip" href="https://vertexaisearch.cloud.google.com/grounding-api-redirect/q2">音声対話 応答遅延 短縮</a>',
    '  </div>',
    '</div>'
  ].join('\n')
}
