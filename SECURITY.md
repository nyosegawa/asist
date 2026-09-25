# セキュリティ / Security

## 脆弱性の報告

脆弱性を見つけたときは、公開の Issue には書かず、GitHub の非公開の報告から送ってください。

https://github.com/nyosegawa/asist/security/advisories/new

再現の手順、影響を受ける版、考えられる影響を書いてもらえると、早く確かめられます。受け取ったら返事をし、直した版を出すまでの見通しをお知らせします。

特に知りたいのは、次のようなものです。

- 画面(renderer)や、Agent のジョブが開いたページから、preload の API や main のプロセスを使えるもの
- 確認の画面を通らずに、Agent のジョブが始まったり、ファイルやカレンダーやメールが変わったりするもの
- 保存した API キーやメールのパスワードが、平文で書き出されたり、子プロセスに渡ったりするもの
- 署名したアプリのマイクやカレンダーの許可を、ほかのプロセスが使えるもの

## 対象の版

直すのは最新の版だけです。

---

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub instead:

https://github.com/nyosegawa/asist/security/advisories/new

Include the steps to reproduce it, the affected version and the impact you expect. You will get a reply, and an estimate of when a fixed version will be released.

Reports of particular interest:

- The renderer, or a page an agent job opens, reaching the preload API or the main process
- An agent job starting, or a file, calendar event or mail changing, without the confirmation dialog
- A saved API key or mail password written out in plain text or passed to a child process
- Another process using the microphone or calendar permissions granted to the signed app

## Supported versions

Only the latest release is fixed.
