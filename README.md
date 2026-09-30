<p align="center"><img src="desktop/build/icon.png" width="96" alt="ABRA logo"></p>

# ABRA

**A**I **B**rowser **R**unner & **A**utomator. *Abrakadabra: your app tests itself.*

Describe a flow in plain language, and an AI drives a real browser through your web app. Save it as a
Playwright test and replay it any time, without AI.

## Features

- **Run AI**: write the task, watch the AI click through your app live
- **Saved tests**: plain Playwright tests, replayed without AI; **Fix with AI** when one breaks
- **Workflow Studio**: chain AI tasks, data extraction, checks, loops and API calls in one browser
- **Video and PDF guide** of every run, in English or Bahasa Indonesia, ready for users and clients
- **Production is blocked**: real addresses cannot be reached by any run
- **Test database reset** before each run, and read-only checks that the data landed
- **Schedules** with Telegram/Slack results, visual checks, accessibility checks, CI export
- **Private**: runs on your own computer, secrets are masked from the AI

## Install

Download from [Releases](https://github.com/angg07/abra/releases/latest):

| OS | File |
|---|---|
| Windows | `ABRA-<version>-win-x64.exe` |
| macOS | `ABRA-<version>-mac-arm64.dmg` (Apple Silicon) or `…-mac-x64.dmg` (Intel) |
| Linux | `ABRA-<version>-linux-x86_64.AppImage` or `…-linux-amd64.deb` |

- The installers are not signed yet. Windows: **More info → Run anyway**. macOS: **System Settings › Privacy &
  Security › Open Anyway**.
- The first start checks what is missing (Chromium, an AI engine such as
  [Claude Code](https://claude.ai/code), optional ffmpeg) and helps you install it.
- Updates install themselves on Windows and Linux; macOS tells you when a new version is out.

From source (Node.js 22.13+):

```bash
npm install
npm run setup   # checks the computer, downloads Chromium
npm run app     # http://127.0.0.1:4321
```

New here? Open the app and press **Try the demo**.

## Good to know

- Everything stays on your computer: the app listens on `127.0.0.1` only.
- Share a project with **Export** / **Import** (`.abr.json`); secrets and history are never in the file.
- Imported tests are code that runs on your computer: import only from people you trust.
- Use test accounts, not production credentials.

## More

The full guide (every feature, settings, database checks, project layout, scripts):
[docs/GUIDE.md](docs/GUIDE.md).

MIT License
