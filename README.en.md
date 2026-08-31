# antigravity-openai-bridge

[العربية](README.md)

**Takes requests from any standard OpenAI client and returns Gemini answers from the Antigravity ACP CLI, with real SSE streaming.**

One Node server, zero external dependencies: **1,711 lines of JavaScript**
(measured with `wc -l server.js backends/*.js`) and `"dependencies": {}` in package.json.
It serves 9 HTTP routes; the main one, `/v1/chat/completions`, works with OpenAI SDK clients as-is.

> Honest note: the bridge does not run on its own. It needs
> [antigravity-acp](https://github.com/defeat11/antigravity-acp) (published on the same account),
> a `gemini-acp.js` module exporting `GeminiAcpClient`, and a local `agy` install.

## The problem

Antigravity CLI is an interactive coding agent. It reads and writes text over stdio only.

It has no HTTP, no OpenAI compatibility, no tool calling.
And its session memory dies with the process.

Meanwhile every ready-made client speaks OpenAI: any OpenAI SDK,
web UIs like Open WebUI, and agent harnesses that send `tools[]` and expect `tool_calls`.

## How it works

```
OpenAI client (SDK / web UI / agent harness)
  └─ server.js                    9 routes, SSE streaming, conversation archive
      └─ backends/acp.js          builds the prompt, manages session and size guards
          ├─ backends/toolbridge.js   text tool-calling protocol
          └─ gemini-acp.js (external) ACP client over stdio
              └─ antigravity-acp      the adapter
                  └─ agy              the model itself
```

| File | Lines | Role |
|------|-------|------|
| server.js | 881 | routing, SSE with a heartbeat every 15 seconds, crash black box |
| backends/acp.js | 469 | prompt building, last-20-turns window, duplicate-tool-call guard |
| backends/session-anchor.js | 201 | pins one agy conversation so memory survives server restarts |
| backends/toolbridge.js | 160 | renders tool schemas into a text protocol and parses calls back |

Two test files drive the real OpenAI SDK against the server:
23 checks in total (measured with `grep -c "check(" *.mjs`, giving 14 + 9).

## The key design decision

**Problem:** agent harnesses send `tools[]` and expect `tool_calls`,
but the model behind ACP only ever returns free text.

**Decision:** a text tool bridge. Tool schemas are rendered into the prompt
as a strict protocol; when the model needs a tool it answers with a single
JSON line, which `parseToolCall` turns back into a genuine `tool_calls`
response. Execution stays on the client side, never in the bridge.

**Cost/benefit:** in tool mode the reply is buffered before sending,
so token-by-token streaming is lost — protocol JSON must never leak to the user.
The payoff: any OpenAI agent harness runs on top of a CLI that has no function calling at all.

### A decision we reversed after measuring

We built a "session anchor" that pins one agy conversation through
`ACP_AGY_EXTRA_ARGS`, so memory survives restarts. Then a comment in
`server.js` recorded the decisive incident: replaying the pinned conversation
at boot produced a single **280,901-character** reply that hung the session.
Since clients already send full history with every request, the anchor is now
off by default and comes back with `GEMINI_SESSION_ANCHOR=on` when needed.

## Running it

```powershell
Copy-Item .env.example .env
node --env-file=.env server.js
curl http://127.0.0.1:3010/api/health
```

To keep it alive permanently on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File keepalive-gemini3010.ps1
```

| Route | Method | Purpose |
|-------|--------|---------|
| /v1/models | GET | OpenAI-compatible model list (static catalog of 6 models + live ones) |
| /v1/chat/completions | POST | full chat: history, system, streaming, tools |
| /api/think | POST | deep reasoning with a longer timeout and the Pro model |
| /api/health | GET | ACP session and anchor state |
| /api/reset | POST | restart the session, keep the conversation |
| /api/session/new | POST | deliberate forgetting: a fresh conversation |
| /api/model | POST | switch the active model |
| /api/logs | GET | conversation archive as JSON |
| /logs | GET | Arabic viewer page for the archive |

Everything is tunable through 20 documented environment variables in `.env.example`
(measured with `grep -cE '^[A-Z]' .env.example`).

## Why I built it

All my clients speak OpenAI, and the Antigravity interface is interactive only.
The bridge made 6 Gemini models available to any standard client without changing a line in it.
