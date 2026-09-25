---
title: Where your data is kept
description: What ASIST keeps on this Mac, and where.
sidebar:
  order: 1
---

ASIST sends no data to its developer. The settings and data are in `~/Library/Application Support/asist/` on this Mac. Reinstalling the app doesn't remove them.

| Location | Contents |
|---|---|
| `settings.json` | Settings |
| `api-keys.json` | Encrypted API keys |
| `memory/` | Memory (Markdown, with its history in Git) |
| `conversations/` | Conversation logs |
| `tasks.json` | Tasks |
| `notes/` | Notes (one Markdown file per note) |
| `mail-cache.sqlite`, `mail-secrets.json` | Fetched mail, and encrypted passwords |
| `api-usage.json` | Usage and cost of the paid APIs (daily totals) |
| `joblogs/` | Logs of Agent jobs |
| `python/`, `uv-cache/` | The Python that uv downloaded, and the package cache |
| `mlx-audio-runtime/`, `embedding-runtime/`, `vap-runtime/` | Python environments for the models that run on this Mac |

The app log is kept in `~/Library/Logs/asist/`, one file per day.

## API keys and passwords

API keys and mail passwords saved in the settings are encrypted with Electron's safeStorage, using a key from the macOS keychain, and are never written as plain text. If encryption isn't available, ASIST doesn't save them and shows an error instead.

Child processes such as the Agent CLI, the Python workers and the speech engines receive no provider's API key.

## App log

The app log holds the app's output and the warnings and errors from the screen. The values of keys, tokens and passwords, and the API keys you saved, are masked before they are written, so you can attach the log to a bug report as it is. The text of your conversations is not written. Files older than 14 days are deleted, and the file for one day is limited to 20MB. You can open this folder from "App log" in "Conversation" in the settings.

## Settings file versions

JSON files such as the settings, tasks, timers and jobs carry the version of their format. When a newer ASIST opens a file in an older version, it first keeps the original file in the same place as `<name>.v<version>.json`, then moves the file to the current format. If a file was written by a newer ASIST than the one you are running, or is damaged and can't be read, ASIST shows the file's location and the reason and stops, leaving the original file untouched.

What ASIST sends out is listed in [What ASIST sends out](/en/docs/privacy/external/).
