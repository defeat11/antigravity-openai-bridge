// Session anchor — one agy conversation that outlives this process.
// ---------------------------------------------------------------------------
// The ACP adapter keeps its captured agy conversation id in RAM only
// (`session.conversationId`). So every restart of server.js means session/new,
// which means agy is launched with `--new-project`, which means a brand-new
// conversation with no memory. The watchdog restarts we see turn straight into
// "the model forgot everything".
//
// Measured facts this design rests on:
//   * `agy --conversation <id>` resumes a conversation with full server-side
//     memory, and WINS over `--new-project` when both flags are present
//     (verified: seeded a codeword, restarted with both flags, got it back).
//   * The adapter appends ACP_AGY_EXTRA_ARGS to every agy invocation, and
//     gemini-acp.js hands its whole process.env to the adapter child. So
//     setting that variable before the ACP child spawns is enough to pin the
//     conversation — no change to the shared adapter, no rebuild.
//   * Conversations are files at <home>/.gemini/antigravity-cli/conversations/
//     <id>.db, so we can tell a live anchor from a stale one.
//
// We create the anchor ourselves with one throwaway agy run and parse the id
// from our OWN log file. Picking "the newest .db in the store" instead would be
// a race: this machine runs several agy processes at once (telegram bots,
// swarm, fanout) and we would sometimes adopt one of THEIR conversations.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONV_DIR =
  process.env.ACP_AGY_CONV_DIR?.trim() ||
  path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

// Same pattern the adapter uses. agy also logs an abandoned conversation during
// its silent-auth restart, but only ever as "conversation <uuid>" with a space —
// requiring the "=" selects the real print-mode one.
const CONV_ID_RE =
  /conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** True when this conversation still exists on disk and can be resumed. */
export function anchorIsAlive(id) {
  if (!id) return false;
  return existsSync(path.join(CONV_DIR, `${id}.db`));
}

export function loadAnchor(stateFile) {
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8"));
    return typeof raw?.conversationId === "string" ? raw : null;
  } catch {
    return null; // absent or corrupt — both mean "no usable anchor"
  }
}

export function saveAnchor(stateFile, conversationId, extra = {}) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ conversationId, createdAt: new Date().toISOString(), ...extra }, null, 2),
    "utf8",
  );
}

/**
 * Run one short agy prompt to mint a fresh conversation, and read its id back
 * out of our own log file.
 * @returns {Promise<string>} the new conversation id
 */
export function createAnchor({ cwd, model, timeoutMs = 240_000, useShell = false } = {}) {
  const logFile = path.join(
    os.tmpdir(),
    `gemini3010-anchor-${process.pid}-${Date.now().toString(36)}.log`,
  );

  const args = ["--new-project", "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);
  args.push("--log-file", logFile, "--print-timeout", "3m");
  // The seed prompt is never read by anyone; it exists only to make agy open a
  // conversation and write its id to the log. It must stay whitespace-free:
  // the shell fallback below concatenates argv without quoting, and a spaced
  // prompt gets torn into separate arguments ("unexpected argument ...").
  args.push("--print=SESSION-ANCHOR-INIT");

  return new Promise((resolve, reject) => {
    const bin = process.env.ACP_AGY_BIN?.trim() || "agy";
    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      // No shell by default: CreateProcess resolves `agy` -> agy.exe on PATH and
      // keeps every argument intact.
      shell: useShell,
      windowsHide: true,
      env: {
        ...process.env,
        // Must not inherit a pin while minting a NEW conversation, or agy would
        // resume the very conversation we are trying to replace.
        ACP_AGY_EXTRA_ARGS: "",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c) => {
      stderr += c;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new Error(`anchor creation timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    let settled = false;
    const finish = (err, id) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rmSync(logFile, { force: true }); } catch { /* best effort */ }
      err ? reject(err) : resolve(id);
    };

    child.on("error", (e) => finish(Object.assign(e, { spawnFailed: true })));
    child.on("exit", (code) => {
      let text = "";
      try {
        text = readFileSync(logFile, "utf8");
      } catch {
        finish(new Error(`agy wrote no log file (exit ${code}); stderr: ${stderr.slice(-400)}`));
        return;
      }
      const matches = [...text.matchAll(CONV_ID_RE)];
      const id = matches[matches.length - 1]?.[1];
      if (!id) {
        finish(new Error(`no conversation id in agy log (exit ${code}); stderr: ${stderr.slice(-400)}`));
        return;
      }
      finish(null, id);
    });
  });
}

/**
 * Pin ACP_AGY_EXTRA_ARGS to a conversation, preserving any operator-supplied
 * extra args. Mutates process.env so the ACP child inherits it at spawn.
 */
export function pinConversation(conversationId) {
  const existing = (process.env.ACP_AGY_EXTRA_ARGS || "")
    // Drop a previous pin so repeated calls cannot stack --conversation flags.
    .replace(/--conversation(?:=|\s+)\S+/g, "")
    .trim();
  process.env.ACP_AGY_EXTRA_ARGS =
    `${existing} --conversation ${conversationId}`.trim();
  return process.env.ACP_AGY_EXTRA_ARGS;
}

/**
 * Resolve the conversation this server should speak into: reuse the saved one
 * when it is still on disk, otherwise mint a new one. Pins it either way.
 *
 * Never throws — a failure here must degrade to today's behaviour (a fresh
 * conversation per boot), not stop the server from serving.
 *
 * @returns {Promise<{conversationId: string|null, reused: boolean, error?: string}>}
 */
export async function resolveAnchor({ stateFile, cwd, model, forceNew = false } = {}) {
  const saved = forceNew ? null : loadAnchor(stateFile);

  if (saved?.conversationId && anchorIsAlive(saved.conversationId)) {
    pinConversation(saved.conversationId);
    return { conversationId: saved.conversationId, reused: true };
  }

  if (saved?.conversationId) {
    console.warn(
      `[anchor] saved conversation ${saved.conversationId} is gone from disk — minting a new one`,
    );
  }

  try {
    let id;
    try {
      id = await createAnchor({ cwd, model });
    } catch (e) {
      // Only a failure to LAUNCH agy is worth retrying through a shell (some
      // installs expose it as a .cmd shim, which CreateProcess cannot run). A
      // failure after launch is a real error and must not be run twice.
      if (!e.spawnFailed) throw e;
      console.warn(`[anchor] direct spawn failed (${e.message}); retrying via shell`);
      id = await createAnchor({ cwd, model, useShell: true });
    }
    saveAnchor(stateFile, id, { model: model || null, cwd: cwd || null });
    pinConversation(id);
    return { conversationId: id, reused: false };
  } catch (e) {
    console.error(`[anchor] could not create a session anchor: ${e.message}`);
    return { conversationId: null, reused: false, error: e.message };
  }
}

export const ANCHOR_CONV_DIR = CONV_DIR;
