---
title: Agent
description: The engine for Agent jobs, and the default mode.
sidebar:
  order: 6
---

Under "Agent", choose the engine (Codex or Claude Code) and the default mode for jobs. The modes appear under the names each CLI gives them.

| Engine | Investigate only | Can write |
|---|---|---|
| Claude Code | Plan (allows only the tools for reading) | Auto |
| Codex | Read Only (a read-only sandbox) | Approve for me (a sandbox that can write to the workspace) |

In Auto and Approve for me, whenever the CLI would ask a person, its automatic review makes the call and the job carries on. In Codex, actions that need the network or anything outside the workspace go to this review.

![The Agent page in the settings](/screens/en/settings-agent.webp)
