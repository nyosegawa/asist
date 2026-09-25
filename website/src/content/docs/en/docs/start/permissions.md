---
title: Microphone and calendar permissions
description: Give ASIST the macOS permissions it needs, or give them again later.
sidebar:
  order: 4
---

ASIST uses the microphone when you talk by voice, and the macOS calendar when you connect your calendar. For both, macOS asks for permission the first time ASIST uses them.

## Microphone

macOS asks for permission when you click "Check the microphone" during the first-time setup. Click "Allow".

If you did not allow it, or want to allow it later, do the following:

1. Open System Settings > Privacy & Security > Microphone.
2. Turn on ASIST in the list.
3. Quit ASIST and open it again.

![The setup screen when the microphone was not allowed](/screens/en/setup-mic-denied.webp)

## Calendar

When you turn on the "Turn the calendar integration on" switch under "Integrations" in the settings, macOS asks for access to your calendars. Click "Allow Full Access". ASIST not only reads events but also adds, changes and deletes them, so it needs full access.

To allow it later, go to System Settings > Privacy & Security > Calendars and set ASIST to "Full Access". Then return to ASIST and click "Refresh the list".

The whole procedure for connecting is in [Connect your calendar](/en/docs/start/calendar/).

## Resetting the permissions

If ASIST does not appear in the list, or the permissions seem wrong, remove them in Terminal, then open ASIST again and allow them again.

```bash
tccutil reset Microphone com.nyosegawa.asist
tccutil reset Calendar com.nyosegawa.asist
```

macOS ties these permissions to the app's signature. If you reinstall ASIST from anywhere other than the official Releases, you have to give the permissions again.
