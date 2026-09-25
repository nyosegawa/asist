---
title: Agent
description: Agent のジョブのエンジンと、既定のモード。
sidebar:
  order: 6
---

「Agent」で、エンジン(Codex か Claude Code)と、ジョブの既定のモードを選びます。モードは、それぞれの CLI が付けている名前のまま出します。

| エンジン | 調べるだけ | 書き込める |
|---|---|---|
| Claude Code | Plan(読むためのツールだけを許します) | Auto |
| Codex | Read Only(読み取り専用のサンドボックス) | Approve for me(ワークスペースに書けるサンドボックス) |

Auto と Approve for me は、人に尋ねる場面を CLI の自動レビューが判断して進めるモードです。Codex では、ネットワークやワークスペースの外が必要な操作がこのレビューに回ります。

![設定の「Agent」の画面](/screens/ja/settings-agent.webp)
