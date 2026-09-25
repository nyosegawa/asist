---
title: Updating and uninstalling
description: How new versions arrive, and how to remove ASIST.
sidebar:
  order: 8
---

## Updating

ASIST checks the GitHub Releases for a new version when it opens, and every 6 hours while it is open. If there is one, it downloads it in the background and installs it the next time you quit ASIST. It never restarts on its own while you are talking or while a job is running.

To install the update right away, click "Restart now" under "About" in the settings. The current version and the update status also appear there.

If a released version has a problem, a fixed version with a higher number is released. There is no way to go back to an earlier version.

## Uninstalling

1. Quit ASIST.
2. Move ASIST from the Applications folder to the Trash.
3. To remove your settings and data as well, move the following folders to the Trash. This also removes your memory, notes, tasks, conversation history and fetched mail.
   - `~/Library/Application Support/asist/`
   - `~/Library/Logs/asist/`
4. To remove the key used to encrypt your saved API keys and mail passwords, find "asist Safe Storage" in Keychain Access and delete it.
5. To remove the microphone and calendar permissions as well, run the following in Terminal.

```bash
tccutil reset Microphone com.nyosegawa.asist
tccutil reset Calendar com.nyosegawa.asist
```

The full list of where your data is kept is in [Where your data is kept](/en/docs/privacy/).
