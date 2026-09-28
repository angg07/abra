# AI Browser Runner

A local web app for end-to-end testing of web applications with Playwright. Describe a flow in plain
language and an AI drives a real browser, or replay saved Playwright tests without AI. You watch it live,
and every run can produce a video, a step-by-step PDF guide and an HTML report.

## Install

AI Browser Runner runs on your own computer (Windows, macOS or Linux). You need:

- **Node.js 22.13 or newer**: Windows `winget install OpenJS.NodeJS.LTS`, macOS `brew install node`, Linux https://nodejs.org or your package manager.
- **ffmpeg** (for videos; everything else works without it): Windows `winget install ffmpeg`, macOS `brew install ffmpeg`, Linux `sudo apt install ffmpeg`.
- **An AI engine**: [Claude Code](https://claude.com/claude-code) signed in with your subscription, or an API key added later in Settings → AI.

Then, in the app's folder:

```bash
npm install
npm run setup   # checks the above and installs the browsers
npm run app     # http://127.0.0.1:4321
```

The app writes API keys and secrets to `.env` in the app's folder (git-ignored) from **Settings**; you can also
add them by hand:

```bash
SECRET_ADMIN_PASS=...                 # a secret, used as {{ADMIN_PASS}}
```

### Share a project

In a project, **Edit → Export project** saves `<project>.abr.json`. On another computer, **Projects → Import**
reads it. Secrets, database passwords, login sessions and run history are never in the file: after importing,
the app lists the secrets and environment values to add. Test files are code that runs on your computer:
import only files from people you trust.

### Checking a Windows install

The app is developed on Linux. On Windows, check once:

1. `npm run setup` shows ✅ for Node and both Chromium builds.
2. Import a project file and replay one of its tests: it passes and the live view shows the browser.
3. Start a long replay and press Stop: it stops, and Task Manager shows no Chromium left from it.
4. With Claude Code installed, start an AI run: it starts (no `spawn claude ENOENT`).

## Using it

The app opens on **Projects**: one per application you test (e.g. a web shop and its admin panel). Each project has its own
saved tests (`tests/<project>/`) and history; its optional start URL and default environment are filled in
for you. Providers, secrets, login sessions, environments and schedules are shared by all projects.

| Tab | What it does |
|---|---|
| **Run AI** | URL + instructions in plain language. The AI (Claude Code, or any OpenAI-compatible API) drives the browser. Optional: login session, environment, recorded flow, video, PDF guide. |
| **Record flow** | Opens Playwright codegen on your desktop. Click through the flow, close the window, then copy the script, save it as a test, or give it to the AI as a route map. |
| **Saved tests** | Plain `@playwright/test` files in `tests/<project>/`. Replay one, or tick several to run a suite, without AI. **Edit** opens the script and its CSV data set. A failing test gets **Fix with AI**. |
| **Workflows** | Blocks chained in one browser, edited in Workflow Studio (below). |
| **History** | Every run with its result, steps, errors, video, PDF guide and HTML report. |

### Workflows

**Workflows > New workflow** opens Workflow Studio: blocks in a vertical chain on a canvas, the chosen block's
settings on the right, **+** between blocks to add one, drag to reorder, and a JSON view. All blocks run in one
browser, so a login or an open page carries over. Stored as `tests/<project>/workflows/<id>.json`.

| Block | Does |
|---|---|
| **AI Task** | the AI does a task in the browser, optionally opening a URL first |
| **Extract** | the AI reads the page into typed fields (`string`, `number`, `boolean`, `list`); `Rp 1.250.000` reads as 1250000 |
| **Validate** | the AI checks a condition on the page without changing anything: pass or fail |
| **Saved test** | runs a saved Playwright test (no AI) with the browser's login |
| **Loop** | runs the blocks inside once per CSV row, or per item of an earlier list |
| **HTTP request** | calls an API (production is blocked; on a shared server only environment addresses) |

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
| `{{ADMIN_PASS}}` | a secret: typed into the browser, never shown to the AI |

Saved tests use them through `fill('...')` from `tests/support/vars.ts`; the app adds those calls when it
saves a test. A test with a data set runs once per row when replayed on its own.

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
(default `MAX_RUNS=2`; each browser needs a few hundred MB of memory). More runs wait in line. Runs that reset
the same test database always take turns. Browser debugging ports come from 9400–9499.

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

### PDF guides for users and clients

**Settings > PDF guide**: language (English or Bahasa Indonesia), company name, accent color and a logo on the
cover. In Indonesian the step sentences are translated by pattern ("Klik tombol “Login”", "Isi kolom
“Username”"), dates and labels follow; the AI's notes (always English) are left out.

### Visual checks

In **Edit**, **Insert visual check** adds `await expect(page).toHaveScreenshot(...)` (Playwright's own visual
comparison). The first run saves the baseline next to the test (`tests/<project>/<test>.spec.ts-snapshots/`);
later runs fail when the screen changed and show expected, actual and difference. **Accept as new baseline**
takes the current screens after an intended change. Hide changing parts (dates, numbers) with `mask`.

### Accessibility

**Settings > Recording & screen > Check accessibility**: every page a run opens is checked with axe-core
(WCAG 2 A/AA). Serious and critical problems are listed per page, apart from app errors, in the result card,
the HTML report, History and notifications.

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
tests/<project>/     a project: project.json, its saved tests, data/ (CSV data sets)
tests/support/       helpers shared by all tests (fill() values, dbQuery)
```

Local only, git-ignored: `tests/<project>/` (your projects hold app addresses and data: to version them,
keep them in your own private repo or remove `tests/*` from `.gitignore` in a private fork), `.env`, `app/data/` (`app.db` with accounts and history, login sessions with cookies), `app/recordings/`,
`app/guides/`. Only the newest videos and PDF guides are kept (**Settings > Recording**, default 50).

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
