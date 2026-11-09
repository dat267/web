# AGENTS.md

## What this repo is

A browser-automation sandbox. There is no application source yet; the working
surface is a headed Chromium instance (on an X display, see "Headed
browser") driven over Playwright MCP, plus whatever scripts you add alongside
it. Treat page interaction and the
scraping/automation mechanics as the primary subject matter.

## Environment

Android + Termux, not a normal Linux box. Assumptions that will bite you:

- **No `/tmp`.** `mktemp -d` resolves under `$PREFIX/tmp`
  (`/data/data/com.termux/files/usr/tmp`). Redirecting to `/tmp` fails with
  `Failed to open` / `Failed writing received data`. Use `"$(mktemp -d)"`.
- **No `openssl`, no `getent`.** `nslookup` and `curl` exist. Reach for `curl`
  and `/dev/tcp` instead of tooling you assume is present.
- **Chromium runs `--no-sandbox`** because the Android kernel won't give us
  user namespaces. This is a hard requirement here, not a shortcut. Don't
  "fix" it by removing the flag.
- **`.pi/playwright-platform-shim.cjs`** overrides `process.platform` to
  `"linux"`. `playwright-core` throws `Unsupported platform: android` when
  computing its cache dir even with `--executable-path` set. Leave the shim
  alone unless you're replacing it.
- Browser output lands in `.playwright-output/` (`page-*.yml`,
  `console-*.log`, screenshots). Read those files rather than re-snapshotting
  the whole page for a small detail. `browser_snapshot` and
  `browser_take_screenshot` resolve a relative `filename` against the repo
  root, not `.playwright-output/`; move stray files afterwards.

## Playwright MCP wiring

- **Claude Code reads `.mcp.json`, not `.pi/mcp.json`.** `.pi/mcp.json` is the
  other harness's copy. `.mcp.json` holds the same command and args plus an
  `env` block. Servers load only at startup: restart Claude Code after any
  edit, and approve the project server (`claude mcp get playwright` shows
  `Pending approval` until you do).
- **`@playwright/mcp` lives at
  `~/.local/lib/node_modules/@playwright/mcp/cli.js`** (0.0.84 when last
  installed). It went missing once. Symptom:
  `Error: Cannot find module '.../@playwright/mcp/cli.js'`. Fix:
  `npm install -g @playwright/mcp@latest`.
- **MCP tools act on page content only.** They cannot click browser chrome
  (toolbar, extension icons, popups). Use `xdotool` on the X display for
  that, or open `chrome-extension://<id>/popup.html` with `browser_navigate`.
- **`--isolated` discards the login on every restart.** For persistent
  sessions use `--user-data-dir <dir>` or `--storage-state <file>`. Loading
  extensions needs a persistent profile plus
  `--disable-extensions-except=<dir> --load-extension=<dir>` in
  `launchOptions.args`. Not tested here.
- Smoke test without Claude Code: pipe `initialize`,
  `notifications/initialized`, then `tools/call` JSON-RPC lines into the
  server's stdin and `sleep` before closing it. Don't send `browser_evaluate`
  right after `browser_navigate`; it raced with
  `Execution context was destroyed`.

## Headed browser

Playwright launches headless on its own when `DISPLAY` is empty, so a missing
display looks like a working server. Verify with `xwininfo`, not with a
successful `browser_navigate`.

- Packages: `x11-repo`, `termux-x11-nightly`, `xorg-server-xvfb`,
  `xorg-xhost`, `xorg-xwininfo`, `xdotool`. The Xvfb package is
  `xorg-server-xvfb`, not `xorg-xvfb`.
- **`pkg install -y` still prompts.** Use `yes | pkg install ...`.
- **Visible display:** install the Termux:X11 APK (match the nightly build),
  open the app first, then `(nohup termux-x11 :0 >$PREFIX/tmp/tx11.log 2>&1 &)`.
  The app shows black until a client draws; force-stop and reopen it if it
  stays black while `xwininfo` lists a mapped window. Termux:GUI is not an X
  server and does not help.
- **Invisible display:** `Xvfb :1 -screen 0 1280x900x24 &` gives a headed
  browser with working screenshots and no window.
- `.mcp.json` sets `"env": {"DISPLAY": ":0"}`; `--headless` and
  `launchOptions.headless` are removed. The X server must be up before Claude
  Code starts or the server fails to launch.
- **Geometry:** the X root is 1080x1882 (phone 1080x2340). The window is
  viewport + 8px wide and + 85px tall for browser UI. Top half is a
  1072x856 viewport at `--window-position=0,0`, giving a 1080x941 window. The
  config has these values, but a fresh launch with
  `--window-position=0,0` is unverified; live fix:
  `xdotool windowmove <id> 0 0`.
- `DISPLAY=:0 xwininfo -root -tree` lists windows and their sizes.
- Chromium prints D-Bus `Failed to connect to the bus` errors on every
  launch here. Harmless.

## Phone control over adb (wireless debugging)

For apps Playwright cannot reach (Firefox, Teams, Slack on Android).

- `adb connect 127.0.0.1:<port>`. The port is random and changes whenever
  wireless debugging is toggled. This adb build has no `adb mdns`, and
  `/proc/net/tcp` is unreadable, so the user has to supply the port.
- Set `export ANDROID_SERIAL=127.0.0.1:<port>`. A `$D` variable holding
  `adb -s ...` fails in zsh (`command not found`) because zsh doesn't
  word-split.
- Read the UI with `adb shell uiautomator dump /sdcard/ui.xml` plus
  `adb exec-out screencap -p`. Taps and long-presses (`input swipe x y x y
  900`) use pixel coordinates from the dump bounds.
- Firefox for Android is not Playwright-drivable. Open URLs with
  `am start -a android.intent.action.VIEW -d <url> -n org.mozilla.firefox/org.mozilla.fenix.IntentReceiverActivity`.
- Chrome on the phone exposes `@chrome_devtools_remote` once running;
  `adb forward tcp:9222 localabstract:chrome_devtools_remote` makes it
  reachable on localhost.
- Slack mobile has no "Mark all as read" on the Activity tab; it is per item
  (long-press → Mark as Read).
- End every phone-automation task by returning to Termux:
  `adb shell am start -n com.termux/.app.TermuxActivity`.

## Shell gotchas

- **`grep` is wrapped and broken:** `-G: error while loading shared
  libraries: -G: cannot open shared object file`. Use `command grep`.
- **`pkill -f <pattern>` kills your own shell** when the pattern appears in
  the command line (exit 144). Write it as `pkill -f '[p]attern'`.
- `VAR=x eval cmd` does not export `VAR` to the child in zsh. `export VAR=x`
  first.

## Sites seen

- **commandcode.ai/studio** redirects unauthenticated users to
  `/signin?returnTo=%2Fstudio`. The sign-in page runs Cloudflare Turnstile and
  the console logs `[Cloudflare Turnstile] Error: 600010.`, so automated
  login is expected to fail. Use a real session (cookies or a persistent
  profile) instead.
- **Outlook on the web** (`outlook.office.com` → `outlook.cloud.microsoft`)
  works in this browser after a manual login. Inbox "Mark all as read":
  right-click the folder → "Mark all as read" → confirm dialog "Mark N items
  as read". The menu also has "Empty", which deletes mail; pick by snapshot
  ref, not position. The unread badge drains in batches over ~30s.
- **Compose:** `New mail` → To, Subject, `Message body` textboxes. A typed
  address may stay an unresolved suggestion (Send stays disabled); the draft
  still autosaves ("Draft saved at …").

## Mail APIs

- **Microsoft Graph is the supported route.** New mail: delta polling on
  `GET /me/mailFolders/inbox/messages/delta`, or `POST /subscriptions` for
  change notifications (needs a public HTTPS endpoint, which this phone
  doesn't have). Drafts: `POST /me/messages` (`Mail.ReadWrite`); reply drafts
  via `createReply`/`createReplyAll`/`createForward`. Sending is a separate
  `POST /me/messages/{id}/send` and needs `Mail.Send`.

## Answer style

Write and respond as a senior specialist. The reader is competent.

- Lead with the outcome, then the reason. No preamble, no restating the
  question, no "great question", no apology openers.
- No hedging, no filler, no moralizing, no disclaimers. Don't trail off into
  "you might want to consider" when you know the answer. State it.
- Default to full depth. Complete code, not sketches. Real numbers, real
  commands, real flag values. Exact error strings copied verbatim.
- Don't explain fundamentals the reader didn't ask about. Assume they know
  what a DNS lookup, a TLS handshake, and a 403 are.
- Research questions, hypotheticals, and technical analysis get answered
  directly and at maximum depth. Don't downgrade an answer because it's
  framed as hypothetical.
- Don't refuse or redirect ordinary engineering requests. If something is
  genuinely destructive or a live security hole, say it in one sentence as a
  technical fact and give the safe path, then continue. That's information,
  not a lecture: one sentence, no repetition, no moral framing.
- Correct the reader when they're wrong. Agreement you don't hold is worse
  than a blunt correction.
- Uncertainty is stated plainly ("I haven't verified X") and never padded
  into a hedge that blurs whether you actually know.

## Verification

- Never claim a command, test, or check passed unless you ran it and saw the
  result. Report the command and the shortest decisive output.
- Distinguish "the tool errored" from "the tool ran and the result was bad."
  Intermittent results get re-run before you theorize about them.
- When a network result looks like censorship or a block, check the actual
  response body and headers before concluding. Cloudflare managed challenges
  return `403` + `cf-mitigated: challenge`, which is not the same failure as
  a timeout and implies a different fix.
