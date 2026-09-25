---
title: データの置き場所
description: ASIST がこの Mac のどこに何を置くか。
sidebar:
  order: 1
---

ASIST から開発者へ送るデータはありません。設定とデータは、この Mac の `~/Library/Application Support/asist/` にあります。アプリを入れ直しても消えません。

| 場所 | 中身 |
|---|---|
| `settings.json` | 設定 |
| `api-keys.json` | 暗号化した API キー |
| `memory/` | 記憶(Markdown、Git の履歴つき) |
| `conversations/` | 会話ログ |
| `tasks.json` | タスク |
| `notes/` | メモ(1 件が 1 つの Markdown ファイル) |
| `mail-cache.sqlite`、`mail-secrets.json` | 取り込んだメールと、暗号化したパスワード |
| `api-usage.json` | 有料の API の使用量と料金(日ごとの合計) |
| `joblogs/` | Agent のジョブのログ |
| `python/`、`uv-cache/` | uv が取得した Python と、パッケージのキャッシュ |
| `mlx-audio-runtime/`、`embedding-runtime/`、`vap-runtime/` | この Mac で動かすモデルの Python の環境 |

動作ログは `~/Library/Logs/asist/` に日ごとに残ります。

## API キーとパスワード

設定で保存した API キーとメールのパスワードは、Electron の safeStorage で macOS のキーチェーンの鍵を使って暗号化し、平文では書きません。暗号化が使えないときは保存せず、エラーにします。

Agent の CLI、Python のワーカー、音声のエンジンなどの子プロセスには、どの提供元の API キーも渡しません。

## 動作ログ

動作ログには、アプリの出力と、画面の警告とエラーが残ります。キー、トークン、パスワードの値と、保存した API キーは、書く前に伏せるので、不具合の報告にそのまま添えられます。会話の本文は書きません。14 日を過ぎたファイルは消し、1 日のファイルは 20MB までです。設定の「会話」の「動作ログ」から、このフォルダを開けます。

## 設定のファイルのバージョン

設定、タスク、タイマー、ジョブなどの JSON のファイルは、形式のバージョンを持ちます。ASIST を新しくして古いバージョンのファイルを開くと、元のファイルを `<名前>.v<バージョン>.json` として同じ場所に残してから、今の形式に移します。今の ASIST より新しい ASIST が書いたファイルや、壊れていて読めないファイルがあるときは、ファイルの場所と理由を表示して止まり、元のファイルには手を付けません。

外へ送るものは、[外へ送るもの](/docs/privacy/external/)にあります。
