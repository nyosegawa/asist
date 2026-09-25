---
title: 必要なもの
description: ASIST を使うために用意するもの。
sidebar:
  order: 1
---

## Mac

Apple Silicon の Mac と、macOS 14 以降が要ります。Intel の Mac では動きません。

声の聞き取りなどのモデルは、この Mac の中で動きます。すべてを使うと、合わせて約 4.1GB のメモリを使い、読み上げに Qwen3-TTS を選ぶとさらに約 2GB を使います。Qwen3-TTS は 16GB 以上のメモリの Mac で選べます。内訳は[メモリの目安](/docs/reference/memory/)にあります。

## 会話のモデルの API キー

次のどれか 1 つの API キーが要ります。初回セットアップで入れます。料金は、その提供元のアカウントにかかります。

| 提供元 | キーを作るところ |
|---|---|
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) |
| Google | [aistudio.google.com](https://aistudio.google.com/apikey) |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) |

## あると使えるもの

| もの | 使うところ |
|---|---|
| `codex` か `claude` の CLI | Agent のジョブと、記憶の整理。使うほうをインストールして、認証を済ませておきます。準備は [Agent の CLI](/docs/start/agent-cli/) にあります。 |
| VOICEVOX か AivisSpeech | 日本語の読み上げ。「アプリケーション」に入れておくと、ASIST が裏で起動してつなぎます。 |

この Mac で動かすモデルの Python の環境は、アプリに同梱した uv が作ります。Python もそのときに uv が取得するので、あらかじめ入れておくものはありません。
