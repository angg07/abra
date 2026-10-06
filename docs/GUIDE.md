# ABRA: the full guide

Everything about installing and using ABRA. The short version is the [README](../README.md).

A local web app for end-to-end testing of web applications with Playwright. Describe a flow in plain
language and an AI drives a real browser, or replay saved Playwright tests without AI. You watch it live,
and every run can produce a video, a step-by-step PDF guide and an HTML report.

## Install

ABRA runs on your own computer (Windows, macOS or Linux) and opens in your browser at
http://127.0.0.1:4321 (it listens on this computer only).

### Portable build (no Node.js needed)

Unpack `abra-linux-x64.tar.gz` or `abra-win-x64.zip`, then run `start.sh` (Linux) or
double-click `start.cmd` (Windows). The app opens in its own window: an installed Edge, Chrome or Chromium (else the
Chromium the app downloaded) in app mode, without tabs or address bar and with its own profile; closing the window
stops the app. The launcher starts the app in the background and returns, so no terminal or console window
stays open (output: `app/data/app.log`). Until Chromium is there (the very first start on Linux or macOS) it opens in the browser. On the first start the **Before you start**
screen checks the computer, downloads Chromium with one click and shows how to install what is still missing
on that OS (also under **Requirements** in the sidebar, and in `INSTALL.txt`). Projects, history and videos are
saved inside the unpacked folder.

Build them from this repository with `npm run package -- linux` or `npm run package -- win` (into `dist/`;
only files in git go in, never `.env`, run history or your projects' tests).

### Desktop app (Electron)

Installers with the app in its own window, a menu entry and an icon:

| OS | File | Install |
|---|---|---|
| Linux | `ABRA-<version>-linux-x86_64.AppImage` or `…-linux-amd64.deb` | AppImage: make it executable and run it. deb: `sudo apt install ./ABRA-…deb` |
| Windows | `ABRA-<version>-win-x64.exe` | run the installer (for this user, no admin rights needed) |
| macOS | `ABRA-<version>-mac-arm64.dmg` (Apple Silicon) or `…-mac-x64.dmg` (Intel) | open the dmg, drag the app to Applications |

The files are not signed yet: Windows SmartScreen says "Windows protected your PC" (More info, then Run anyway);
macOS (the app is signed ad hoc, not by an Apple developer) says it "cannot be opened": System Settings ›
Privacy & Security › **Open Anyway**, or run `xattr -cr "/Applications/ABRA.app"` once. A 1.0.0 dmg
that says "is damaged" on Apple Silicon was built without that signature: sign it on the Mac with
`codesign --force --deep --sign - "/Applications/ABRA.app"`, then the `xattr` command, or use a newer release.

Updates: the app looks for a new release of github.com/angg07/abra when it starts and every 6 hours. Windows
and Linux download it in the background and install it when you close the app (or at once: **Restart now**).
macOS only says a new version is out, since installing it needs an app signed by an Apple developer.
Versions before 1.1.0 have no updater: install 1.1.0 once by hand.

The window is Electron; the app itself runs on the Node inside the installer, as in the portable build. Its code
is copied to the user's data folder on the first start and after an update, and that is where projects,
history, videos, settings and `.env` live: `~/.config/ABRA/app` (Linux),
`%APPDATA%\ABRA\app` (Windows), `~/Library/Application Support/ABRA/app` (macOS).
An update replaces the code, never those. Versions up to 1.0.x were called AI Browser Runner: the first start of
ABRA moves that data folder (`…/AI Browser Runner/app`) to the new one. The first start shows **Before you start** (Chromium, AI engine,
ffmpeg), like the portable build.

Build: `cd desktop && npm install && npm run dist -- linux` (or `win`; Windows builds on Linux need `wine`).
macOS builds only on a Mac: the **Desktop app** workflow in GitHub Actions builds all three (run it by hand, or
push a tag like `v1.0.0` to also attach the files to a release). Output: `dist/desktop/`.

### What each OS needs before the first use

| | Linux | Windows | macOS |
|---|---|---|---|
| **Node.js 22.13+** (not for the portable build) | https://nodejs.org or `sudo apt install nodejs` | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| **Chromium** (required) | the app downloads it (~650 MB, once); if it will not start: `sudo npx playwright install-deps chromium` | the app downloads it | the app downloads it |
| **AI engine** (required): Claude Code, or an API key in Settings › AI | `curl -fsSL https://claude.ai/install.sh \| bash`, then `claude` once to sign in | PowerShell: `irm https://claude.ai/install.ps1 \| iex`, then `claude` | `curl -fsSL https://claude.ai/install.sh \| bash`, then `claude` |
| **ffmpeg** with libx264 (optional: videos) | `sudo apt install ffmpeg` / `sudo dnf install ffmpeg` / `sudo pacman -S ffmpeg` | `winget install Gyan.FFmpeg`, then reopen the app | `brew install ffmpeg` |

### From source

In the app's folder:

```bash
npm install
npm run setup   # checks the above and downloads Chromium
npm run app     # http://127.0.0.1:4321
```

The app writes API keys and secrets to `.env` in the app's folder (git-ignored) from **Settings**; you can also
add them by hand:

```bash
SECRET_ADMIN_PASS=...                 # a secret, used as {{ADMIN_PASS}}
```

### Share a project

In a project, **Edit → Export project** saves `<project>.abr.json`. On another computer, **Projects → ⋯ → Import project**
reads it. Secrets, database passwords, the codebase folder, login sessions and run history are never in the file: after importing,
the app lists the secrets and environment values to add. Test files are code that runs on your computer:
import only files from people you trust.

To move everything at once, **Projects → ⋯ → Export all** saves every project in one JSON file
(`abra-projects-<date>.abr.json`); **Import** reads it too. Every project in it is checked before
anything is written; projects that already exist are skipped, imported as new copies or overwritten, as you choose.

### Let the AI read the application's code (optional)

**Projects › Edit › Source code › Codebase folders**: the full path of the application's source on this computer, one per line (e.g. the frontend and the backend when they live in separate folders); **Choose folder…** browses to one and adds it.
With the Claude Code engine, AI runs, test repairs and workflow blocks may read it (Read, Grep, Glob only; no
edits, no shell) to find page addresses, form rules and element ids. `.env*`, keys (`*.pem`, `*.key`, SSH keys),
`.npmrc`, `auth.json` and `.git/` stay closed. Pass or fail is still judged from the screen. Other engines ignore it.

### Checking a Windows install

The app is developed on Linux. On Windows, check once:

1. `npm run setup` shows ✅ for Node and both Chromium builds.
2. Import a project file and replay one of its tests: it passes and the live view shows the browser.
3. Start a long replay and press Stop: it stops, and Task Manager shows no Chromium left from it.
4. With Claude Code installed, start an AI run: it starts (no `spawn claude ENOENT`).

## Using it

The app opens on **Projects**: one per application you test (e.g. a web shop and its admin panel). Each project has its own
saved tests (`tests/<project>/`) and history; its optional start URL and default environment are filled in
for you. An environment you pick in a form is remembered for the project until you change its default environment
(the pencil on its card, or **Edit project** in the project menu). Providers, secrets, login sessions, environments and
schedules are shared by all projects.

| Tab | What it does |
|---|---|
| **Run AI** | URL + instructions in plain language. The AI (Claude Code, or any OpenAI-compatible API) drives the browser. Under the instructions, **Insert** chips type an environment value, a secret (🔒, the AI sees only the name), `{{today}}` or `{{random}}` at the cursor; the counter shows the length (at most 10,000 characters). **Title and files** folds away the optional title and upload files. **Run settings** sums up AI, environment and output; **Change settings** opens the choices (AI, model, login session, environment, video, PDF guide, Show the browser). |
| **Record flow** | Opens Playwright codegen on your desktop. Click through the flow, close the window, then copy the script, save it as a test, or give it to the AI as a route map. |
| **Saved tests** | Plain `@playwright/test` files in `tests/<project>/`, replayed without AI. A test that never ran shows **▶**; every row has a **⌄** menu with Run, Edit, Show code and Delete, and **View last result** opens its last run. Tick tests and a **suite bar** appears with the login session, environment, repeat, Video, PDF and Show browser, plus **Run N tests**; these choices also apply to ▶ and Run. **Edit** opens the script and its CSV data set. **Edit in Run AI** (row menu, or the Edit test dialog) opens the Run AI form the test was made from, its files included; change it, press Run AI, then **Update <test>** on the result overwrites the test (its CSV data set stays). A test saved before 1.6.0 gets its form from History, or only its first URL when no run matches. A failing test gets **Fix with AI**. Files: templates and documents a test uploads live in `tests/<project>/files/<test>/` (Edit test › Files, 20 MB each); the script uses `setInputFiles('{{file.name}}')`. Files added to a Run AI are kept with the test when you save it. |
| **Workflows** | Blocks chained in one browser, edited in Workflow Studio (below). |
| **History** | Every run with its result, steps, errors, video, PDF guide and HTML report. **All / Passed / Failed** show their counts; each row says what ran (AI run, Replay, Suite, Workflow, Fix), how many steps, and who ran it (the AI, Playwright or a schedule). |

The **Projects** page shows this week's runs over every project, how many passed, the projects whose last run failed, and the runs going now; each project card shows its pass rate over the last runs, its tests, workflows and environment, with **Open** (Saved tests) and **Run AI**.

### Saved prompts

**Run AI > Save prompt** keeps the whole form (URL, title, instructions, expected result, AI, environment, session,
video/PDF choices, an attached flow and its files) without running it. **Saved prompts** under the form lists them per
project with their last run. **Use** fills the form back, then press Run AI, or change it and press Save prompt to
update it (**New prompt** starts an empty one). Running a prompt keeps it. Saved prompts and their files are in
`tests/<project>/prompts/` and `prompt-files/`, and travel with project export and import (an export that holds
saved prompts needs ABRA 1.3.0 or newer to import).

### Attached instructions
Under **What should the AI do?**, **Attach instructions (.md)** adds a Markdown or text file (up to 100 KB) with
detailed test instructions, for example a test plan you wrote or generated elsewhere. Its text goes to the AI together
with the task, so the task itself can stay one line ("Test the order form, follow the attached plan"). The file is
kept with a saved prompt, Edit in Run AI and Run again, and the run page names it. Changed the file? Attach it again
(**Replace instructions**): ABRA keeps the text as it was when you attached it.

### Workflows

**Workflows > New workflow** (or **Edit** on a row) opens Workflow Studio as a page: **Add a block** on the left
adds below the selected block (inside a selected Loop, unless it is a Loop itself), the chain in the middle shows each
block's main setting, and the chosen block's settings are on the right, with **More options** (name, key, a URL to
open first, continue on failure), **↑ Up**, **↓ Down** and **Remove**. With no block selected, the right side holds the
workflow's description and parameters. **⋯** has **Show JSON** (edit the whole workflow) and **Delete workflow**.
**Run options** on the Workflows page sets the login session, environment, Video and PDF for **Run**. All blocks run in
one browser, so a login or an open page carries over. Stored as `tests/<project>/workflows/<id>.json`.

| Block | Does |
|---|---|
| **AI task** | the AI does a task in the browser, optionally opening a URL first |
| **Extract** | the AI reads the page into typed fields (`string`, `number`, `boolean`, `list`); `Rp 1.250.000` reads as 1250000 |
| **Check** | the AI checks a condition on the page without changing anything: pass or fail |
| **Saved test** | runs a saved Playwright test (no AI) with the browser's login |
| **Loop** | runs the blocks inside once per CSV row, or per item of an earlier list |
| **API call** | calls an API (production is blocked; on a shared server only environment addresses) |

Blocks use earlier results: `{{params.member}}` (asked when the run starts), `{{blocks.order.orderNo}}` (a field of
the block with key `order`), `{{item}}` / `{{item.column}}` inside a loop, plus the usual `{{appUrl}}`,
`{{today}}` and secrets. A failing block stops the workflow unless it is set to continue. The run shows each block
with its result, data and a screenshot of the page; all data is kept with the run. Workflows are saved as
`tests/<project>/workflows/<id>.json`.

### Test values

Write these in instructions, URLs and tests; they are filled in when the step runs:

| Value | Example result |
|---|---|
| `{{today}}`, `{{today+3}}`, `{{today-7}}` | `2026-09-26` |
| `{{today\|DD/MM/YYYY}}` | `26/09/2026` |
| `{{now}}`, `{{random}}`, `{{runId}}` | `2026-09-26 14:05`, `523510`, `20260926140512` |
| `{{baseUrl}}`, `{{anyName}}` | values of the chosen environment (**Settings > Environments**) |
| `{{data.column}}` | the current row of the test's data set (`tests/<project>/data/<test>.csv`) |
| `{{file.name}}` | a file of the test (Edit test › Files) or of the Run AI (Files): the path is filled in when the upload runs |
| `{{ADMIN_PASS}}` | a secret: typed into the browser, never shown to the AI |

Saved tests use them through `fill('...')` from `tests/support/vars.ts`; the app adds those calls when it
saves a test. They also work in a constant at the top of the file, except `{{data.…}}` and `{{file.…}}`,
which need a running test. A test with a data set runs once per row when replayed on its own.

### Production is blocked

In **Settings > Environments**, add an environment with the real addresses (e.g. `appUrl=https://example.com`)
and tick **Production**. Those host names are then made unresolvable in every browser the app starts (the AI's,
replays, and `npx playwright test`, via Chromium's `--host-resolver-rules`), so no request reaches them. A run that
tries is stopped and shown as **Blocked**. A production environment cannot be picked for a run, and its addresses
cannot appear in another environment. Exact host names only: `staging.example.com` stays allowed. Record flow
(codegen) only checks its start address. See `app/guard.cjs`.

### Projects, secrets and parallel runs

The app has no accounts: it runs on your computer, for you. **Secrets** are given to projects
(**Settings > Secrets**): a run can only use its own project's secrets. Saved login sessions also belong to one
project.

**Parallel runs**: up to `MAX_RUNS` runs (AI, replays, fixes, workflows) go at once, each in its own browser
(default `MAX_RUNS=2`; each browser needs a few hundred MB of memory). More runs wait in line. Start another run
while one goes: each run in progress gets a chip in the sidebar that opens it (the browser, its steps, Stop). Runs that reset
the same test database always take turns. Browser debugging ports come from 9400–9499.

A run next to others only starts when the computer has at least 2.5 GB of free memory (`MIN_FREE_MB=2500`); until
then it waits and says so, and finished runs' browsers (otherwise kept 5 minutes for "Save login session") close to
make room. The first run always starts. On macOS free memory is not checked (the system reports too little), so
`MAX_RUNS` alone decides there. If the app is closed mid-run (killed, crashed, the computer
ran out of memory), History shows that run as **Interrupted** the next time the app starts.

The live view only runs while a run's page is open, or while the run records a video, builds a PDF guide or is a
workflow: a run you are not watching costs much less CPU. Videos are encoded with 2 threads and a short lookahead,
about 300 MB of memory at 1080p instead of ~700 MB.

**Show browser** (Run AI, Saved tests) unticked: the run starts in the background, as a chip in the sidebar, and you
stay on the page you are on. When it ends, a summary card shows the result (status, duration, tests passed, the first
error) with **Open result**; when the app's window is not in front, a system notification says so too. Click the chip
to watch a background run. The choice is remembered.

The app's own data (run history) is one SQLite file, `app/data/app.db` (Node's built-in `node:sqlite`); back it
up by copying it. An old `app/data/history.json` is imported once on start.

### The application's database (per project)

**Projects > Edit > Database**: per environment, where that environment's database is (PostgreSQL or MySQL,
host, port, name, user, password), with **Test connection**. Passwords go to `.env` (`DBPASS_<PROJECT>_<ENV>`),
the rest to `tests/<project>/project.json`. Production environments cannot have one.

**Reset before every run** (PostgreSQL): the database is recreated from a clean template, so each run starts
from the same data. Only databases whose name contains `e2e` or `test` are ever reset. An example setup:

- `myapp_e2e_base`: a copy of `myapp_dev` (refresh it with `pg_dump` when you want newer base data)
- `myapp_e2e`: recreated from the base before each run in environment `e2e`
- `http://myapp.e2e.localhost`: the same application code on `myapp_e2e`, via an extra vhost in
  an extra web server site (e.g. nginx `fastcgi_param DB_DATABASE myapp_e2e`)

Tests that create records should each use their own data (e.g. a different customer): many apps reject
repeated records as duplicates.

**Post-checks**: after the UI steps, a saved test can check that the record landed with the right values
(`tests/support/db.ts`, the run's project and environment decide which database):

```ts
import { dbQuery } from '../support/db';
const [order] = await dbQuery('select status from orders where order_no = $1', [orderNo]);
expect(order).toMatchObject({ status: 'paid' });
```

PostgreSQL uses `$1`, MySQL `?`. Every query runs in a READ ONLY transaction that is rolled back.

### Scheduled suites and notifications

**Settings > Schedules**: run saved tests at a set time on chosen days (they queue like your own runs). The
result goes to Telegram (message + HTML report; secret `TELEGRAM_TOKEN` + chat id) and/or Slack (secret
`SLACK_WEBHOOK`). The app must be running at that time; a run missed by up to 30 minutes still starts.

### Pages, addresses and runs

Every page has its own address (`#/p/<project>/tests`, `#/p/<project>/run/<run id>`, `#/settings`, …): bookmark it, share
it, refresh it, and the browser's **Back** and **Forward** move between pages. The project switcher keeps the page you
are on. While a run goes on, its page shows how far it is (**Test 2 of 6** for replays, the number of steps for an AI run)
and **Back** leaves it running as a chip in the sidebar. Click a step to see that moment: its screenshot when the run made
a PDF guide, otherwise the video jumps there. **Stop** keeps the last screen and sums up what was done.

Confirmations (delete, leave with unsaved changes) are ABRA's own dialog; deleting a project asks you to type its name.
**New project** asks only for a name, a start URL and an environment; everything else is in **Edit project**.

### Requirements and Report a problem

**Requirements** (sidebar) lists what this computer needs: the required tools (Node.js, Chromium) and the optional
ones (ffmpeg for videos, Claude Code), each with what it needs, what was found and why; a command to copy where one
helps, and **Install** for Chromium. The sidebar badge counts the tools that need attention. On the very first start the
same page shows **Continue**.

**Report a problem** (sidebar, or **⋯ › Report a problem with this run** on a run) is a form: a title, what happened, an
optional run, and what to attach (the app log's last 200 lines, the run's video, a screenshot of ABRA in the desktop
app). **What will be sent** shows the issue as you type, secrets removed. **Send to GitHub** opens a filled-in GitHub
issue and puts the attachments in a folder (`app/data/reports/<time>/`, kept 30 days): drag them into the issue, since a
link cannot carry files.

On a phone, a bar at the bottom holds Projects, Run AI, Tests, History and **More** (the full menu). Press **N** anywhere
outside a text field to open Run AI.

### PDF guides for users and clients

**Settings > PDF guide**: language (English or Bahasa Indonesia), company name, accent color and a logo on the
cover. In Indonesian the step sentences are translated by pattern ("Klik tombol “Login”", "Isi kolom
“Username”"), dates and labels follow; the AI's notes (always English) are left out.

### Editing a PDF guide

A run's PDF guide can be edited before it goes out: open the run (History), then **Edit guide**. Change the title,
add a description, rewrite or delete steps, move them, replace a step's screenshot (**Replace image**, or paste one
with Ctrl+V into the step) or remove it, and add **section headings**, **notes** (green) and
**warnings** (red) between them; **Save and make PDF** writes the PDF again. In text, `**bold**`, lines starting
with `- ` become bullets and web addresses become links. The guide's document and screenshots are kept next to
the PDF (`app/guides/<name>/`); guides made before this feature cannot be edited (run again).

### Visual checks

In **Edit**, **Insert visual check** adds `await expect(page).toHaveScreenshot(...)` (Playwright's own visual
comparison). The first run saves the baseline next to the test (`tests/<project>/<test>.spec.ts-snapshots/`);
later runs fail when the screen changed and show expected, actual and difference. **Accept as new baseline**
takes the current screens after an intended change. Hide changing parts (dates, numbers) with `mask`.

### Accessibility

**Settings > Recording & screen > Check accessibility**: every page a run opens is checked with axe-core
(WCAG 2 A/AA). Serious and critical problems are listed per page, apart from app errors, in the result card,
the HTML report, History and notifications.

### Appearance

**Settings > Appearance**: Dark (the default), Light, or System (follows the computer, also when it switches).
It applies at once and is kept per computer. The fonts ship with the app, so it looks the same offline.

### Continuous integration

**Saved tests > Export CI workflow** writes `.github/workflows/e2e.yml`: on every push to `main` (or by hand,
optionally for chosen test files) GitHub runs the app's unit tests and the saved tests headless, keeping the
Playwright report as an artifact. Set the listed secrets on GitHub under the same names, and the variable
`E2E_VARS` to the environment values as JSON. GitHub cannot reach `*.test` addresses on your computer: point
`E2E_VARS` at a staging environment.

## Project layout

```
app/
  server.mjs         HTTP API, runs (AI, replay, fix), settings
  index.html         the UI: markup (app.js = behaviour, app.css = styles)
  agents.mjs         AI engines: Claude Code CLI, OpenAI-compatible API
  mcp-proxy.mjs      sits between the AI and Playwright MCP: fills {{...}}, masks secrets
  stage.mjs          live view (CDP screencast), highlight box, error capture, video recorder
  replay.mjs         runs saved tests (replay.config.ts, steps-reporter.cjs)
  recorder.mjs       Record flow (Playwright codegen)
  guide.mjs          PDF step-by-step guide (guide-i18n.mjs: Indonesian wording)
  report.mjs         HTML report
  library.mjs        projects, saved tests, data sets and workflow files
  workflow.mjs       workflow blocks: validation, {{blocks.x}} references, AI prompts, reading answers
  studio.js          Workflow Studio (the editor in the browser)
  store.mjs          the app database (app/data/app.db): run history
    history.mjs        run history (runs table)
  scheduler.mjs      scheduled suites; notify.mjs sends Telegram/Slack messages
  vars-core.cjs      {{...}} test values, shared by the proxy and tests
  guard.cjs          production block list (browser flags, checks)
  test/              unit tests for the app itself: npm run test:app
tests/<project>/     a project: project.json, its saved tests, data/ (CSV data sets), files/ (upload files per test)
tests/support/       helpers shared by all tests (fill() values, dbQuery)
```

Local only, git-ignored: `tests/<project>/` (your projects hold app addresses and data: to version them,
keep them in your own private repo or remove `tests/*` from `.gitignore` in a private fork), `.env`, `app/data/` (`app.db` with accounts and history, login sessions with cookies), `app/recordings/`,
`app/guides/`. A video opens with a 3-second title card: the project's logo and application name (Projects › Edit › Branding; without a logo the one from Settings › PDF guides) and the run's title. A caption bar at the bottom names each step as it happens (number + action, in the PDF guide's language, at most 10 words, no full stop). A step inside a form or modal zooms in on it for up to 4 seconds (up to 2x; full pages are not zoomed). Waits of more than 5 seconds between steps play at 4x with a "4x" badge after the first 2 seconds; the part after the last step plays as recorded. Only the newest videos and PDF guides are kept (**Settings > Recording**, default 50).

## Security notes

- The server listens on `127.0.0.1` only, and there is no sign-in: it rejects requests from other sites (CSRF)
  and unknown host names (DNS rebinding), which is what keeps other websites in your browser away from it.
- Imported projects (`.abr.json`) are checked (only test, data, workflow and screenshot files, nothing outside
  the project folder), but their tests are still code that runs on your computer.
- Secrets are masked by value in everything the AI reads. It is best-effort: an AI that deliberately
  evaluates a script to spell out a field's value could still see it. Use test accounts, not production
  credentials.
- Login sessions (`app/data/sessions/<project>/`) contain cookies; treat them like passwords.

## Scripts

| Command | |
|---|---|
| `npm run app` | start the app |
| `npm run setup` | check Node, ffmpeg and Claude Code; install the browsers |
| `npm run test:app` | the app's own unit and integration tests (about 20 s, headless) |
| `npm test` | run all saved tests from the CLI (headed) |
| `npm run ui` | Playwright UI mode |
| `npm run codegen` | Playwright codegen |
