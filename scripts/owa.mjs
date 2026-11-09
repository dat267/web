#!/data/data/com.termux/files/usr/bin/env node
// owa.mjs — portable headless Outlook (OWA) automation over Outlook REST v2.0.
//
// Any machine that has Node >= 18 and playwright-core installed can use this:
//   npm i playwright-core          # in the repo or globally
//   node owa.mjs login             # ONE-TIME: opens a headed browser for the user
//                                  # to log in; captures the rotating refresh token
//   node owa.mjs inbox [n]         # after that, everything is headless API calls
//   node owa.mjs drafts [n]
//   node owa.mjs show <id|fragment>        print a message (headers + text body)
//   node owa.mjs draft <recipient> <subject> <body-html-file>
//   node owa.mjs send <message-id>
//   node owa.mjs find <folder|inbox|drafts> <subject-fragment>
//   node owa.mjs delete <folder|inbox|drafts> <subject-fragment>
//   node owa.mjs events | event | event-delete
//   node owa.mjs whoami
//
// Access tokens are cached in <root>/.pi/owa-token.json (expiry-aware) so a
// command normally skips redemption entirely; OWA_NO_CACHE=1 forces a fresh
// one. OWA_JSON=1 emits raw JSON. OWA_FIND_SCAN sets the find scan depth.
//
// Credentials live in <root>/.env next to this file's parent dir:
//   MS_CLIENT_ID            OWA's fixed first-party client id
//   MS_REFRESH_TOKEN        family refresh token, rotates on each redemption
//   MS_ACCOUNT / MS_OID / MS_TENANT_ID   account metadata (from login)
//
// IMPORTANT: the refresh token rotates on every redemption. All redemptions
// must go through this script (it persists the new token serially). Do not run
// two instances in parallel.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_ID = "9199bf20-a13f-4107-85dc-02114787ef48"; // One Outlook Web (Microsoft)
const TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const AUTH_TEMPLATE = (challenge) =>
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" +
  `?client_id=${CLIENT_ID}` +
  "&scope=https%3A%2F%2Foutlook.office.com%2F.default%20openid%20profile%20offline_access" +
  `&redirect_uri=https%3A%2F%2Foutlook.cloud.microsoft%2Fmail%2F` +
  "&response_type=code&response_mode=fragment" +
  `&code_challenge=${challenge}&code_challenge_method=S256` +
  "&prompt=login&x-client-SKU=msal.js.browser&x-client-VER=5.12.0";
const REST = "https://outlook.office.com/api/v2.0";
const MAIL_URL = "https://outlook.cloud.microsoft/mail/";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENVFILE = path.join(ROOT, ".env");
const PROFILE_DIR =
  process.env.OWA_PROFILE_DIR || path.join(ROOT, ".owa-profile");
// Use the same system chromium the playwright MCP config points at, when it
// exists (playwright's own managed download is not needed).
const EXECUTABLE_PATH =
  process.env.OWA_CHROME ||
  ["/data/data/com.termux/files/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(p => fs.existsSync(p));
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- .env ----

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function envUpsert(file, kv) {
  let lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=(.*)$`, "m");
    if (re.test(lines.join("\n"))) lines = lines.map((l) => l.replace(re, `${k}=${v}`));
    else {
      while (lines[lines.length - 1] === "") lines.pop();
      lines.push(`${k}=${v}`, "");
    }
  }
  fs.writeFileSync(file, lines.join("\n"));
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

// ------------------------------------------------------------ security ----

function b64uDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\.+$/, "");
  return Buffer.from(s + "===".slice((s.length + 3) % 4), "base64").toString();
}
function jwtClaims(jwt) {
  return JSON.parse(b64uDecode(jwt.split(".")[1]));
}

// ------------------------------------------------------- playwright utils --

async function getPlaywright() {
  // Termux/Android: playwright-core refuses to compute its cache dir on
  // non-Linux platforms; override before the module loads (no-op elsewhere).
  if (process.platform === "android") {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  }
  // 1) normal resolution (any machine where playwright[core] is installed)
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return await import(name);
    } catch {
      /* try next */
    }
  }
  // 2) bundled copy shipped with a global @playwright/mcp install
  //    (common when the machine only has the playwright MCP server installed)
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
        /* fall through to error */
      }
    }
  }
  console.error(
    "playwright is not installed. Run inside a dir where it is importable:\n" +
      "  npm install playwright-core\n" +
      "or point NODE_PATH at an existing install, then re-run:",
  );
  process.exit(3);
}

// ----------------------------------------------------------------- login --

// Opens a headed browser, points it at the OWA login, watches MSAL's code
// exchange on the page, persists the new refresh token + account metadata to
// .env, then closes the browser itself. Exit codes: 0 captured.
async function login() {
  const { chromium } = await getPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  // Headed browser needs an X server on Linux; default to :0 like the MCP setup.
  if (process.platform === "linux" && !process.env.DISPLAY) {
    process.env.DISPLAY = ":0";
  }

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: EXECUTABLE_PATH,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const page = browser.pages()[0] || (await browser.newPage());
  await page.goto(MAIL_URL); // lands on the hosted authorize page

  console.log("Log in in the opened browser window. Waiting for token exchange...");

  let captured = null;
  page.on("response", async (res) => {
    if (!/oauth2\/.*\/token/.test(res.url())) return;
    try {
      const body = await res.text();
      if (!body.includes("refresh_token")) return;
      captured = JSON.parse(body);
      console.log("captured refresh token.");
    } catch {
      /* non-JSON body */
    }
  });

  // Also save the raw code+verifier pair as a fallback (in case EAR mode hides
  // the token response but fragments carry the code).
  let code = null;
  page.on("response", (res) => {
    if (!/oauth2\/.*\/authorize/.test(res.url())) return;
    for (const frag of res.url().split("#")) {
      const m = new URLSearchParams(frag).get("code");
      if (m) code = m;
    }
  });

  // Wait up to 10 minutes.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (!captured && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }

  if (!captured && code && /login.microsoftonline.com/.test(code)) {
    // Fallback: exchange ourselves.
    captured = await tokenExchange(code, verifier);
  }

  let ok = false;
  if (captured) {
    const claims = jwtClaims(captured.id_token);
    envUpsert(ENVFILE, {
      MS_CLIENT_ID: CLIENT_ID,
      MS_TENANT_ID: claims.tid,
      MS_ACCOUNT: claims.preferred_username,
      MS_OID: claims.oid,
      MS_REFRESH_TOKEN: captured.refresh_token,
    });
    console.log(
      `saved credentials for ${claims.preferred_username} (tenant ${claims.tid}). ` +
        "The refresh token rotates on every use — all automated redemptions must " +
        "go through this script so it can persist each rotation.",
    );
    ok = true;
  } else {
    console.error("no token captured within the deadline; browser stays open for you.");
  }

  await browser.close();
  process.exit(ok ? 0 : 1);
}

async function tokenExchange(code, verifier) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://outlook.cloud.microsoft",
      "User-Agent": UA,
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: "https://outlook.cloud.microsoft/mail/",
      scope: "https://outlook.office.com/.default openid profile offline_access",
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_info: "1",
      claims: '{"access_token":{"xms_cc":{"values":["CP1"]}}}',
      "x-client-SKU": "msal.js.browser",
      "x-client-VER": "5.12.0",
      "x-ms-lib-capability": "retry-after, h429",
    }),
  });
  return res.json();
}

// ---------------------------------------------------------------- tokens --

const TOKEN_CACHE = path.join(ROOT, ".pi", "owa-token.json");

/* Access tokens live 61-77 min. Caching one avoids a redemption per command,
   which also means fewer chances to race the rotating refresh token. */
function readTokenCache(env) {
  try {
    const c = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    if (c.account !== env.MS_ACCOUNT) return null;
    if (!c.accessToken || Date.now() > c.expiresAt - 120_000) return null;
    return c.accessToken;
  } catch {
    return null;
  }
}

function writeTokenCache(env, accessToken, expiresIn) {
  try {
    fs.writeFileSync(
      TOKEN_CACHE,
      JSON.stringify({
        account: env.MS_ACCOUNT,
        at: Date.now(),
        expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
        accessToken,
      }),
    );
    fs.chmodSync(TOKEN_CACHE, 0o600);
  } catch {
    /* best effort */
  }
}

async function redeem(env) {
  if (!env.MS_REFRESH_TOKEN) {
    console.error("no refresh token in .env — run: node owa.mjs login");
    process.exit(2);
  }
  const cached = process.env.OWA_NO_CACHE === "1" ? null : readTokenCache(env);
  if (cached) return cached;
  const corridorId = crypto.randomUUID();
  const res = await fetch(`${TOKEN_URL}?client-request-id=${corridorId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://outlook.cloud.microsoft",
      "User-Agent": UA,
    },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      redirect_uri: "https://outlook.cloud.microsoft/mail/",
      "scope": "https://outlook.office.com/.default openid profile offline_access",
      "grant_type": "refresh_token",
      "refresh_token": env.MS_REFRESH_TOKEN,
      "client_info": "1",
      "claims": '{"access_token":{"xms_cc":{"values":["CP1"]}}}',
      "x-client-SKU": "msal.js.browser",
      "x-client-VER": "5.12.0",
      "x-ms-lib-capability": "retry-after, h429",
    }),
  });
  const r = await res.json();
  if (r.error) {
    console.error(
      `token redemption failed (${r.error}). Run: node owa.mjs login`,
    );
    process.exit(2);
  }
  envUpsert(ENVFILE, { MS_REFRESH_TOKEN: r.refresh_token });
  writeTokenCache(env, r.access_token, r.expires_in);
  return r.access_token;
}

// ----------------------------------------------------------------- REST ----

const headers = (at, env) => ({
  Authorization: `Bearer ${at}`,
  "X-AnchorMailbox": env.MS_ACCOUNT,
});

async function rest(at, env, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(at, env), "User-Agent": UA, ...(options.headers || {}) },
  });
  if (options.expect && res.status !== options.expect) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

const createDraft = (at, env, recipient, subject, bodyHtmlFile) =>
  rest(at, env, `${REST}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Subject: subject,
      Body: { ContentType: "HTML", Content: fs.readFileSync(bodyHtmlFile, "utf8") },
      ToRecipients: [{ EmailAddress: { Address: recipient } }],
      Importance: "Normal",
    }),
  });

const sendDraft = (at, env, id) =>
  rest(at, env, `${REST}/me/messages/${encodeURIComponent(id)}/send`, {
    method: "POST",
    body: "",
    expect: 202,
  });

const list = (at, env, folder, select, top = 20) =>
  rest(
    at,
    env,
    `${REST}/me/mailfolders/${folder}/messages?` +
      new URLSearchParams({
        $top: String(top),
        $select: select,
        $orderby: `${folder === "inbox" ? "ReceivedDateTime" : "LastModifiedDateTime"} desc`,
      }),
  );

/* Walk @odata.nextLink until `want` messages are collected. */
async function listAll(at, env, folder, select, want) {
  const order = folder === "inbox" ? "ReceivedDateTime" : "LastModifiedDateTime";
  let url =
    `${REST}/me/mailfolders/${folder}/messages?` +
    new URLSearchParams({
      $top: String(Math.min(want, 100)),
      $select: select,
      $orderby: `${order} desc`,
    });
  const out = [];
  for (let page = 0; url && page < 20 && out.length < want; page++) {
    const j = await rest(at, env, url);
    if (j.error) throw new Error(j.error.message);
    out.push(...(j.value ?? []));
    url = j["@odata.nextLink"];
  }
  return out.slice(0, want);
}

async function findMessages(at, env, folder, fragment) {
  const want = Number(process.env.OWA_FIND_SCAN) || 200;
  const r = await listAll(at, env, folder, "Subject,Id,ReceivedDateTime,From,IsRead", want);
  return r.filter((m) => m.Subject?.toLowerCase().includes(String(fragment).toLowerCase()));
}

/* Outlook REST returns HTML bodies; terminals want text. */
function stripHtml(html = "") {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|h[1-6]|blockquote)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const listAttachments = (at, env, id) =>
  rest(
    at,
    env,
    `${REST}/me/messages/${encodeURIComponent(id)}/attachments?` +
      new URLSearchParams({ $select: "Name,ContentType,Size" }),
  );

/* Inline FileAttachment has a ~3MB base64 ceiling; larger files need an upload
   session, which this script does not implement. */
async function addAttachment(at, env, id, file) {
  const stat = fs.statSync(file);
  if (stat.size > 3 * 1024 * 1024) {
    throw new Error(`${file} is ${Math.round(stat.size / 1e6)}MB; inline attachments cap at 3MB`);
  }
  return rest(at, env, `${REST}/me/messages/${encodeURIComponent(id)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "@odata.type": "#Microsoft.OutlookServices.FileAttachment",
      Name: path.basename(file),
      ContentBytes: fs.readFileSync(file).toString("base64"),
    }),
  });
}

const MESSAGE_SELECT =
  "Subject,Id,From,ToRecipients,CcRecipients,ReceivedDateTime,SentDateTime,Body,BodyPreview,IsRead,HasAttachments,ConversationId";

const getMessage = (at, env, id) =>
  rest(
    at,
    env,
    `${REST}/me/messages/${encodeURIComponent(id)}?` +
      new URLSearchParams({ $select: MESSAGE_SELECT }),
  );

const deleteMessage = (at, env, id) =>
  rest(at, env, `${REST}/me/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    expect: 204,
  });

// -------------------------------------------------------------- calendar --

// Selecting Location or BodyPreview makes Exchange materialise extra per-item
// data: the same 128-event page takes ~3.5s vs ~350ms without them.
const EVENT_SELECT = "Subject,Start,End,Id,IsOrganizer";

/* Fetch calendarview pages. No $orderby: it makes Exchange materialise the
   whole window (a 1-year ordered query is ~5x slower than the same window
   unordered), and delete lookups do not need ordering. */
async function fetchEvents(at, env, { fromDays = 0, toDays = 30, top = 200, pages = 4 } = {}) {
  const q = new URLSearchParams({
    $top: String(Math.min(top, 200)),
    $select: EVENT_SELECT,
    startDateTime: new Date(Date.now() + fromDays * 864e5).toISOString(),
    endDateTime: new Date(Date.now() + toDays * 864e5).toISOString(),
  });
  let url = `${REST}/me/calendarview?${q}`;
  const all = [];
  const pageSize = Math.min(top, 200);
  for (let page = 0; url && page < pages; page++) {
    const j = await rest(at, env, url);
    if (j.error) throw new Error(j.error.message);
    const batch = j.value ?? [];
    all.push(...batch);
    // A short page means the window is exhausted; stop instead of chasing
    // a nextLink that returns nothing.
    if (batch.length < pageSize) break;
    url = j["@odata.nextLink"];
  }
  return all;
}

async function findEvents(at, env, fragment, opts) {
  // The recurring "Normal CAB meeting" series floods pages with same-titled
  // events, so search a wide window before concluding nothing matches.
  const all = await fetchEvents(at, env, { fromDays: -90, toDays: 180, top: 200, pages: 4, ...opts });
  const matches = all.filter((e) =>
    e.Subject?.toLowerCase().includes(String(fragment).toLowerCase()),
  );
  return { matches, all };
}

const createEvent = (at, env, subject, startISO, endISO, body = "") =>
  rest(at, env, `${REST}/me/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Subject: subject,
      Body: { ContentType: "HTML", Content: body },
      Start: { DateTime: startISO, TimeZone: "UTC" },
      End: { DateTime: endISO, TimeZone: "UTC" },
      IsReminderOn: false,
      ShowAs: "Busy",
    }),
  });

const deleteEvent = (at, env, id) =>
  rest(at, env, `${REST}/me/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
    expect: 204,
  });

// ----------------------------------------------------------------- main ----

const USAGE = `usage: node owa.mjs <command>
  login                one-time headed login; captures the rotating refresh token
  whoami               show the account tokens are scoped to
  drafts [n]           list newest drafts
  inbox [n]            list newest inbox messages
  show <id|subject-fragment>   print a message (headers + text body)
  draft <to> <subject> <body-html-file>
  send <message-id>
  find [inbox|drafts] <subject-fragment>
  delete [inbox|drafts] <subject-fragment>   soft-delete matches to Deleted Items
  events [days] [n]    upcoming events (default 30 days, 15 shown)
  event <subject> <start-iso> <end-iso> [body-html]   create a calendar event
  event-delete <subject-fragment>             delete matching events
  search <query> [n]   mailbox-wide $search (all folders)
  attach <message-id> <file>   add an attachment to a draft (<=3MB)`;

const [cmd = "", ...args] = process.argv.slice(2);
const asJson = process.env.OWA_JSON === "1";
if (!cmd) {
  console.log(USAGE);
  process.exit(0);
}

if (cmd === "login") {
  await login();
} else {
  await main().catch((err) => {
    console.error(`error: ${err?.message ?? err}`);
    if (process.env.OWA_DEBUG === "1" && err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
}

async function main() {
  const env = loadEnv(ENVFILE);
  const at = await redeem(env);
  switch (cmd) {
    case "whoami": {
      const c = env.MS_ACCOUNT ? { preferred_username: env.MS_ACCOUNT, tid: env.MS_TENANT_ID } : null;
      console.log(c ? `${c.preferred_username} (tenant ${c.tid})` : "unknown account");
      break;
    }
    case "draft": {
      const [recipient, subject, bodyFile] = args;
      const r = await createDraft(at, env, recipient, subject, bodyFile);
      if (r.error) throw new Error(r.error.message);
      console.log(`draft id: ${r.Id} | isDraft: ${r.IsDraft} | subject: ${r.Subject}`);
      break;
    }
    case "send": {
      const [id] = args;
      await sendDraft(at, env, id);
      console.log("sent");
      break;
    }
    case "find": {
      const [folder = "inbox", fragment] = args;
      for (const m of await findMessages(at, env, folder, fragment)) {
        console.log(`${m.Id} | ${m.Subject}`);
      }
      break;
    }
    case "delete": {
      const [folder = "inbox", fragment] = args;
      const found = await findMessages(at, env, folder, fragment);
      if (!found.length) {
        console.log(`no matches for "${fragment}" in ${folder}`);
        break;
      }
      for (const m of found) {
        await deleteMessage(at, env, m.Id);
        console.log(`deleted: ${m.Subject}`);
      }
      break;
    }
    case "events": {
      const days = Math.max(1, Number(args[0]) || Number(process.env.OWA_EVENTS_DAYS) || 30);
      const n = Math.max(1, Number(args[1]) || 15);
      const all = await fetchEvents(at, env, { fromDays: 0, toDays: days, top: Math.min(n * 5, 200) });
      const sorted = all.slice().sort((a, b) => (a.Start.DateTime < b.Start.DateTime ? -1 : 1));
      if (asJson) {
        console.log(JSON.stringify(sorted.slice(0, n), null, 2));
        break;
      }
      if (!sorted.length) console.log("(no events)");
      // soonest first: that is what you act on
      sorted.slice(0, n).forEach((e) =>
        console.log(
          `${e.Start.DateTime} -> ${e.End.DateTime} | ${e.IsOrganizer ? "org" : "att"} | ${e.Subject}`,
        ),
      );
      if (sorted.length > n) console.log(`(${sorted.length} in the next ${days} days, showing ${n})`);
      break;
    }
    case "event": {
      const [subject, startISO, endISO, body = ""] = args;
      const r = await createEvent(at, env, subject, startISO, endISO, body);
      if (r.error) throw new Error(r.error.message);
      console.log(
        `event id: ${r.Id} | subject: ${r.Subject} | ${r.Start.DateTime} -> ${r.End.DateTime}`,
      );
      break;
    }
    case "event-delete": {
      const [fragment] = args;
      const { matches } = await findEvents(at, env, fragment);
      if (!matches.length) {
        console.log(`no events matching "${fragment}"`);
        break;
      }
      for (const e of matches) {
        await deleteEvent(at, env, e.Id);
        console.log(`deleted: ${e.Subject} (${e.Start.DateTime})`);
      }
      break;
    }
    case "show": {
      const ref = args.join(" ");
      if (!ref) throw new Error("show <id|subject-fragment>");
      // A REST message id is a long base64url blob; anything else is a subject
      // fragment, searched inbox first and then drafts.
      const isId = /^[A-Za-z0-9_=-]{40,}$/.test(ref);
      let id = ref;
      if (!isId) {
        for (const folder of ["inbox", "drafts"]) {
          const hits = await findMessages(at, env, folder, ref);
          if (hits.length) {
            id = hits[0].Id;
            if (hits.length > 1) {
              console.error(`(${hits.length} matches in ${folder}, showing newest: ${hits[0].Subject})`);
            }
            break;
          }
        }
        if (!id || id === ref) throw new Error(`no message matching "${ref}"`);
      }
      const m = await getMessage(at, env, id);
      if (m.error) throw new Error(m.error.message);
      if (asJson) {
        console.log(JSON.stringify(m, null, 2));
        break;
      }
      const to = (m.ToRecipients ?? []).map((r) => r.EmailAddress.Address).join(", ");
      const cc = (m.CcRecipients ?? []).map((r) => r.EmailAddress.Address).join(", ");
      console.log(`Subject: ${m.Subject}`);
      console.log(`From:    ${m.From?.EmailAddress?.Name || ""} <${m.From?.EmailAddress?.Address || ""}>`);
      console.log(`To:      ${to}`);
      if (cc) console.log(`Cc:      ${cc}`);
      console.log(`Date:    ${m.ReceivedDateTime} | ${m.IsRead ? "read" : "UNREAD"}${m.HasAttachments ? " | has attachments" : ""}`);
      console.log(`Id:      ${m.Id}`);
      if (m.HasAttachments) {
        const a = await listAttachments(at, env, m.Id).catch(() => null);
        for (const f of a?.value ?? []) {
          console.log(`Attach:  ${f.Name} | ${f.ContentType || "-"} | ${f.Size || 0}B`);
        }
      }
      console.log("---");
      console.log(stripHtml(m.Body?.Content ?? m.BodyPreview ?? ""));
      break;
    }
    case "search": {
      const [query, count] = args;
      if (!query) throw new Error("search <query> [n]");
      const want = Math.max(1, Number(count) || 25);
      // $search is mailbox-wide (all folders) and cannot combine with $orderby.
      const r = await rest(
        at,
        env,
        `${REST}/me/messages?` +
          new URLSearchParams({
            $search: `"${query}"`,
            $top: String(Math.min(want, 250)),
            $select: "Subject,From,ReceivedDateTime,IsRead,Id,HasAttachments",
          }),
      );
      if (r.error) throw new Error(r.error.message);
      const hits = r.value ?? [];
      if (asJson) {
        console.log(JSON.stringify(hits, null, 2));
        break;
      }
      if (!hits.length) console.log("(no results)");
      for (const m of hits) {
        console.log(
          `${m.ReceivedDateTime} | ${m.IsRead ? "read   " : "UNREAD "} | ${m.From?.EmailAddress?.Address} | ${m.Subject}`,
        );
      }
      break;
    }
    case "attach": {
      const [id, file] = args;
      if (!id || !file) throw new Error("attach <message-id> <file>");
      const r = await addAttachment(at, env, id, file);
      if (r.error) throw new Error(r.error.message);
      console.log(`attached: ${r.Name} | ${r.Size}B | ${r.ContentType || "-"} | to ${id}`);
      break;
    }
    case "inbox": {
      const want = Math.max(1, Number(args[0]) || 20);
      const r = await list(at, env, "inbox", "Subject,From,ReceivedDateTime,IsRead,Id", want);
      if (r.error) throw new Error(r.error.message);
      if (asJson) {
        console.log(JSON.stringify(r.value ?? [], null, 2));
        break;
      }
      r.value.forEach((m) =>
        console.log(
          `${m.ReceivedDateTime} | ${m.IsRead ? "read   " : "UNREAD "} | ${m.From.EmailAddress.Address} | ${m.Subject}`,
        ),
      );
      if (!r.value.length) console.log("(empty)");
      break;
    }
    case "drafts": {
      const want = Math.max(1, Number(args[0]) || 20);
      const r = await list(at, env, "drafts", "Subject,LastModifiedDateTime,Id", want);
      if (r.error) throw new Error(r.error.message);
      if (asJson) {
        console.log(JSON.stringify(r.value ?? [], null, 2));
        break;
      }
      r.value.forEach((m) => console.log(`${m.LastModifiedDateTime} | ${m.Subject}`));
      if (!r.value.length) console.log("(no drafts)");
      break;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}
