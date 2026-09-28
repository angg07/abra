# Standalone App Design

**Date:** 2026-09-28
**Status:** approved in conversation, section by section (A, B, C)

## Intent

AI Browser Runner becomes an app each person installs and runs on their own laptop or PC, instead of one
shared server. One laptop = one person = one set of settings, so accounts, roles and per-user settings are
no longer needed. People share projects by exporting a file and importing it on another laptop.

- **Who installs it now:** developers and QA who are comfortable with a terminal (Node-based install).
- **Later, once this has settled:** a desktop app (Electron) for non-technical users. Not part of this spec;
  nothing here may make it harder (the server stays a local HTTP server on 127.0.0.1).
- **Success:** a colleague on Windows, macOS or Linux runs `npm install && npm run setup && npm run app`,
  imports a project file they received, fills in its secrets, and replays its tests.

Decisions taken in the conversation:

| Question | Decision |
|---|---|
| Share tests between people? | Yes, by export/import (not git, not "no sharing") |
| Accounts, roles, server mode | Removed completely (not kept dormant) |
| Install method | Node-based now; Electron later |
| Export format | One JSON file `<project>.abr.json` (no zip, no new dependency) |
| Import onto an existing project id | The user chooses: overwrite, or import as a new project (`<id>-2`) |

## Non-goals

- Electron packaging, installers, auto-update.
- Merging an imported project into an existing one file by file.
- Sharing run history, videos, PDF guides, login sessions, secret values or database passwords.
- Any multi-user or remote access. The app listens on 127.0.0.1 only.

## Part A: Remove multi-user

**Removed:**
- `app/auth.mjs`, `app/reset-password.mjs`, `app/test/auth.test.mjs`, npm script `reset-password`.
- Routes `/auth/*` (setup, login, logout, me, password), `/users`, `/projects/<id>/members`.
- Every permission check in `app/server.mjs` (`need`, `needAdmin`, `needRun`, `can`, `roleIn`,
  `visibleProjects`, `liveRun`'s role argument): every feature is always available.
- UI: sign-in and setup screens, change-password, Settings → Users, the project Members tab, the account
  avatar/menu in the sidebar, `canDo()`, and the `data-need` / `data-local` attributes.
- Server mode: `APP_MODE=server`, `APP_HOSTS`, `HOST`, the setup code, Secure cookies. The server always
  listens on `127.0.0.1`.
- README section "Shared server (server mode)"; the `MAX_RUNS` paragraph moves to the general usage part.

**Kept:**
- The origin check on every request: `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and
  `Sec-Fetch-Site` must be `same-origin`, `none` or absent. Without a login this is the only thing that stops
  another website open in the same browser from starting runs or reaching secrets through the app.
- Parallel runs (`MAX_RUNS`), per-project secrets, production blocking, everything else.
- The "Claude subscription" (claude-code) provider is always offered (it was hidden only in server mode).

**Data:**
- `app/data/app.db` keeps the run history.
- A new migration step drops the tables `users`, `sessions`, `members` (existing steps are never edited, per
  `app/store.mjs`). The `runs.user_id` column stays and is ignored. History no longer shows who ran what.

**Tests:**
- All remaining unit tests stay green; `auth.test.mjs` is deleted.
- `app/test/server.integration.test.mjs` drops setup/login.
- New: requests with `Host: evil.com`, or with `Sec-Fetch-Site: cross-site`, are refused (403).

## Part B: Export and import a project

**File `<project-id>.abr.json`:**

```json
{
  "format": "ai-browser-runner-project",
  "version": 1,
  "exported": "2026-09-28T10:00:00.000Z",
  "project": { "id": "shop", "name": "Shop", "description": "", "url": "{{appUrl}}", "env": "e2e",
               "db": { "e2e": { "type": "postgres", "host": "localhost", "port": 5432, "database": "myapp_e2e",
                                "user": "default", "reset": true, "template": "myapp_e2e_base" } } },
  "secrets": ["APP_PASS"],
  "files": {
    "login.spec.ts": { "text": "..." },
    "data/login.csv": { "text": "..." },
    "workflows/checkout.json": { "text": "..." },
    "login.spec.ts-snapshots/home-chromium-linux.png": { "base64": "..." }
  }
}
```

- `project` is `tests/<id>/project.json` as stored (it never holds passwords; those are in `.env`).
- `secrets` lists only the **names** of the secrets bound to the project (`app/settings.json`
  `secretProjects`), never values.
- `files` holds every file under `tests/<id>/` except `project.json`, keyed by its path relative to that
  folder with `/` separators. Text files as `text`, PNG files as `base64`.
- Not included: secret values, database passwords (`DBPASS_*`), login sessions (`app/data/sessions/`),
  run history, videos, PDF guides.

**Export:** an Export button in the project view. `GET /projects/<id>/export` answers the file with
`content-disposition: attachment; filename="<id>.abr.json"`.

**Import:** an Import button on the Projects page opens a file picker. The browser reads the file and sends
it to `POST /projects/import` with `{ bundle, mode }`:

1. Without `mode`, if `tests/<id>/` already exists the server answers `409` with `{ conflict: <id>,
   suggestion: <id>-2 }` (first free `-N`). The UI asks: **Overwrite** or **Import as new project**.
2. `mode: "overwrite"` deletes the existing `tests/<id>/` folder and writes the bundle's files (history,
   sessions and database passwords of that project stay). `mode: "new"` writes to the suggested id and sets
   the project name to `<name> (2)` etc.
3. Secrets listed in `secrets` that already exist on this laptop get bound to the project; the rest are
   reported.
4. The answer is a summary: `{ id, files: <count>, missingSecrets: [...], missingVars: [...] }`, where
   `missingVars` are `{{lowercaseName}}` values used in the imported files that none of this laptop's
   environments defines. Built-ins are not reported: `today`, `today±N`, `now`, `random` (see
   `app/vars-core.cjs`), and the workflow/data references `data.*`, `params.*`, `blocks.*`, `item`, `item.*`.
   `baseUrl` is an ordinary environment value and is reported when missing. The UI shows it with links to Settings → Secrets and Settings → Environments.

**Import is a trust boundary** (the file comes from someone else). The server rejects the whole bundle, and
writes nothing, when any of these fail:
- `format` is `ai-browser-runner-project` and `version` is `1`.
- The request body is at most 20 MB.
- `project.id` is a valid project slug (same rule as today's project ids).
- Every key in `files` is relative, has no `..` segment, no leading `/`, no backslash, no drive letter, and
  matches one of: `*.spec.ts` at the top level, `data/*.csv`, `workflows/*.json`,
  `*.spec.ts-snapshots/*.png`. Each entry has exactly one of `text` or `base64`; PNG uses `base64`, the
  others `text`.
- `project.db` passes the same validation as the project form (`validDb`).

Imported test files are code that runs on this laptop. The import dialog says so ("Import only files from
people you trust") and lists the files before the user confirms.

**Code layout:**
- `app/bundle.mjs` (new, pure logic, no HTTP): `packProject(dir, project, secretNames) → bundle` and
  `unpackBundle(bundle) → { project, files: [{ path, data: Buffer }] }` which throws on anything invalid;
  `missingVars(files, envs) → string[]`.
- `app/server.mjs`: the two routes above, writing through the existing library functions where they exist.
- `app/app.js` / `app/index.html`: Export button, Import button and dialog, summary.

**Tests:**
- `app/test/bundle.test.mjs`: pack → unpack returns identical bytes (text and PNG); rejected bundles:
  `../x.spec.ts`, `/etc/x.spec.ts`, `C:\x.spec.ts`, `data/x.sh`, a `.spec.ts` inside `data/`, wrong
  `version`, wrong `format`, bad project id, both `text` and `base64` set; `missingVars` ignores built-ins.
- `app/test/server.integration.test.mjs`: export a project over HTTP, import it (409 on the same id, then
  `mode: "new"`), replay the imported test, and it passes.

## Part C: Standalone install

**`npm run setup`** runs `app/setup.mjs` (new), which checks and prepares everything and prints a ✅/⚠️/❌
list. It exits with code 1 only on ❌.

| Check | On failure |
|---|---|
| Node ≥ 22.13 (`node:sqlite` without a flag) | ❌ stop, print where to get Node for this OS |
| Chromium for the test runner (`@playwright/test`) **and** for Playwright MCP (its own nested `playwright`) | ❌ stop; on Linux also print `sudo npx playwright install-deps chromium` for missing system libraries |
| `ffmpeg` on PATH (or `FFMPEG`) with the `libx264` encoder | ⚠️ continue (videos will fail), print `winget install ffmpeg` / `brew install ffmpeg` / `sudo apt install ffmpeg` |
| Claude Code CLI (`claude --version`) | ⚠️ continue, say: install Claude Code, or add an API key in Settings → AI |
| `.env` exists | create an empty one with a comment |

`package.json`: `setup` becomes `node app/setup.mjs`; the install instructions become
`npm install`, `npm run setup`, `npm run app`.

**Windows fixes** (the app has only run on Linux so far):
1. `app/agents.mjs`: `spawn('claude', …)` fails with `ENOENT` on Windows (`claude` is `claude.cmd`). Use
   `shell: true` on `win32` only.
2. `app/replay.mjs`, `app/recorder.mjs`: `node_modules/.bin/playwright` is a shell script. Run
   `process.execPath` with `node_modules/@playwright/test/cli.js` instead, on every OS.
3. `app/replay.mjs`: `process.kill(-pid)` (kill the process group) does not exist on Windows. On `win32`
   run `taskkill /pid <pid> /T /F` instead, which ends the runner and its browser.

**README:** the Install section is rewritten per OS (Windows, macOS, Linux): how to get Node, ffmpeg and
Claude Code, then the three commands. The "Shared server" section is removed (Part A).

**Tests:**
- `app/test/setup.test.mjs`: the pure checks of `setup.mjs` — Node version comparison (`22.12.0` fails,
  `22.13.0` and `24.3.0` pass) and libx264 detection from sample `ffmpeg -encoders` output.
- The existing integration tests (replay, parallel runs) prove the new way of starting the runner on Linux.
- **Known limit:** the three Windows fixes cannot be tested here (no Windows or macOS machine). Manual smoke
  test for a colleague on Windows, after `npm install && npm run setup && npm run app`:
  1. `setup` prints ✅ for Node and Chromium.
  2. Import a project file, replay one of its tests: it passes and the live view shows the browser.
  3. Start a replay with a long test and press Stop: the run stops, and Task Manager shows no leftover
     Chromium from it.
  4. With Claude Code installed, start an AI run: it starts (no `spawn claude ENOENT`).

## Order

A, then B, then C. B's integration test builds on A's simplified test server (no login); C is independent
but its README rewrite includes A's removals.
