---
title: Microphone permission
description: Give ASIST the macOS microphone permission, or give it again later.
sidebar:
  order: 5
---

ASIST uses the microphone when you talk by voice. macOS asks for permission when you click "Check the microphone" during the first-time setup. Click "Allow".

## Allowing it later

If you did not allow it, or want to allow it later, do the following:

1. Open System Settings > Privacy & Security > Microphone.
2. Turn on ASIST in the list.
3. Quit ASIST and open it again.

![The setup screen when the microphone was not allowed](/screens/en/setup-mic-denied.webp)

## Resetting the permission

If ASIST does not appear in the list, or the permission seems wrong, remove it in Terminal, then open ASIST again and allow it again.

```bash
tccutil reset Microphone com.nyosegawa.asist
```

macOS ties this permission to the app's signature. If you reinstall ASIST from anywhere other than the official Releases, you have to give the permission again.

The calendar permission is covered in [Connecting your calendar](/en/docs/start/calendar/).
