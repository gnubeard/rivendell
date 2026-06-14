// e2e/global-setup.js — boot a real rivendell server and provision two users.
//
// User provisioning goes through the public surface (bootstrap log line, magic
// link, invitation API) — no test-only backdoors in the server. Each run starts
// from a clean database (resetDatabase below drops + recreates the schema before
// the server boots), so runs are independent and fixtures never accumulate; the
// reset is the one bit of direct DB access, and only against the disposable e2e
// database. (Set E2E_DB_RESET=off to reuse the DB the old way.)
//
// Requirements (enforced below with explicit errors):
//   - E2E_DATABASE_URL pointing at a DISPOSABLE Postgres database — it is wiped at
//     the start of every run. After the wipe the server's first-boot bootstrap
//     fires and prints the one-time set-password link we consume here.
//   - The server binary at RIVENDELL_E2E_BIN (default ../bin/rivendell —
//     `make test-e2e` builds it first).
import { spawn, execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BASE = process.env.E2E_BASE_URL || "http://localhost:18080";
export const ADMIN = "e2e_admin";
export const USER2 = "e2e_user2";
export const USER3 = "e2e_user3"; // third member, for group-call specs
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

// resetDatabase wipes the e2e database to a clean schema before the server boots,
// so every run starts fresh (the server then migrates and first-boot-bootstraps a
// new admin). The e2e DB is disposable by contract — this is test infrastructure
// resetting its own throwaway database, not a server backdoor. Without it the DB
// accumulates fixtures across runs, and specs have to dodge the leftovers with
// unique names (and still hit accumulation flakes like rows scrolling off-screen).
//
// How the reset reaches Postgres is the developer's environment, not the repo's:
//   - E2E_DB_RESET_CMD — a shell command that resets the DB. The wipe SQL is
//     exported to it as $E2E_RESET_SQL, so it only supplies the access path, e.g.
//     a `psql` run inside whatever local container hosts the e2e database.
//   - otherwise — a host `psql` pointed straight at E2E_DATABASE_URL.
//   - E2E_DB_RESET=off — skip the reset and reuse the DB (the old behavior).
function resetDatabase() {
  if (process.env.E2E_DB_RESET === "off") {
    console.log("e2e: E2E_DB_RESET=off — reusing the existing database (data accumulates)");
    return;
  }
  const sql = "DROP SCHEMA public CASCADE; CREATE SCHEMA public;";
  try {
    if (process.env.E2E_DB_RESET_CMD) {
      execSync(process.env.E2E_DB_RESET_CMD, { stdio: "pipe", env: { ...process.env, E2E_RESET_SQL: sql } });
    } else {
      execFileSync("psql", [process.env.E2E_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
    }
    console.log("e2e: reset the database to a clean schema");
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    throw new Error(
      "e2e: failed to reset the database before the run:\n" + detail + "\n" +
      "Set E2E_DB_RESET_CMD to a command that resets your e2e database (it can run the\n" +
      "exported $E2E_RESET_SQL), ensure a host `psql` can reach E2E_DATABASE_URL, or set\n" +
      "E2E_DB_RESET=off to reuse the DB (specs then rely on unique fixtures).",
    );
  }
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

  // Start from a clean database so runs are independent (must happen before the
  // server boots, so its first-boot bootstrap fires against the empty schema).
  resetDatabase();

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

  // --- additional users: existing login, or invitation → signup --------------
  for (const username of [USER2, USER3]) {
    if (await login(username, PASSWORD)) continue;
    const inv = await mustJSON(await fetch(BASE + "/api/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({}),
    }), "mint invitation");
    await mustJSON(await fetch(BASE + "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inv.token, username, password: PASSWORD }),
    }), "invitation signup");
  }
}
