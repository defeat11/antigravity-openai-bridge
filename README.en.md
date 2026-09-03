# antigravity-openai-bridge

[العربية](README.md)

**It takes requests from any standard OpenAI client. It returns Gemini answers from the Antigravity ACP CLI, with real SSE streaming.**

One Node server, no external dependencies: **1,711 lines of JavaScript**
(measured with `wc -l server.js backends/*.js`). package.json has `"dependencies": {}`.
It serves 9 HTTP routes. The main one is `/v1/chat/completions`. It works with OpenAI SDK clients as-is.

> Honest note: the bridge does not run on its own. It needs three things:
> [antigravity-acp](https://github.com/defeat11/antigravity-acp) (published on the same account),
> a `gemini-acp.js` module that exports `GeminiAcpClient`, and a local `agy` install.

## The problem

Antigravity CLI is an interactive coding agent. It reads and writes text over stdio only.

It has no HTTP, no OpenAI compatibility, and no tool calling.
Its session memory also dies with the process.

But every ready-made client speaks OpenAI. This includes any OpenAI SDK,
web UIs like Open WebUI, and agent harnesses. The harnesses send `tools[]` and expect `tool_calls`.

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
| backends/session-anchor.js | 201 | pins one agy conversation, so memory stays alive after a server restart |
| backends/toolbridge.js | 160 | turns tool schemas into a text protocol, and parses the calls back |

Two test files run the real OpenAI SDK against the server.
They hold 23 checks in total (measured with `grep -c "check(" *.mjs`, giving 14 + 9).

## The key design decision

**Problem:** agent harnesses send `tools[]` and expect `tool_calls`.
The model behind ACP only returns free text.

**Decision:** a text tool bridge. The bridge writes the tool schemas into the
prompt as a strict protocol. When the model needs a tool, it answers with one
JSON line. `parseToolCall` turns that line back into a real `tool_calls`
response. The client runs the tool, never the bridge.

**Cost/benefit:** in tool mode the server buffers the reply before it sends it.
So token-by-token streaming is lost. The protocol JSON must never reach the user.
The payoff: any OpenAI agent harness now runs on a CLI with no function calling.

### A decision we reversed after measuring

We built a "session anchor". It pins one agy conversation through
`ACP_AGY_EXTRA_ARGS`, so memory stays alive after a restart. Then a comment in
`server.js` recorded the incident that changed our mind. At boot, replaying the
pinned conversation produced one **280,901-character** reply. That reply hung
the session. Clients already send the full history with every request. So the
anchor is now off by default. It comes back with `GEMINI_SESSION_ANCHOR=on` when needed.

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
| /api/session/new | POST | forget on purpose: a fresh conversation |
| /api/model | POST | switch the active model |
| /api/logs | GET | conversation archive as JSON |
| /logs | GET | Arabic viewer page for the archive |

You can tune everything with 20 documented environment variables in `.env.example`
(measured with `grep -cE '^[A-Z]' .env.example`).

## Why I built it

All my clients speak OpenAI. The Antigravity interface is interactive only.
The bridge opened 6 Gemini models to any standard client. I did not change one line in the client.
