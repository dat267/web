#!/data/data/com.termux/files/usr/bin/env node
// slack.mjs — READ-ONLY Slack automation, no browser needed for reads.
//
// Fast path (default): HTTP-only. It loads the Slack web client's own HTML with
// the saved cookie jar, extracts the live `xoxc-` session token embedded there,
// and calls `https://<ws>.slack.com/api/*` with Playwright's APIRequestContext
// (no Chromium launched, ~1s per command instead of ~75s).
//
// Slow path (`login` / `adopt` / `--browser`): launches Chromium to establish or
// refresh the session when the cookie jar is missing or stale.
//
// Any machine with Node >= 18 and playwright-core:
//   npm install playwright-core        # or have @playwright/mcp installed
//
// State:
//   <repo>/.pi/slack-cookies.b64   cookie jar (d, d-s, x, lc) — chmod 600
//   <repo>/.pi/slack-token.json    cached xoxc token (24h, re-scraped on invalid_auth)
//   <repo>/.pi/slack-names.json    cached user/channel name maps (12h)
//   <repo>/.slack-profile/         persistent Chromium profile for login only
//   env SLACK_WORKSPACE            workspace subdomain (required)
//   env SLACK_PROFILE_DIR          profile dir override
//   env SLACK_CHROME               Chromium binary override
//   env SLACK_MSG_LIMIT            per-message char cap (default 200)
//   env SLACK_JSON=1               emit JSON instead of the text table
//
// Every command is read-only; mutating Slack methods are hard-blocked by name.
//
// Usage:
//   node slack.mjs login                     one-time headed login -> cookie jar
//   node slack.mjs adopt [profileDir]        harvest cookies from another profile
//   node slack.mjs whoami                    identity check
//   node slack.mjs channels                  list channels + counts
//   node slack.mjs unread [--counts]         conversations with unread messages
//   node slack.mjs history <chan> [n]        latest n messages (default 20)
//   node slack.mjs thread <chan> <ts> [n]    replies in a thread
//   node slack.mjs users                     workspace users
//   node slack.mjs search <query>            full-text search
//   node slack.mjs files <chan> [n]          file uploads in a channel
//   node slack.mjs download <file-id> [dir]  save a shared file (read-only GET)
//   node slack.mjs raw <method> [k=v ...]    any read-only web API method

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = process.env.SLACK_PROFILE_DIR || path.join(ROOT, ".slack-profile");
const COOKIES_FILE = path.join(ROOT, ".pi", "slack-cookies.b64");

/* Read KEY=value pairs from <root>/.env, which is gitignored. Keeps the
   workspace subdomain out of tracked source while still allowing a per-machine
   default. */
function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const DOTENV = loadDotEnv(path.join(ROOT, ".env"));
const WORKSPACE = process.env.SLACK_WORKSPACE || DOTENV.SLACK_WORKSPACE || "";
const EXECUTABLE_PATH =
  process.env.SLACK_CHROME ||
  [
    "/data/data/com.termux/files/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].find((p) => fs.existsSync(p));

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

// Read-only guard: anything that changes server state is refused.
const MUTATING = [
  "chat.postMessage", "chat.update", "chat.delete", "chat.meMessage",
  "chat.scheduleMessage", "chat.deleteScheduledMessage", "chat.unfurl",
  "chat.command", "chat.postEphemeral", "chat.startStream", "chat.stopStream",
  "conversations.archive", "conversations.unarchive", "conversations.invite",
  "conversations.kick", "conversations.join", "conversations.leave",
  "conversations.mark", "conversations.open", "conversations.close",
  "conversations.rename", "conversations.setPurpose", "conversations.setTopic",
  "conversations.create", "conversations.acceptSharedInvite",
  "conversations.declineSharedInvite", "conversations.canvasCreate",
  "conversations.requestSharedInvite", "conversations.approveSharedInvite",
  "reactions.add", "reactions.remove", "stars.add", "stars.remove",
  "pins.add", "pins.remove", "bookmarks.add", "bookmarks.edit",
  "bookmarks.remove", "files.upload", "files.delete", "files.share",
  "files.remote.add", "files.remote.update", "files.remote.remove",
  "files.comments.add", "files.comments.edit", "files.comments.delete",
  "users.profile.set", "users.setPhoto", "users.setPresence",
  "users.admin", "admin.", "reminders.add", "reminders.complete",
  "reminders.delete", "dnd.setSnooze", "dnd.endSnooze", "dnd.endDnd",
  "auth.revoke", "auth.signout", "team.profile.set", "usergroups.create",
  "usergroups.update", "usergroups.users.update", "usergroups.disable",
  "usergroups.enable", "calls.end", "calls.add", "calls.update",
  "canvas.create", "canvas.edit", "canvas.delete", "workflows.stepCompleted",
];
function assertReadOnly(method) {
  if (MUTATING.some((m) => method === m || method.startsWith(m))) {
    throw new Error(`read-only script: refusing mutating method "${method}"`);
  }
}

async function getPlaywright() {
  // Termux/Android: playwright-core aborts on non-linux platform detection.
  if (process.platform === "android") {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  }
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return await import(name);
    } catch {
      /* next */
    }
  }
  const mcpDir = path.join(
    os.homedir(),
    ".local/lib/node_modules/@playwright/mcp/node_modules/playwright-core",
  );
  for (const f of ["index.mjs", "index.js"]) {
    const file = path.join(mcpDir, f);
    if (fs.existsSync(file)) {
      try {
        return await import(pathToFileURL(file).href);
      } catch {
        /* next */
      }
    }
  }
  console.error(
    "playwright-core not found. Install it (npm i playwright-core) or set SLACK_CHROME.",
  );
  process.exit(3);
}

function launchOptions(headless) {
  if (process.platform === "linux" && !process.env.DISPLAY) process.env.DISPLAY = ":0";
  return {
    headless,
    executablePath: EXECUTABLE_PATH,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  };
}

function readJar() {
  if (!fs.existsSync(COOKIES_FILE)) return null;
  try {
    const jar = JSON.parse(
      Buffer.from(fs.readFileSync(COOKIES_FILE, "utf8").trim(), "base64").toString(),
    );
    return Array.isArray(jar) && jar.some((c) => c.name === "d") ? jar : null;
  } catch {
    return null;
  }
}

function writeJar(jar) {
  fs.writeFileSync(COOKIES_FILE, Buffer.from(JSON.stringify(jar)).toString("base64") + "\n");
  fs.chmodSync(COOKIES_FILE, 0o600);
}

/* decodeURIComponent throws on stray % sequences in page HTML. */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const asStorageState = (jar) => ({
  cookies: jar.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: typeof c.expires === "number" ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite || "Lax",
  })),
  origins: [],
});

/* ---------------------------------------------------------------- fast path */

const TOKEN_CACHE = path.join(ROOT, ".pi", "slack-token.json");
const TOKEN_TTL_MS = Number(process.env.SLACK_TOKEN_TTL_HOURS || 24) * 3600_000;

function readTokenCache() {
  try {
    const c = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    if (c.workspace === WORKSPACE && c.token && Date.now() - c.at < TOKEN_TTL_MS) return c.token;
  } catch {
    /* no cache */
  }
  return null;
}

function writeTokenCache(token) {
  try {
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ workspace: WORKSPACE, at: Date.now(), token }));
    fs.chmodSync(TOKEN_CACHE, 0o600);
  } catch {
    /* best effort */
  }
}

/* Load the workspace's own HTML with the saved cookies and scrape the xoxc
   token the web client bootstraps into the page. No Chromium involved. */
async function connectHttp() {
  const jar = readJar();
  if (!jar) return null;
  if (!WORKSPACE) throw requireWorkspace();
  const { request } = await getPlaywright();
  const api = await request.newContext({
    storageState: asStorageState(jar),
    userAgent: UA,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  const apiBase = `https://${WORKSPACE}.slack.com/api`;

  const scrape = async () => {
    for (const url of [`https://${WORKSPACE}.slack.com/`, `https://${WORKSPACE}.slack.com/home`]) {
      const res = await api.get(url, { failOnStatusCode: false }).catch(() => null);
      if (!res) continue;
      const html = await res.text().catch(() => "");
      const m =
        /xoxc-[A-Za-z0-9-]{20,}/.exec(html) ??
        /xoxc-[A-Za-z0-9-]{20,}/.exec(safeDecode(html));
      if (m) return m[0];
    }
    return null;
  };

  // Cached token first: skips a ~2.5s HTML round trip on every command. It is
  // validated lazily — makeCall re-scrapes once on invalid_auth.
  let token = readTokenCache();
  if (!token) {
    token = await scrape();
    if (token) writeTokenCache(token);
  }
  if (!token) {
    await api.dispose();
    return null;
  }
  return { api, target: { token, apiBase, refresh: scrape }, jar };
}

/* ---------------------------------------------------------------- slow path */

/* Launch Chromium, wait for the client to boot, and harvest cookies + token. */
/* Every Slack endpoint is workspace-scoped, so there is no sensible default. */
function requireWorkspace() {
  return new Error(
    "SLACK_WORKSPACE is not set. Set it to your workspace subdomain, i.e. " +
      "`mycompany` for https://mycompany.slack.com — either in the environment " +
      "or in .env at the repo root.",
  );
}

async function connectBrowser({ keepOpen = false } = {}) {
  if (!WORKSPACE) throw requireWorkspace();
  const { chromium } = await getPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions(keepOpen ? false : true));
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  let token = null;
  let apiBase = null;
  page.on("request", (req) => {
    if (token) return;
    const raw = req.postData();
    if (!raw) return;
    const m = /xoxc-[A-Za-z0-9-]+/.exec(raw) ?? /xoxc-[A-Za-z0-9-]+/.exec(decodeURIComponent(raw));
    if (!m) return;
    const b = /^https:\/\/([a-z0-9-]+)\.slack\.com\/api/.exec(req.url());
    if (b) {
      token = m[0];
      apiBase = `https://${b[1]}.slack.com/api`;
    }
  });

  await page.goto(`https://app.slack.com/client`, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 60_000;
  let lastNudge = Date.now();
  while (Date.now() < deadline) {
    if (token && /\/client\/T[0-9A-Z]+/.test(page.url())) break;
    await page.waitForTimeout(250);
    if (!token && Date.now() - lastNudge > 10_000) {
      lastNudge = Date.now();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    }
  }
  if (!token) {
    const url = page.url();
    await ctx.close();
    throw new Error(`not logged in (last url: ${url}). Run: node slack.mjs login`);
  }

  // Persist the cookies so subsequent runs can take the fast HTTP path.
  const jar = (await ctx.cookies([
    `https://${WORKSPACE}.slack.com`,
    "https://app.slack.com",
    "https://slack.com",
  ])).filter((c) => ["d", "d-s", "x", "lc"].includes(c.name));
  if (jar.some((c) => c.name === "d")) writeJar(jar);

  const ms = /\/client\/(T[0-9A-Z]+)/.exec(page.url())?.[1];
  return { ctx, page, token, apiBase, workspace: ms, via: "browser" };
}

/* ------------------------------------------------------------------- caller */

function makeCall(send, target, getHeaders) {
  return async function call(method, params = {}) {
    assertReadOnly(method);
    let refreshed = false;
    // Slack rate-limits tier-2 methods (~20/min); retry rather than return
    // ok:false, which callers would misread as "not found".
    for (let attempt = 0; ; attempt++) {
      const res = await send(`${target.apiBase}/${method}`, {
        form: {
          token: target.token,
          _x_reason: "slackmjs",
          _x_mode: "online",
          _x_app_name: "client",
          ...params,
        },
        headers: { "User-Agent": UA },
        failOnStatusCode: false,
      });
      const retryAfter = Number(getHeaders(res)["retry-after"]);
      const body = await res.json().catch(() => ({ ok: false, error: "non-json response" }));

      const authFailed = ["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(
        body.error,
      );
      if (authFailed && !refreshed && target.refresh) {
        refreshed = true;
        const fresh = await target.refresh().catch(() => null);
        if (fresh) {
          target.token = fresh;
          writeTokenCache(fresh);
          continue;
        }
      }

      const retryable = body.error === "ratelimited" || res.status() === 429;
      if (!retryable || attempt >= 5) return body;
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * (attempt + 1), 10_000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  };
}

async function connect() {
  if (process.env.SLACK_BROWSER !== "1") {
    const fast = await connectHttp();
    if (fast) {
      const call = makeCall((url, o) => fast.api.post(url, o), fast.target, (res) => res.headers());
      return { call, request: fast.api, close: () => fast.api.dispose(), via: "http", target: fast.target };
    }
  }
  // No usable jar (or forced): launch Chromium once, then persist cookies+token.
  const b = await connectBrowser();
  writeTokenCache(b.token);
  const target = { token: b.token, apiBase: b.apiBase, refresh: null };
  const call = makeCall((url, o) => b.ctx.request.post(url, o), target, (res) => res.headers());
  return { call, request: b.ctx.request, close: () => b.ctx.close(), via: "browser", target };
}

/* -------------------------------------------------------------------- output */

const iso = (ts) => new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 19);
// SLACK_MSG_LIMIT=0 disables truncation.
const msgLimit = (() => {
  const raw = process.env.SLACK_MSG_LIMIT;
  if (raw === undefined || raw === "") return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 200;
})();
const asJson = process.env.SLACK_JSON === "1";

/* Walk a block tree collecting every human-readable text field. */
function blockText(blocks, out = []) {
  for (const b of blocks ?? []) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") out.push(b.text);
    else if (b.text?.text) out.push(b.text.text);
    for (const f of b.fields ?? []) if (f?.text) out.push(f.text);
    if (b.accessory?.text?.text) out.push(b.accessory.text.text);
    if (b.label?.text) out.push(b.label.text);
    if (b.placeholder?.text) out.push(b.placeholder.text);
    if (b.blocks) blockText(b.blocks, out);
    if (b.elements) blockText(b.elements, out);
  }
  return out;
}

/* Bot/Jira messages often ship empty `text` with the payload in blocks or
   attachments; without this they print as a bare timestamp. */
function messageBody(m) {
  if ((m.text || "").trim()) return m.text;
  const parts = [];
  for (const a of m.attachments ?? []) {
    for (const k of ["pretext", "fallback", "title", "text"]) {
      if (typeof a?.[k] === "string" && a[k].trim()) parts.push(a[k]);
    }
    if (a?.blocks) parts.push(...blockText(a.blocks));
  }
  parts.push(...blockText(m.blocks));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Slack mrkdwn control blocks -> readable text.
function renderBlocks(text, ctx = {}) {
  const { users, channels, limit = msgLimit } = ctx;
  let out = text || "";
  out = out.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => {
    const name = label || users?.get(id);
    return name ? `@${name}` : `@${id}`;
  });
  out = out.replace(/<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => {
    const name = label || channels?.get(id);
    return name ? `#${name}` : `#${id}`;
  });
  out = out.replace(/<!([a-z]+)(?:\^([A-Z0-9]+))?(?:\|([^>]+))?>/g, (_, kw, id, label) =>
    id ? label || `@${id}` : `@${kw}`,
  );
  out = out.replace(/<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g, (_, url, label) =>
    label ? `${label} (${url})` : url,
  );
  // Slack's internal slack:// links (Jira/GitHub unfurls use them heavily).
  out = out.replace(
    /<slack:\/\/([a-z]+)\?([^|>]+)(?:\|([^>]+))?>/g,
    (_, kind, query, label) => {
      if (label) return label;
      const id = /(?:^|&)id=([A-Z0-9]+)/.exec(query)?.[1];
      if (kind === "user" && id) return users?.get(id) ? `@${users.get(id)}` : `@${id}`;
      if (kind === "channel" && id) return channels?.get(id) ? `#${channels.get(id)}` : `#${id}`;
      return `slack://${kind}`;
    },
  );
  out = out.replace(/<mailto:([^|>]+)(?:\|([^>]+))?>/g, (_, addr, label) => label || addr);
  out = out
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Terminal output cannot show mrkdwn emphasis; strip the markers unless
  // SLACK_MRKDWN=keep. Not applied to the URL suffix form.
  if (process.env.SLACK_MRKDWN !== "keep") {
    out = out
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1$2")
      .replace(/~([^~\n]+)~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1");
  }
  return out.replace(/\s*\n\s*/g, " ⏎ ").slice(0, limit || Infinity);
}

function formatMessage(m, ctx) {
  const who = ctx?.users?.get(m.user) ? `@${ctx.users.get(m.user)}` : m.user || m.bot_id || "?";
  const replies = m.reply_count ? ` [${m.reply_count} replies]` : "";
  const files = m.files?.length ? ` [${m.files.length} file(s): ${m.files.map((f) => f.name || f.title || f.id).join(", ")}]` : "";
  const reacts = m.reactions?.length
    ? ` [:${m.reactions.map((r) => `${r.name}×${r.count}`).join(", :")}]`
    : "";
  const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (in thread ${m.thread_ts})` : "";
  const edited = m.edited ? " (edited)" : "";
  // SLACK_LINKS=1 appends a jump-to-message permalink (needs the channel id).
  const link =
    process.env.SLACK_LINKS === "1" && ctx?.channelId
      ? ` | https://${WORKSPACE}.slack.com/archives/${ctx.channelId}/p${String(m.ts).replace(".", "")}`
      : "";
  return `${iso(m.ts)} | ${who} | ts=${m.ts}${replies}${files}${thread}${edited} | ${renderBlocks(messageBody(m), ctx)}${reacts}${link}`;
}

async function userMap(call) {
  const map = new Map();
  const r = await call("users.list", { limit: "1000" });
  if (!r.ok) return map;
  for (const u of r.members ?? []) map.set(u.id, u.profile?.display_name || u.real_name || u.name);
  return map;
}

async function channelMap(call, users = new Map()) {
  const map = new Map();
  for (const types of ["public_channel,private_channel,mpim", "im"]) {
    let cursor;
    do {
      const params = { types, limit: "200" };
      if (cursor) params.cursor = cursor;
      const r = await call("conversations.list", params);
      if (!r.ok) break;
      for (const c of r.channels ?? []) {
        // IM entries carry only a user id; prefer that user's display name so
        // DM rows read "@Jane Doe" instead of "@U08ABCDEF".
        map.set(c.id, c.name || (c.user && users.get(c.user)) || c.user || c.id);
      }
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }
  return map;
}

const NAME_CACHE = path.join(ROOT, ".pi", "slack-names.json");
const NAME_TTL_MS = Number(process.env.SLACK_NAME_TTL_HOURS || 12) * 3600_000;

async function readNameCache() {
  try {
    const c = JSON.parse(fs.readFileSync(NAME_CACHE, "utf8"));
    if (Date.now() - c.at < NAME_TTL_MS) {
      return { users: new Map(c.users), channels: new Map(c.channels) };
    }
  } catch {
    /* no cache */
  }
  return null;
}

function writeNameCache(ctx) {
  try {
    fs.writeFileSync(
      NAME_CACHE,
      JSON.stringify({ at: Date.now(), users: [...ctx.users], channels: [...ctx.channels] }),
    );
    fs.chmodSync(NAME_CACHE, 0o600);
  } catch {
    /* best effort */
  }
}

/* Name maps cost ~10s of pagination; cache them for SLACK_NAME_TTL_HOURS.
   SLACK_NO_CACHE=1 bypasses. */
async function nameContext(call) {
  if (process.env.SLACK_NO_CACHE !== "1") {
    const cached = await readNameCache();
    if (cached) return cached;
  }
  const users = await userMap(call);
  const channels = await channelMap(call, users);
  const ctx = { users, channels };
  if (users.size || channels.size) writeNameCache(ctx);
  return ctx;
}
/* Collect up to `want` items from any cursor-paginated method. */
async function collect(call, method, params, { want = Infinity, key = "messages" } = {}) {
  const out = [];
  let cursor;
  do {
    const page = { ...params, limit: String(Math.min(Math.max(want - out.length, 1), 200)) };
    if (cursor) page.cursor = cursor;
    const r = await call(method, page);
    if (!r.ok) {
      if (out.length) break;
      throw new Error(`${method}: ${r.error}`);
    }
    out.push(...(r[key] ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < want);
  return out.slice(0, want);
}

/* Resolve a @handle / display name / user id to a user id. */
async function resolveUser(call, ref) {
  const raw = String(ref).replace(/^@/, "");
  if (/^[UW][A-Z0-9]{6,}$/.test(raw)) return raw;
  const needle = raw.toLowerCase();
  const r = await call("users.list", { limit: "1000" });
  if (!r.ok) throw new Error(`users.list: ${r.error}`);
  const names = (u) => [u.name, u.profile?.display_name, u.real_name, u.profile?.real_name]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const exact = (r.members ?? []).find((u) => names(u).includes(needle));
  if (exact) return exact.id;
  const partial = (r.members ?? []).filter((u) => names(u).some((n) => n.includes(needle)));
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    throw new Error(
      `ambiguous user "${ref}": ${partial.slice(0, 5).map((u) => u.name).join(", ")}`,
    );
  }
  throw new Error(`user not found: ${ref}`);
}

/* Find the DM conversation id for a user id. */
async function resolveDm(call, userId) {
  const r = await call("conversations.list", { types: "im", limit: "200" });
  if (!r.ok) throw new Error(`conversations.list: ${r.error}`);
  let cursor = r.response_metadata?.next_cursor || undefined;
  let page = r;
  for (;;) {
    const hit = (page.channels ?? []).find((c) => c.user === userId);
    if (hit) return hit.id;
    if (!cursor) break;
    page = await call("conversations.list", { types: "im", limit: "200", cursor });
    if (!page.ok) break;
    cursor = page.response_metadata?.next_cursor || undefined;
  }
  throw new Error(`no DM conversation with ${userId}`);
}

async function resolveChannel(call, ref) {
  const str = String(ref);
  // "@handle" means the DM with that user, not a channel.
  if (str.startsWith("@")) return resolveDm(call, await resolveUser(call, str));
  const wanted = str.replace(/^#/, "");
  if (/^[CGD][A-Z0-9]{6,}$/.test(wanted)) return wanted;
  // Try the cached name->id map first: full resolution costs 20+ paginated calls
  // and trips rate limits.
  if (process.env.SLACK_NO_CACHE !== "1") {
    const cached = await readNameCache();
    if (cached) {
      for (const [id, name] of cached.channels) {
        if (name === wanted) return id;
      }
    }
  }
  for (const types of ["public_channel,private_channel,mpim,im", "public_channel"]) {
    for (const method of ["conversations.list", "client.channels"]) {
      let cursor;
      do {
        const params = { types, limit: "200", exclude_archived: "true" };
        if (cursor) params.cursor = cursor;
        const r = await call(method, params);
        if (!r.ok) break;
        const channels = Array.isArray(r.channels) ? r.channels : [];
        const hit = channels.find((c) => c.name === wanted || c.name_normalized === wanted);
        if (hit) return hit.id;
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }
  }
  throw new Error(`channel not found: ${ref}`);
}

/* ---------------------------------------------------------------------- main */

const USAGE = `usage: node slack.mjs <command>              (all commands are READ-ONLY)
  login                     one-time headed login -> cookie jar
  adopt [profileDir]        harvest Slack cookies from another Chromium profile
  whoami                    identity / team check
  channels                  list channels (public, private, group DM, DM)
  unread [--counts]         channels/DMs with unread messages
  history <chan> [n]        latest n messages (default 20)
  thread <chan> <ts> [n]    replies in a thread
  users                     list workspace users
  files <chan> [n]          file uploads in a channel
  download <file-id> [dir]  save a shared file to disk (read-only GET)
  search <query>            full-text search
  raw <method> [k=v ...]    call any READ-ONLY web API method

env: SLACK_WORKSPACE (required), SLACK_MSG_LIMIT (default 200, 0=no cap),
     SLACK_JSON=1 (JSON output), SLACK_MRKDWN=keep (keep *bold*/_italics_),
     SLACK_BROWSER=1 (force browser transport), SLACK_NO_CACHE=1,
     SLACK_NAME_TTL_HOURS (default 12), SLACK_TOKEN_TTL_HOURS (default 24)`;

const [cmd = "", ...args] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(USAGE);
  process.exit(0);
}

if (cmd === "login") {
  const { chromium } = await getPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions(false));
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://slack.com/signin");
  console.log("Complete the Slack sign-in (password / SSO / MFA) in the browser window.");
  console.log(`Profile: ${PROFILE_DIR}`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    if (/app\.slack\.com\/client|\/home$/.test(page.url())) {
      ok = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (ok) {
    const jar = (await ctx.cookies([
      `https://${WORKSPACE}.slack.com`,
      "https://app.slack.com",
      "https://slack.com",
    ])).filter((c) => ["d", "d-s", "x", "lc"].includes(c.name));
    if (jar.some((c) => c.name === "d")) {
      writeJar(jar);
      console.log(`login recorded; cookie jar -> ${COOKIES_FILE}`);
    } else {
      console.log("login detected but no session cookie found; try again");
      ok = false;
    }
  } else {
    console.log("login not detected; profile saved as-is.");
  }
  await ctx.close();
  process.exit(ok ? 0 : 1);
}

if (cmd === "adopt") {
  const src = path.resolve(args[0] || path.join(ROOT, ".chrome-profile"));
  if (!WORKSPACE) throw requireWorkspace();
  const { chromium } = await getPlaywright();
  const ctx = await chromium.launchPersistentContext(src, launchOptions(true));
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://app.slack.com/client", { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 40 && !/\/client\/T[0-9A-Z]+/.test(page.url()); i++) {
    await page.waitForTimeout(500);
  }
  const jar = (await ctx.cookies([
    `https://${WORKSPACE}.slack.com`,
    "https://app.slack.com",
    "https://slack.com",
  ])).filter((c) => ["d", "d-s", "x", "lc"].includes(c.name));
  if (!jar.some((c) => c.name === "d")) {
    console.error(`no Slack session cookies in ${src}`);
    await ctx.close();
    process.exit(1);
  }
  writeJar(jar);
  console.log(`saved ${jar.length} cookies (${jar.map((c) => c.name).join(", ")}) -> ${COOKIES_FILE}`);
  await ctx.close();
  process.exit(0);
}

const started = Date.now();
let conn = null;
try {
  conn = await connect();
  const { call, request, via, target } = conn;
  switch (cmd) {
    case "whoami": {
      const r = await call("auth.test");
      if (!r.ok) throw new Error(`auth.test: ${r.error}`);
      if (asJson) console.log(JSON.stringify(r, null, 2));
      else console.log(`${r.user} @ ${r.team} — ${r.url} (via ${via}, ${Date.now() - started}ms)`);
      break;
    }
    case "unread": {
      // client.counts returns only has_unreads/mention_count per conversation;
      // exact message counts cost one history call per channel (--counts).
      const wantCounts = args.includes("--counts");
      const r = await call("client.counts");
      if (!r.ok) throw new Error(`client.counts: ${r.error}`);
      const { users, channels } = await nameContext(call);
      const rows = [];
      for (const [key, kind] of [
        ["channels", "chan"],
        ["mpims", "mpim"],
        ["ims", "dm  "],
      ]) {
        for (const c of r[key] ?? []) {
          if (!c.has_unreads && !c.mention_count) continue;
          rows.push({
            id: c.id,
            kind,
            name: kind === "chan" ? `#${channels.get(c.id) || c.id}` : `@${channels.get(c.id) || c.id}`,
            mentions: c.mention_count || 0,
            last_read: c.last_read,
            latest: c.latest,
            unread: null,
          });
        }
      }
      if (wantCounts) {
        for (const row of rows) {
          const msgs = await collect(
            call,
            "conversations.history",
            { channel: row.id, oldest: row.last_read || "0" },
            { want: 1000 },
          ).catch(() => []);
          row.unread = msgs.length;
        }
      }
      rows.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
      if (asJson) {
        console.log(JSON.stringify({ threads: r.threads, conversations: rows }, null, 2));
        break;
      }
      if (!rows.length) console.log("(nothing unread)");
      for (const row of rows) {
        const bits = [
          row.mentions ? `${row.mentions} mention(s)` : "",
          row.unread !== null ? `${row.unread} msg` : "",
          row.kind.trim(),
        ].filter(Boolean);
        console.log(`${row.id} | ${bits.join(", ")} | ${row.name}`);
      }
      if (r.threads?.mention_count) console.log(`-- ${r.threads.mention_count} thread mention(s) pending`);
      break;
    }
    case "channels": {
      // Slack's default types is public_channel only; ask for every family or
      // private channels and DMs are silently absent.
      const families = [
        ["public_channel", "pub "],
        ["private_channel", "priv"],
        ["mpim", "mpim"],
        ["im", "dm  "],
      ];
      const rows = [];
      // DM rows carry only a user id; resolve it through the (cached) user map
      // so the listing shows handles instead of U… ids.
      const { users } = await nameContext(call);
      for (const [type, kind] of families) {
        let cursor;
        do {
          const params = { types: type, limit: "200", exclude_archived: "true" };
          if (cursor) params.cursor = cursor;
          const r = await call("conversations.list", params);
          if (!r.ok) {
            rows.push({ id: "-", kind, member: "      ", name: `(${type}: ${r.error})` });
            break;
          }
          for (const c of r.channels ?? []) {
            const dmUser = c.user && (users.get(c.user) || c.user);
            rows.push({
              id: c.id,
              kind,
              member: c.is_member ? "member" : "      ",
              name: type === "im" ? `@${dmUser || c.name || c.id}` : `#${c.name}`,
            });
          }
          cursor = r.response_metadata?.next_cursor || undefined;
        } while (cursor);
      }
      rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      if (asJson) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        for (const r of rows) console.log(`${r.id} | ${r.member} | ${r.kind} | ${r.name}`);
        const counts = rows.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {});
        console.log(
          `-- ${rows.length} total: ` +
            Object.entries(counts).map(([k, v]) => `${v} ${k.trim()}`).join(", "),
        );
      }
      break;
    }
    case "history": {
      const [ref, count = "20", ...rest] = args;
      if (!ref) throw new Error("history <channel> [n] [key=value ...]");
      // Extra k=v args pass straight through to conversations.history, e.g.
      // oldest=<ts> latest=<ts> inclusive=true.
      const extra = Object.fromEntries(
        rest.filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]),
      );
      const chan = await resolveChannel(call, ref);
      const msgs = await collect(
        call,
        "conversations.history",
        { channel: chan, ...extra },
        { want: Math.max(1, Number(count) || 20) },
      );
      if (asJson) {
        console.log(JSON.stringify(msgs, null, 2));
        break;
      }
      const ctx = { ...(await nameContext(call)), channelId: chan };
      if (!msgs.length) console.log("(no messages)");
      for (const m of msgs.reverse()) console.log(formatMessage(m, ctx));
      break;
    }
    case "thread": {
      const [ref, ts] = args;
      if (!ref || !ts) throw new Error("thread <channel> <ts>");
      const chan = await resolveChannel(call, ref);
      const msgs = await collect(
        call,
        "conversations.replies",
        { channel: chan, ts },
        { want: Number(args[2]) || 1000 },
      );
      if (asJson) {
        console.log(JSON.stringify(msgs, null, 2));
        break;
      }
      const ctx = { ...(await nameContext(call)), channelId: chan };
      for (const m of msgs) console.log(formatMessage(m, ctx));
      break;
    }
    case "users": {
      const r = await call("users.list", { limit: "1000" });
      if (!r.ok) throw new Error(`users: ${r.error}`);
      if (asJson) {
        console.log(JSON.stringify(r.members ?? [], null, 2));
        break;
      }
      for (const u of r.members ?? []) {
        const status = u.deleted ? "deactivated" : u.is_bot ? "bot" : "active";
        console.log(`${u.id} | @${u.name} | ${u.profile?.real_name || u.real_name || "-"} | ${status}`);
      }
      break;
    }
    case "files": {
      const [ref, count = "20"] = args;
      if (!ref) throw new Error("files <channel> [n]");
      const chan = await resolveChannel(call, ref);
      const want = Math.max(1, Number(count) || 20);
      const scan = Number(process.env.SLACK_FILE_SCAN) || 1000;
      const found = [];
      let cursor;
      let scanned = 0;
      while (found.length < want && scanned < scan) {
        const page = { channel: chan, limit: "200" };
        if (cursor) page.cursor = cursor;
        const r = await call("conversations.history", page);
        if (!r.ok) {
          if (scanned) break;
          throw new Error(`history: ${r.error}`);
        }
        for (const m of r.messages ?? []) {
          scanned++;
          for (const f of m.files ?? []) found.push({ ts: m.ts, user: m.user, file: f });
          if (found.length >= want) break;
        }
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      const hits = found.slice(0, want);
      if (asJson) {
        console.log(JSON.stringify(hits, null, 2));
        break;
      }
      if (!hits.length) console.log("(no files)");
      for (const { ts, file: f } of hits) {
        console.log(
          `${iso(ts)} | ${f.id} | ${f.name || f.title || "-"} | ${f.mimetype || "-"} | ${f.size || 0}B | ${f.url_private ? "url_private present" : "no url"}`,
        );
      }
      break;
    }
    case "download": {
      // Read-only: url_private needs the session token (or cookies); downloads
      // are plain GETs, no server state changes.
      const [ref, destDir = "."] = args;
      if (!ref) throw new Error("download <file-id> [dest-dir]");
      const info = await call("files.info", { file: ref });
      if (!info.ok) throw new Error(`files.info: ${info.error}`);
      const f = info.file;
      const url = f.url_private_download || f.url_private;
      if (!url) throw new Error(`file ${ref} has no downloadable url`);
      const res = await request.get(url, {
        headers: { Authorization: `Bearer ${target.token}` },
        failOnStatusCode: false,
      });
      const buf = await res.body();
      if (res.status() !== 200) {
        throw new Error(`download failed: HTTP ${res.status()} (${buf.toString().slice(0, 120)})`);
      }
      const safe = String(f.name || f.id).replace(/[^\w.\-]+/g, "_");
      const out = path.join(destDir, safe);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(out, buf);
      console.log(`${out} | ${buf.length}B | ${f.mimetype || "-"}`);
      break;
    }
    case "search": {
      const q = args.join(" ");
      if (!q) throw new Error("search <query>");
      const r = await call("search.all", {
        query: q,
        count: String(Number(process.env.SLACK_SEARCH_COUNT) || 20),
      });
      if (!r.ok) throw new Error(`search: ${r.error}`);
      const hits = r.messages?.matches ?? [];
      if (asJson) {
        console.log(JSON.stringify(hits, null, 2));
        break;
      }
      if (!hits.length) console.log("(no results)");
      const ctx = hits.length ? await nameContext(call) : null;
      for (const m of hits) {
        // Search matches nest the channel under `channel` (object), not
        // channel_id/channel_name; without it a hit cannot be located.
        const ch = m.channel ?? {};
        const name = ch.name || ch.id || m.channel_id;
        const where = name ? ` ${ch.is_im ? "[dm]" : `[#${name}]`}` : "";
        console.log(formatMessage(m, { ...ctx, channelId: ch.id || m.channel_id }) + where);
      }
      break;
    }
    case "raw": {
      const [method, ...pairs] = args;
      if (!method) throw new Error("raw <method> [k=v ...]");
      const params = Object.fromEntries(
        pairs.map((p) => {
          const i = p.indexOf("=");
          return i < 0 ? [p, "true"] : [p.slice(0, i), p.slice(i + 1)];
        }),
      );
      console.log(JSON.stringify(await call(method, params), null, 2));
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
} catch (err) {
  // Expected failures (not found, auth, read-only refusal) get one clean line;
  // full stacks only under SLACK_DEBUG=1.
  const message = err?.message ?? String(err);
  console.error(`error: ${message}`);
  if (process.env.SLACK_DEBUG === "1" && err?.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  if (conn) await conn.close();
}
