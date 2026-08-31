// GEMINI 3010 — Gemini-only local API (via Antigravity ACP).
// ---------------------------------------------------------------------------
// Brand: GEMINI 3010
// Port:  3010 (configurable via PORT env)
// Backend: ACP only — Antigravity CLI (Gemini Pro / Flash).
//
// Endpoints:
//   GET  /v1/models                OpenAI-compatible model list (Gemini only)
//   POST /v1/chat/completions      OpenAI chat (history + system + real SSE stream)
//   POST /api/think                Deep reasoning — routes to gemini-3.1-pro-high
//   GET  /api/health               ACP session + quota state
//   POST /api/reset                Reset ACP session
//   POST /api/model { modelId }    Switch active model
//
// No modifications to the original gemini-gemini project — imports it only.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { mkdirSync, appendFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AcpBackend } from "./backends/acp.js";
import { resolveAnchor } from "./backends/session-anchor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Conversation archive: every question and answer passing through this port
// lands here — JSONL for tooling, plain text for reading.
const LOG_DIR = path.join(__dirname, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const CONVO_JSONL = path.join(LOG_DIR, "conversations.jsonl");
const CONVO_TXT = path.join(LOG_DIR, "chat_history.txt");

// ---------------------------------------------------------------------------
// Crash black box.
// ---------------------------------------------------------------------------
// The watchdog respawns this process with `-RedirectStandardError`, which
// TRUNCATES server.err.log on every restart — so the reason for a crash was
// being erased by the very restart it triggered. This file is append-only and
// nothing else writes to it, so the death record survives the resurrection.
const CRASH_LOG = path.join(LOG_DIR, "crashes.log");
const BOOT_ID = `${process.pid}@${new Date().toISOString()}`;

function recordCrash(kind, err, extra) {
  // Synchronous on purpose: an async write loses the race against process exit.
  try {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack || "(no stack)"}`
        : String(err);
    appendFileSync(
      CRASH_LOG,
      `\n${"=".repeat(72)}\n` +
        `[${new Date().toISOString()}] ${kind}\n` +
        `boot: ${BOOT_ID}\n` +
        `uptime: ${process.uptime().toFixed(1)}s\n` +
        `rss: ${(process.memoryUsage().rss / 1048576).toFixed(1)} MB\n` +
        (extra ? `extra: ${JSON.stringify(extra)}\n` : "") +
        `${detail}\n`,
      "utf8",
    );
  } catch {
    /* if we cannot even log the crash, do not crash logging the crash */
  }
}

function recordEvent(kind, extra) {
  try {
    appendFileSync(
      CRASH_LOG,
      `[${new Date().toISOString()}] ${kind} | boot: ${BOOT_ID}` +
        (extra ? ` | ${JSON.stringify(extra)}` : "") +
        "\n",
      "utf8",
    );
  } catch { /* noop */ }
}

// Node 15+ kills the process on an unhandled rejection. server.js has plenty of
// un-awaited promises (ACP warmup, log writes), so this was a live crash path
// with no evidence left behind. Record, then let the default behaviour stand —
// we are diagnosing, not papering over.
process.on("uncaughtException", (err, origin) => {
  recordCrash("uncaughtException", err, { origin });
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  recordCrash("unhandledRejection", reason);
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});

// Anything that reaches exit without one of the handlers above (OOM survivors,
// explicit exits, signals) still leaves a line, so the log accounts for every
// death — including the ones with no exception attached.
process.on("exit", (code) => recordEvent("exit", { code }));
process.on("beforeExit", (code) => recordEvent("beforeExit", { code }));
process.on("warning", (w) => recordEvent("warning", { name: w.name, message: w.message }));

recordEvent("boot", { port: process.env.PORT || 3010, node: process.version });

const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 12_000_000);
const THINK_MODEL = process.env.GEMINI_THINK_MODEL || "gemini-3.1-pro-high";
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-high";

const PROJECT_DIR =
  process.env.GEMINI_PROJECT_DIR ||
  path.join(__dirname, "..", "gemini-gemini");
const workspace =
  process.env.GEMINI_WORKSPACE || path.join(__dirname, "_workspace");
mkdirSync(workspace, { recursive: true });

const acp = new AcpBackend({
  projectDir: PROJECT_DIR,
  workspace,
  defaultModel: DEFAULT_MODEL,
  timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 300_000),
  thinkTimeoutMs: Number(process.env.GEMINI_THINK_TIMEOUT_MS || 600_000),
  controlMode: process.env.GEMINI_ACP_CONTROL_MODE || "yolo",
});

// ── Session anchor: survive our own restarts ────────────────────────────
// The ACP adapter holds its agy conversation id in memory, so a restart used
// to mean a brand-new conversation with no memory of anything. We pin the
// conversation through ACP_AGY_EXTRA_ARGS, which the adapter appends to every
// agy invocation. The pin is read when the ACP child SPAWNS, so it has to be
// in place before acp.init() — hence the gate below rather than a bare init().
const SESSION_STATE = path.join(LOG_DIR, "session-anchor.json");
let anchorState = { conversationId: null, reused: false, error: "not resolved yet" };

// المرساة صارت ضارة: العميل يرسل تاريخ المحادثة كاملاً داخل البرومبت،
// فذاكرة agy الخادمية تكرار. والأسوأ أن drainReplay عند الإقلاع أعاد بثّ
// المحادثة المثبّتة كاملة — رد واحد بـ280,901 حرف علّق الجلسة وأوقف كل طلب
// بعده. تُعطَّل افتراضياً، وتُعاد بـ GEMINI_SESSION_ANCHOR=on عند الحاجة.
const ANCHOR_ENABLED =
  String(process.env.GEMINI_SESSION_ANCHOR || "off").toLowerCase() === "on";

const bootGate = (async () => {
  if (!ANCHOR_ENABLED) {
    console.log("[anchor] معطّلة — كل طلب يحمل تاريخه، فلا حاجة لذاكرة خادمية");
    anchorState = { conversationId: null, reused: false, error: "disabled" };
    await acp.init();
    return;
  }
  anchorState = await resolveAnchor({
    stateFile: SESSION_STATE,
    cwd: workspace,
    model: DEFAULT_MODEL,
  });
  if (anchorState.conversationId) {
    console.log(
      `[anchor] ${anchorState.reused ? "resumed existing" : "created new"} conversation ${anchorState.conversationId}`,
    );
    recordEvent("anchor", anchorState);
  } else {
    console.warn("[anchor] running without an anchor — memory will not survive a restart");
    recordEvent("anchor_failed", { error: anchorState.error });
  }
  await acp.init();
  if (anchorState.conversationId) await drainReplay();
})();

/**
 * Burn one turn whose answer nobody sees.
 *
 * A freshly-created ACP session tracks its transcript cursor from -1, so when
 * agy resumes a conversation that already has history, the adapter drains every
 * earlier assistant step into the FIRST reply — the caller gets the whole past
 * conversation glued in front of their actual answer. (Observed: a reply came
 * back as "<anchor seed>OK FALCON-9182".) The cursor only advances once a turn
 * completes, so we spend that turn here instead of spending the user's.
 */
async function drainReplay() {
  try {
    await acp.chat({
      messages: [{ role: "user", content: "ping" }],
      model: DEFAULT_MODEL,
      stream: false,
    });
    console.log("[anchor] replay drained — replies are clean from here");
  } catch (e) {
    console.error(`[anchor] replay drain failed (first reply may repeat history): ${e.message}`);
  }
}
// The gate is awaited from several places; keep one owner for the rejection so
// an anchor failure cannot take the process down as an unhandled rejection.
bootGate.catch((e) => console.error("[boot] startup failed:", e.message));

/** Await startup without letting its failure propagate into a request. */
const ready = () => bootGate.catch(() => {});

/**
 * Abandon the pinned conversation and mint a fresh one. The ACP child must be
 * restarted afterwards: the pin lives in the child's environment, which is
 * fixed at spawn time.
 */
async function rotateAnchor() {
  anchorState = await resolveAnchor({
    stateFile: SESSION_STATE,
    cwd: workspace,
    model: DEFAULT_MODEL,
    forceNew: true,
  });
  await acp.reset();
  // The new conversation already holds the anchor seed turn, so the same replay
  // pollution applies here as at boot.
  if (anchorState.conversationId) await drainReplay();
  console.log(`[anchor] rotated to conversation ${anchorState.conversationId}`);
  recordEvent("anchor_rotated", anchorState);
  return anchorState;
}
// ────────────────────────────────────────────────────────────────────────

// ── Keep-warm heartbeat: ACP session stays alive & waiting for requests ──
// Every 60s: if the session died (crash / idle reap / bridge restart side-
// effects), revive it proactively instead of making the NEXT user request
// pay the cold-start cost. Cheap no-op when already ready.
setInterval(async () => {
  try {
    await ready();
    await acp.init();
    const st = acp.health();
    if (!st.ready && st.state !== "starting") {
      await acp._client.ensureReady();
      console.log("[keepwarm] ACP session revived proactively | state:", acp.health().state);
    }
  } catch (e) {
    console.error("[keepwarm] revive failed:", e.message);
  }
}, 60_000);
// ────────────────────────────────────────────────────────────────────────

console.log("[startup] === GEMINI 3010 (Gemini only) ===");
console.log("[startup] Port:", PORT);
console.log("[startup] Project dir:", PROJECT_DIR);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { message, type: code, code } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function nowId() {
  return `chatcmpl-g3010-${Date.now().toString(36)}`;
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  };
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isGeminiModel(modelId) {
  return String(modelId || "").startsWith("gemini-");
}

// ---------------------------------------------------------------------------
// Conversation logging — never throws; logging must not break the API.
// ---------------------------------------------------------------------------

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim();
    if (Array.isArray(m.content)) {
      const t = m.content
        .filter((p) => p?.type === "text")
        .map((p) => String(p.text || ""))
        .join("\n")
        .trim();
      if (t) return t;
    }
  }
  return "";
}

async function logConversation(entry) {
  try {
    const record = { ts: new Date().toISOString(), ...entry };
    await appendFile(CONVO_JSONL, JSON.stringify(record) + "\n", "utf8");
    const when = new Date().toLocaleString("ar-EG");
    const block =
      `\n${"=".repeat(64)}\n` +
      `التاريخ: ${when}\n` +
      `النموذج: ${entry.model || "?"}\n` +
      (entry.thinkMode ? `الوضع: تفكير عميق\n` : "") +
      `السؤال: ${lastUserText(entry.messages) || "(فارغ)"}\n` +
      `الرد: ${entry.reply || "(بلا رد)"}\n` +
      (entry.error ? `خطأ: ${entry.error}\n` : "") +
      `المدة: ${entry.elapsedMs ?? "?"} ms\n` +
      `${"=".repeat(64)}\n`;
    await appendFile(CONVO_TXT, block, "utf8");
  } catch (e) {
    console.error("[log] write failed:", e.message);
  }
}

async function handleGetLogs(req, res, requestUrl) {
  const limit = Math.max(1, Math.min(500, Number(requestUrl.searchParams.get("limit")) || 50));
  try {
    const raw = await readFile(CONVO_JSONL, "utf8").catch(() => "");
    const lines = raw.split("\n").filter(Boolean);
    const entries = lines
      .slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
    sendJson(res, 200, { ok: true, count: entries.length, total: lines.length, entries });
  } catch (e) {
    sendError(res, 500, "log_read_failed", e.message);
  }
}

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------

async function handleChatCompletions(req, res, { thinkMode = false } = {}) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    sendError(res, 400, "bad_request", e.message || "Invalid JSON");
    return;
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    sendError(res, 400, "bad_request", "messages must be a non-empty array");
    return;
  }

  const requestedModel = String(payload.model || "").trim();

  // Gemini-only policy: unknown/foreign models are refused with a clear error.
  if (requestedModel && !isGeminiModel(requestedModel)) {
    sendError(
      res,
      400,
      "model_not_supported",
      `GEMINI 3010 serves Gemini models only; "${requestedModel}" is not a gemini-* model.`,
    );
    return;
  }

  // /api/think defaults to Pro unless the caller pinned another Gemini model.
  const effectiveModel =
    thinkMode && !requestedModel
      ? THINK_MODEL
      : requestedModel || DEFAULT_MODEL;

  const wantStream = Boolean(payload.stream);
  // Diagnostics: prove whether the caller actually attached tools.
  const toolsCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
  const toolNames = Array.isArray(payload.tools)
    ? payload.tools.map((t) => t?.function?.name).filter(Boolean).slice(0, 8).join(",")
    : "";
  console.log(`[chat] tools=${toolsCount} [${toolNames}] stream=${wantStream} msgs=${payload.messages.length}`);
  // "fresh": true -> wipe the ACP session first: a clean Gemini with no memory
  // of anything said before this request. Useful after switching topics or
  // when a shared harness session replays old plumbing into the prompt.
  await ready();
  if (payload.fresh === true) {
    try {
      // Rotate, not just reset: a reset alone restarts the ACP child but the
      // pin sends it straight back into the same agy conversation, so the old
      // memory would survive the very request that asked to be rid of it.
      await rotateAnchor();
      console.log("[chat] fresh session requested -> new agy conversation");
    } catch (e) {
      console.error(`[chat] fresh rotate failed (continuing): ${e.message}`);
    }
  }
  const id = nowId();
  const created = Math.floor(Date.now() / 1000);
  let fullReply = "";
  let aborted = false;

  if (wantStream) {
    res.writeHead(200, sseHeaders());
    sseWrite(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: effectiveModel,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch { /* noop */ }
    }, 15_000);
    req.on("close", () => { aborted = true; clearInterval(heartbeat); });

    try {
      const result = await acp.chat({
        messages: payload.messages,
        model: effectiveModel,
        stream: true,
        tools: payload.tools,
        onChunk: (chunk) => {
          fullReply += chunk;
          sseWrite(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: effectiveModel,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          });
        },
      });
      clearInterval(heartbeat);

      // Tool-bridge mode: the buffered reply parsed into a harness tool call.
      if (result.toolCall) {
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: effectiveModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: result.toolCall.id,
                    type: "function",
                    function: { name: result.toolCall.name, arguments: result.toolCall.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: effectiveModel,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: result.tokens?.prompt || 0,
            completion_tokens: result.tokens?.completion || 0,
            total_tokens: result.tokens?.total || 0,
            elapsed_ms: result.elapsedMs,
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        console.log(`[chat] stream tool_call=${result.toolCall.name} elapsed=${result.elapsedMs}ms`);
        logConversation({ model: effectiveModel, messages: payload.messages, reply: `[tool_call] ${result.toolCall.name}(${result.toolCall.arguments})`, elapsedMs: result.elapsedMs, thinkMode, stream: true }).catch(() => {});
        return;
      }

      // Tool mode buffers the reply (onChunk stays silent), so when the model
      // answered with plain text instead of a tool call, emit it here.
      if (!fullReply && result.reply) {
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: effectiveModel,
          choices: [{ index: 0, delta: { content: result.reply }, finish_reason: null }],
        });
      }

      sseWrite(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: result.tokens?.prompt || 0,
          completion_tokens: result.tokens?.completion || 0,
          total_tokens: result.tokens?.total || 0,
          elapsed_ms: result.elapsedMs,
          think_mode: thinkMode,
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
      const delivered = fullReply || (result.reply || "");
      console.log(`[chat] stream ok model=${effectiveModel} elapsed=${result.elapsedMs}ms chars=${delivered.length}`);
      logConversation({ model: effectiveModel, messages: payload.messages, reply: fullReply, elapsedMs: result.elapsedMs, thinkMode, stream: true }).catch(() => {});
    } catch (e) {
      clearInterval(heartbeat);
      logConversation({ model: effectiveModel, messages: payload.messages, reply: fullReply, error: e.message, thinkMode, stream: true }).catch(() => {});
      if (aborted) { try { res.end(); } catch {} return; }
      sseWrite(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: effectiveModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        error: { message: e.message, type: "acp_error" },
      });
      res.write("data: [DONE]\n\n");
      res.end();
      console.error(`[chat] stream err model=${effectiveModel}: ${e.message}`);
    }
    return;
  }

  // Non-stream
  try {
    const result = await acp.chat({
      messages: payload.messages,
      model: effectiveModel,
      stream: false,
      tools: payload.tools,
    });

    if (result.toolCall) {
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: effectiveModel,
        backend: "acp",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: result.toolCall.id,
                  type: "function",
                  function: { name: result.toolCall.name, arguments: result.toolCall.arguments },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: result.tokens?.prompt || 0,
          completion_tokens: result.tokens?.completion || 0,
          total_tokens: result.tokens?.total || 0,
          elapsed_ms: result.elapsedMs,
          think_mode: thinkMode,
        },
      });
      console.log(`[chat] tool_call=${result.toolCall.name} elapsed=${result.elapsedMs}ms`);
      logConversation({ model: effectiveModel, messages: payload.messages, reply: `[tool_call] ${result.toolCall.name}(${result.toolCall.arguments})`, elapsedMs: result.elapsedMs, thinkMode, stream: false }).catch(() => {});
      return;
    }

    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: effectiveModel,
      backend: "acp",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.reply || "" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: result.tokens?.prompt || 0,
        completion_tokens: result.tokens?.completion || 0,
        total_tokens: result.tokens?.total || 0,
        elapsed_ms: result.elapsedMs,
        think_mode: thinkMode,
      },
    });
    console.log(`[chat] ok model=${effectiveModel} elapsed=${result.elapsedMs}ms chars=${(result.reply || "").length}`);
    logConversation({ model: effectiveModel, messages: payload.messages, reply: result.reply || "", elapsedMs: result.elapsedMs, thinkMode, stream: false }).catch(() => {});
  } catch (e) {
    logConversation({ model: effectiveModel, messages: payload.messages, reply: "", error: e.message, thinkMode, stream: false }).catch(() => {});
    sendError(res, 500, "acp_error", e.message);
  }
}

// ---------------------------------------------------------------------------
// Other endpoints
// ---------------------------------------------------------------------------

function handleModels(req, res) {
  sendJson(res, 200, { object: "list", data: acp.listModels() });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    brand: "GEMINI 3010",
    models_policy: "gemini-only",
    port: PORT,
    session_anchor: {
      conversation_id: anchorState.conversationId,
      resumed_from_disk: anchorState.reused,
      pinned_args: process.env.ACP_AGY_EXTRA_ARGS || "",
      error: anchorState.error || null,
    },
    acp: acp.health(),
    model_count: acp.listModels().length,
    workspace,
    project_dir: PROJECT_DIR,
  });
}

// Restart the ACP session but stay in the SAME agy conversation — the pin is
// still in the environment, so the child comes back with its memory intact.
// This is the recovery path; use /api/session/new to actually forget.
async function handleReset(req, res) {
  try {
    await ready();
    await acp.reset();
    sendJson(res, 200, {
      ok: true,
      conversation_id: anchorState.conversationId,
      note: "ACP session restarted; agy conversation preserved",
    });
  } catch (e) {
    sendError(res, 500, "reset_failed", e.message);
  }
}

// Deliberately forget: abandon the pinned conversation and start a new one.
async function handleNewSession(req, res) {
  try {
    await ready();
    const state = await rotateAnchor();
    sendJson(res, 200, { ok: true, conversation_id: state.conversationId, error: state.error || null });
  } catch (e) {
    sendError(res, 500, "session_new_failed", e.message);
  }
}

async function handleSetModel(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendError(res, 400, "bad_request", "invalid json");
    return;
  }
  try {
    const state = await acp.setModel(String(body.modelId || ""));
    sendJson(res, 200, { ok: true, ...state });
  } catch (e) {
    sendError(res, 500, "model_failed", e.message);
  }
}

// ---------------------------------------------------------------------------
// Log viewer page — Arabic, RTL, dark. Reads /api/logs and renders cards.
// ---------------------------------------------------------------------------

function serveLogViewer(req, res) {
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GEMINI 3010 — سجل المحادثات</title>
<style>
  :root { --bg:#0f1117; --card:#1a1d27; --line:#2a2e3d; --txt:#e8eaf2; --dim:#8b90a3; --accent:#7c9cff; --q:#2b2437; --a:#1c2a24; }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--txt); font-family:"Segoe UI", Tahoma, sans-serif; margin:0; padding:20px; }
  header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
  h1 { font-size:20px; margin:0; } .brand { color:var(--accent); }
  .meta { color:var(--dim); font-size:13px; }
  input[type=text] { flex:1; min-width:220px; background:var(--card); border:1px solid var(--line); color:var(--txt); padding:10px 14px; border-radius:10px; font-size:15px; outline:none; }
  input[type=text]:focus { border-color:var(--accent); }
  button { background:var(--card); border:1px solid var(--line); color:var(--txt); padding:10px 16px; border-radius:10px; cursor:pointer; font-size:14px; }
  button:hover { border-color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  .head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px; font-size:13px; color:var(--dim); }
  .model { background:var(--line); color:var(--txt); padding:2px 10px; border-radius:99px; font-size:12px; }
  .err { background:#3a1d24; color:#ff8fa3; padding:2px 10px; border-radius:99px; font-size:12px; }
  .think { background:#3a3320; color:#ffd28a; padding:2px 10px; border-radius:99px; font-size:12px; }
  .q { background:var(--q); border-radius:10px; padding:10px 14px; margin-bottom:8px; white-space:pre-wrap; line-height:1.7; }
  .a { background:var(--a); border-radius:10px; padding:10px 14px; white-space:pre-wrap; line-height:1.7; }
  .lbl { font-size:12px; color:var(--dim); margin-bottom:4px; }
  .empty { text-align:center; color:var(--dim); padding:40px 0; }
  .hidden { display:none; }
  details summary { cursor:pointer; color:var(--dim); font-size:13px; }
  details pre { white-space:pre-wrap; font-size:12px; color:var(--dim); max-height:200px; overflow:auto; }
</style>
</head>
<body>
<header>
  <h1><span class="brand">GEMINI 3010</span> — سجل المحادثات</h1>
  <span class="meta" id="meta"></span>
  <input type="text" id="search" placeholder="🔍 ابحث في الأسئلة والأجوبة...">
  <button onclick="load()">تحديث ⟳</button>
</header>
<main id="list"><div class="empty">جاري التحميل...</div></main>
<script>
let all = [];
function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
async function load(){
  try {
    const r = await fetch("/api/logs?limit=300");
    const j = await r.json();
    all = j.entries || [];
    document.getElementById("meta").textContent = \`معروض: \${j.count} من إجمالي \${j.total}\`;
    render();
  } catch(e){
    document.getElementById("list").innerHTML = '<div class="empty">تعذر تحميل السجل: '+esc(e.message)+'</div>';
  }
}
function render(){
  const q = document.getElementById("search").value.trim().toLowerCase();
  const items = all.filter(e => !q || JSON.stringify([e.reply, e.messages]).toLowerCase().includes(q));
  const list = document.getElementById("list");
  if (!items.length) { list.innerHTML = '<div class="empty">لا توجد محادثات مسجلة بعد.</div>'; return; }
  list.innerHTML = items.map((e,i) => {
    const t = new Date(e.ts).toLocaleString("ar-EG");
    let lastQ = "";
    if (Array.isArray(e.messages)) for (let k = e.messages.length-1; k>=0; k--) { if (e.messages[k]?.role === "user") { lastQ = typeof e.messages[k].content === "string" ? e.messages[k].content : JSON.stringify(e.messages[k].content); break; } }
    return '<div class="card">' +
      '<div class="head"><span>🕒 ' + esc(t) + '</span>' +
      '<span class="model">' + esc(e.model || "?") + '</span>' +
      (e.thinkMode ? '<span class="think">🧠 تفكير عميق</span>' : '') +
      (e.error ? '<span class="err">⚠ خطأ</span>' : '') +
      '<span>⏱ ' + esc(e.elapsedMs ?? "?") + 'ms</span></div>' +
      '<div class="lbl">السؤال:</div><div class="q">' + esc(lastQ) + '</div>' +
      '<div class="lbl">الرد:</div><div class="a">' + esc(e.error ? "خطأ: " + e.error : e.reply) + '</div>' +
      (Array.isArray(e.messages) && e.messages.length > 2 ?
        '<details style="margin-top:10px"><summary>عرض المحادثة كاملة (' + e.messages.length + ' رسالة)</summary><pre>' + esc(JSON.stringify(e.messages, null, 2)) + '</pre></details>' : '') +
      '</div>';
  }).join("");
}
document.getElementById("search").addEventListener("input", render);
setInterval(load, 15000);
load();
</script>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // Pathname only — query strings must not break exact route matching.
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  const url = requestUrl.pathname;
  console.log(`[req] ${req.method} ${req.url}`);

  try {
    if (req.method === "GET" && url === "/v1/models") return handleModels(req, res);
    if (req.method === "GET" && url === "/api/health") return handleHealth(req, res);
    if (req.method === "GET" && url === "/api/logs") {
      return await handleGetLogs(req, res, requestUrl);
    }
    if (req.method === "GET" && (url === "/logs" || url === "/logs/")) return serveLogViewer(req, res);
    if (req.method === "POST" && url === "/api/reset") return await handleReset(req, res);
    if (req.method === "POST" && url === "/api/session/new") return await handleNewSession(req, res);
    if (req.method === "POST" && url === "/api/model") return await handleSetModel(req, res);
    if (req.method === "POST" && url === "/api/think") return await handleChatCompletions(req, res, { thinkMode: true });
    if (req.method === "POST" && url === "/v1/chat/completions") return await handleChatCompletions(req, res, { thinkMode: false });
    if (req.method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        "GEMINI 3010 — Gemini-only local API (Antigravity ACP).\n" +
        "Endpoints:\n" +
        "  GET  /v1/models\n" +
        "  GET  /api/health\n" +
        "  GET  /api/logs?limit=100   (conversation archive)\n" +
        "  GET  /logs                 (Arabic viewer page)\n" +
        "  POST /v1/chat/completions\n" +
        "  POST /api/think\n" +
        "  POST /api/reset\n" +
        "  POST /api/model { modelId }\n",
      );
      return;
    }
    sendError(res, 404, "not_found", `No route for ${req.method} ${url}`);
  } catch (e) {
    console.error("[error]", e);
    if (!res.headersSent) sendError(res, 500, "server_error", e.message);
    else { try { res.end(); } catch {} }
  }
});

// Duplicate-instance guard. Two `node server.js` processes were observed alive
// at once (same second, same argv): the loser cannot bind, but without this it
// lingers holding an ACP child and a warm-up timer, doubling load on agy and
// muddying which process the logs belong to. Losing the port means losing the
// job — so say why, and leave.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    recordCrash("listen_EADDRINUSE", err, { port: PORT, host: HOST });
    console.error(`[fatal] port ${PORT} already in use — another instance owns it. Exiting.`);
  } else {
    recordCrash("listen_error", err, { port: PORT, host: HOST });
  }
  try { acp._client?.stop?.(); } catch { /* nothing to stop yet */ }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`GEMINI 3010 listening on http://${HOST}:${PORT}`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /api/health`);
  console.log(`  POST /v1/chat/completions   (OpenAI-compatible, Gemini only)`);
  console.log(`  POST /api/think              (deep reasoning -> ${THINK_MODEL})`);
  console.log(`  POST /api/reset`);
  console.log(`  POST /api/model  { "modelId": "..." }`);
  console.log(`  GET  /logs                   (سجل المحادثات - Arabic viewer)`);
});

function shutdown(sig) {
  recordEvent("signal_shutdown", { signal: sig });
  console.log(`\n[shutdown] ${sig}`);
  try { acp._client?.stop?.(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
