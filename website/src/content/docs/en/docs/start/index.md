---
title: What you need
description: What to have ready before you use ASIST.
sidebar:
  order: 1
---

## Mac

You need a Mac with Apple silicon and macOS 14 or later. ASIST does not run on an Intel Mac.

Speech recognition and the other local models run on your Mac. With all of them in use, they take about 4.1 GB of memory in total, and choosing Qwen3-TTS for reading aloud takes about 2 GB more. You can choose Qwen3-TTS on a Mac with 16 GB of memory or more. The breakdown is in [Memory requirements](/en/docs/reference/memory/).

## An API key for the conversation model

You need an API key from one of these providers. You enter it during the first-time setup. Usage is billed to your account with that provider.

| Provider | Where to create a key |
|---|---|
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) |
| Google | [aistudio.google.com](https://aistudio.google.com/apikey) |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) |

## Optional

| What | What it is for |
|---|---|
| The `codex` or `claude` CLI | Agent jobs and tidying the memory. Install the one you want to use and sign in to it first. See [The Agent CLI](/en/docs/start/agent-cli/). |
| VOICEVOX or AivisSpeech | Reading Japanese aloud. If it is in your Applications folder, ASIST starts it in the background and connects to it. |

The uv bundled with the app creates the Python environments for the models that run on your Mac. uv also downloads Python at that point, so you do not need to install anything beforehand.
