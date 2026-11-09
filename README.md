# web

A browser-automation sandbox plus two reusable, dependency-light Node CLIs:

- **`slack.mjs`** — read-only Slack access (channels, history, threads, DMs, search, files).
- **`owa.mjs`** — Outlook Web (OWA) mail and calendar automation (read, draft, send, attach, search, events).

Both authenticate once through a headed browser, persist the session, then run headless. No app registration, no admin consent, no personal access token.

## Why these exist

Slack and Outlook both restrict API access: Slack needs a workspace app or a legacy token, and Microsoft Graph needs a tenant app registration with admin consent. Neither is available in every environment. Both scripts instead reuse the credentials the first-party web clients already hold:

- **Slack** — a saved cookie jar is loaded to fetch the workspace's own HTML, which embeds the client's `xoxc-` session token. API calls then replay through Playwright's `APIRequestContext`, which attaches cookies automatically (a raw `fetch`/`curl` fails with `invalid_auth` because the `d` cookie is HttpOnly, and in-page `fetch` fails CORS).
- **OWA** — the one-time login captures the first-party MSAL refresh token, which redeems directly against `login.microsoftonline.com` for `outlook.office.com` scoped access tokens. Calls then go to Outlook REST v2.0.

## Requirements

- Node.js >= 18 (global `fetch`, ESM).
- `playwright-core` — resolved from a local `node_modules`, a global install, or the bundled copy inside `@playwright/mcp`.
- Chromium. Set `SLACK_CHROME` / `OWA_CHROME` if it is not on a default path.
- A display for the one-time login (`DISPLAY=:0`), or install the Termux:X11 / Xvfb packages noted in `AGENTS.md`.

## Quick start

```sh
# Slack: one-time login, then reads
node scripts/slack.mjs login
node scripts/slack.mjs whoami
node scripts/slack.mjs history "#general" 20

# Outlook: one-time login, then mail
node scripts/owa.mjs login
node scripts/owa.mjs inbox 10
node scripts/owa.mjs show "quarterly report"
```

`login` opens a headed browser. Complete the sign-in (password, SSO, MFA) by hand; the script detects the landing page, records the session, and closes. Nothing else needs interaction.

## Slack commands

All Slack commands are read-only. Mutating methods (`chat.postMessage`, `conversations.join`, `reactions.add`, `files.upload`, …) are refused by name before any request is built.

| Command | Purpose |
| --- | --- |
| `login` | One-time headed login; writes the cookie jar |
| `adopt [profileDir]` | Harvest Slack cookies from an existing Chromium profile |
| `whoami` | Identity and team check |
| `channels` | Every conversation: public, private, group DM, DM |
| `unread [--counts]` | Conversations with unread messages |
| `history <chan> [n] [k=v…]` | Latest messages; passthrough params such as `oldest=` |
| `thread <chan> <ts> [n]` | Replies in a thread |
| `users` | Workspace users |
| `files <chan> [n]` | File uploads in a channel |
| `download <file-id> [dir]` | Save a shared file to disk |
| `search <query>` | Full-text search |
| `raw <method> [k=v…]` | Any read-only Web API method |

`<chan>` accepts `#name`, a raw conversation id (`C…`/`G…`/`D…`), or `@handle` for the DM with that user.

Message output resolves Slack mrkdwn control blocks instead of printing raw ids: `<@U123>` becomes `@Display Name`, `<#C123|name>` becomes `#name`, `<!here>` becomes `@here`, and `<url|label>` becomes `label (url)`. Bot messages that ship empty `text` with the payload in `blocks`/`attachments` are unwrapped, so Jira and GitHub notifications print real content.

## Outlook commands

| Command | Purpose |
| --- | --- |
| `login` | One-time headed login; captures the rotating refresh token |
| `whoami` | Account and tenant the tokens are scoped to |
| `inbox [n]` / `drafts [n]` | Newest messages |
| `show <id\|subject-fragment>` | Headers, attachments, and text body |
| `search <query> [n]` | Mailbox-wide search, all folders |
| `find [inbox\|drafts] <fragment>` | Case-insensitive subject filter over recent mail |
| `draft <to> <subject> <body-html-file>` | Create a draft |
| `attach <message-id> <file>` | Add an attachment to a draft (≤ 3 MB) |
| `send <message-id>` | Send an existing draft |
| `delete [inbox\|drafts] <fragment>` | Delete matching messages |
| `events [days] [n]` | Upcoming calendar events |
| `event <subject> <start> <end> [body-html]` | Create an event |
| `event-delete <fragment>` | Delete matching events |

`draft` creates but never sends: `send` is a separate, explicit step. The REST quirks worth knowing are handled in the code: `POST /me/messages` requires PascalCase fields (`Subject`, `Body`, `ToRecipients`); `send` needs an empty body and returns `202`; `delete` returns `204`.

## Configuration

Both scripts read environment variables; nothing is required beyond the login.

| Variable | Script | Default | Effect |
| --- | --- | --- | --- |
| `SLACK_WORKSPACE` | slack | required | Workspace subdomain (`mycompany` in `https://mycompany.slack.com`); may also be set in `.env` |
| `SLACK_MSG_LIMIT` | slack | `200` | Per-message character cap; `0` disables truncation |
| `SLACK_JSON` | slack | off | Emit JSON instead of text |
| `SLACK_MRKDWN` | slack | strip | `keep` preserves `*bold*` / `_italic_` markers |
| `SLACK_LINKS` | slack | off | Append jump-to-message permalinks |
| `SLACK_BROWSER` | slack | off | `1` forces the browser transport |
| `SLACK_NO_CACHE` | slack | off | `1` bypasses the name/token caches |
| `SLACK_NAME_TTL_HOURS` | slack | `12` | Name-map cache lifetime |
| `SLACK_TOKEN_TTL_HOURS` | slack | `24` | Token cache lifetime |
| `SLACK_FILE_SCAN` | slack | `1000` | Messages scanned when hunting files |
| `SLACK_SEARCH_COUNT` | slack | `20` | Result page size |
| `SLACK_PROFILE_DIR` | slack | `.slack-profile` | Login profile location |
| `SLACK_CHROME` | slack | auto | Chromium binary |
| `OWA_NO_CACHE` | owa | off | `1` forces a refresh-token redemption |
| `OWA_JSON` | owa | off | Emit raw JSON |
| `OWA_FIND_SCAN` | owa | `200` | Messages scanned by `find` |
| `OWA_EVENTS_DAYS` | owa | `30` | Default `events` window |
| `OWA_PROFILE_DIR` | owa | `.owa-profile` | Login profile location |
| `OWA_CHROME` | owa | auto | Chromium binary |
| `SLACK_DEBUG` / `OWA_DEBUG` | both | off | `1` prints stack traces instead of one-line errors |

## Performance notes

Both tools cache aggressively because every command is a fresh process:

- Slack: the `xoxc-` token is cached for 24h and re-scraped lazily on `invalid_auth`, so a command runs in ~1.5-2.5s. The name maps (users + all conversations) are cached for 12h, which is what keeps `history` fast and avoids Slack's tier-2 rate limits. Rate-limited calls retry up to five times, honouring `Retry-After`.
- OWA: the access token is cached with a 120s expiry margin. Because of the cache, a command usually skips redemption entirely, which also keeps the rotating refresh token out of harm's way.

Two OWA measurements worth keeping in mind if you edit the calendar code: selecting `Location` or `BodyPreview` in `calendarview` makes the same 128-event page take ~3.5s instead of ~350ms, and `$orderby` makes Exchange materialise the whole window.

## Security

- `.env`, the cookie jar, the token caches, and all browser profiles are gitignored, and created with `0600` permissions.
- The OWA refresh token rotates on every redemption. Redemptions are not lock-protected, so **do not run two OWA commands concurrently** — a race can persist a stale token.
- The Slack session is tied to a browser cookie. Treat `.pi/slack-cookies.b64` as a password: whoever holds it can read every channel that account can read.
- The OWA refresh token expires after roughly 24 hours of disuse. If a command fails with `token redemption failed (invalid_grant)`, the session aged out: re-run `login`.
- To revoke: sign out of the Slack workspace, and for Outlook delete the session at `account.microsoft.com`. Both scripts will then fail cleanly with an instruction to re-run `login`.

## Repository contents

- `scripts/slack.mjs` — read-only Slack CLI.
- `scripts/owa.mjs` — Outlook mail and calendar CLI.
- `scripts/` is intentionally self-contained: both files run standalone with `node`, with no package.json and no build step.
- `.pi/playwright-platform-shim.cjs` — sets `process.platform` to `linux`; `playwright-core` throws `Unsupported platform: android` otherwise.
- `.mcp.json`, `.pi/mcp.json`, `.pi/playwright.config.json` — Playwright MCP wiring with local absolute paths.
- `AGENTS.md` — environment notes for Android/Termux.

## Environment caveats

Written and tested on Android under Termux, which is not a normal Linux box:

- No `/tmp`; use `$(mktemp -d)`.
- Chromium must run `--no-sandbox` (the Android kernel refuses user namespaces). This is a hard requirement, not a shortcut.
- `playwright-core` needs the platform shim above.
- A headed browser needs an X server; see `AGENTS.md`.
