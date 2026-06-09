// e2e/global-setup.js — boot a real Rivendell server and provision two users.
//
// Everything here goes through the public surface (bootstrap log line, magic
// link, invitation API) — no SQL access, no test-only backdoors in the server.
// Provisioning is idempotent: a reused e2e database short-circuits to plain
// logins, so the suite can be re-run without wiping anything.
//
// Requirements (enforced below with explicit errors):
//   - E2E_DATABASE_URL pointing at a DISPOSABLE Postgres database. On first run
//     it must be empty (zero admins) so the server's bootstrap path fires and
//     prints the one-time set-password link we consume here.
//   - The server binary at RIVENDELL_E2E_BIN (default ../bin/rivendell —
//     `make test-e2e` builds it first).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BASE = process.env.E2E_BASE_URL || "http://localhost:18080";
export const ADMIN = "e2e-admin";
export const USER2 = "e2e-user2";
export const PASSWORD = "rivendell-e2e-pw"; // ≥10 chars (server minimum)

const STATE_FILE = path.join(here, ".e2e-state.json");
const LOG_FILE = path.join(here, "server.log");

function addr() {
  const u = new URL(BASE);
  return ":" + (u.port || "80");
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/api/instance");
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready at ${BASE} within ${timeoutMs}ms — see web/e2e/server.log`);
}

// login returns the rivendell_session cookie pair ("name=value") or null on 401.
async function login(username, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return null;
  const setCookie = r.headers.get("set-cookie") || "";
  const m = setCookie.match(/rivendell_session=[^;]+/);
  return m ? m[0] : null;
}

async function mustJSON(r, what) {
  if (!r.ok) throw new Error(`${what} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export default async function globalSetup() {
  if (!process.env.E2E_DATABASE_URL) {
    throw new Error(
      "E2E_DATABASE_URL is not set. Point it at a disposable Postgres database " +
      "(NOT your dev db — the suite provisions users in it). Easiest: `make test-e2e` " +
      "with a chat_e2e database created alongside chat/chat_test.",
    );
  }
  const bin = process.env.RIVENDELL_E2E_BIN || path.join(here, "..", "..", "bin", "rivendell");

  mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const log = createWriteStream(LOG_FILE);

  // Captured stdout+stderr: the bootstrap set-password link is parsed from here.
  let captured = "";
  const server = spawn(bin, [], {
    env: {
      ...process.env,
      RIVENDELL_ADDR: addr(),
      RIVENDELL_DATABASE_URL: process.env.E2E_DATABASE_URL,
      RIVENDELL_WEB_DIR: path.join(here, ".."),
      RIVENDELL_PUBLIC_URL: BASE,
      RIVENDELL_BOOTSTRAP_ADMIN: ADMIN,
      RIVENDELL_COOKIE_SECURE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (d) => { captured += d.toString(); log.write(d); });
  }
  server.on("error", (err) => { captured += `\nspawn error: ${err}\n`; });
  writeFileSync(STATE_FILE, JSON.stringify({ pid: server.pid }));

  await waitForServer();

  // --- admin: existing login, or consume the one-time bootstrap link ---------
  let adminCookie = await login(ADMIN, PASSWORD);
  if (!adminCookie) {
    const m = captured.match(/set-password#([A-Za-z0-9._~-]+)/);
    if (!m) {
      throw new Error(
        `cannot log in as ${ADMIN} and no bootstrap set-password link was printed. ` +
        "The e2e database has admins this suite doesn't know the password for — " +
        "point E2E_DATABASE_URL at a fresh, disposable database.",
      );
    }
    await mustJSON(await fetch(BASE + "/api/auth/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: m[1], password: PASSWORD }),
    }), "bootstrap set-password");
    adminCookie = await login(ADMIN, PASSWORD);
    if (!adminCookie) throw new Error("set the bootstrap admin password but the login still fails");
  }

  // --- second user: existing login, or invitation → signup -------------------
  if (!(await login(USER2, PASSWORD))) {
    const inv = await mustJSON(await fetch(BASE + "/api/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({}),
    }), "mint invitation");
    await mustJSON(await fetch(BASE + "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inv.token, username: USER2, password: PASSWORD }),
    }), "invitation signup");
  }
}
