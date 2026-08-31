// ACP backend — wraps the existing `GeminiAcpClient` from the gemini-gemini project.
// Does not modify the original project. Imports the client as a dependency.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolsProtocol, parseToolCall, renderConversation } from "./toolbridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pathToFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
}

export class AcpBackend {
  /**
   * @param {Object} opts
   * @param {string} opts.projectDir    path to gemini-gemini (must contain gemini-acp.js)
   * @param {string} [opts.workspace]
   * @param {string} [opts.defaultModel]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.thinkTimeoutMs]
   * @param {string} [opts.controlMode]
   */
  constructor(opts) {
    if (!opts?.projectDir) {
      throw new Error("AcpBackend: projectDir is required");
    }
    this.projectDir = opts.projectDir;
    this.workspace = opts.workspace || path.join(__dirname, "..", "_workspace");
    this.defaultModel = opts.defaultModel || process.env.GEMINI_MODEL || "gemini-3.5-flash-high";
    this.timeoutMs = Number(opts.timeoutMs || process.env.GEMINI_TIMEOUT_MS || 300_000);
    this.thinkTimeoutMs = Number(opts.thinkTimeoutMs || process.env.GEMINI_THINK_TIMEOUT_MS || 600_000);
    this.controlMode = opts.controlMode || process.env.GEMINI_ACP_CONTROL_MODE || "yolo";
    this.viewOnly = process.env.GEMINI_ACP_VIEW_ONLY === "true";
    this.viewOnlyMode = process.env.GEMINI_ACP_VIEW_ONLY_MODE || "plan";
    // Stateless API mode: tear down the ACP session before every prompt so the
    // only memory is the request body itself. The caller owns conversation state; agy's server-side brain must not.
    this.stateless = opts.stateless ?? process.env.GEMINI_STATELESS !== "false";
    this.name = "acp";

    this._client = null;
    this._runner = null;
  }

  async init() {
    if (this._client) return;
    const url = pathToFileUrl(path.join(this.projectDir, "gemini-acp.js"));
    const mod = await import(url);
    const { GeminiAcpClient, resolveGeminiRunner } = mod;
    this._runner = resolveGeminiRunner();
    this._client = new GeminiAcpClient({
      cwd: this.workspace,
      model: this.defaultModel,
      timeoutMs: this.timeoutMs,
      viewOnly: this.viewOnly,
      controlMode: this.controlMode,
      viewOnlyMode: this.viewOnlyMode,
    });
    // Warm up so the first chat request doesn't pay startup cost.
    this._client.warm().catch(() => {});
  }

  /**
   * Static catalog — models we know the ACP CLI supports via mapToCliModelName().
   */
  static catalog() {
    return [
      { id: "gemini-3.7-flash-high",   cli: "Gemini 3.7 Flash (High)",   display_name: "Gemini 3.7 Flash (High)",   description: "أحدث إصدار Flash — الافتراضي." },
      { id: "gemini-3.5-flash-high",   cli: "Gemini 3.5 Flash (High)",   display_name: "Gemini 3.5 Flash (High)",   description: "أعلى أداء تفكير وبرمجة." },
      { id: "gemini-3.5-flash-medium", cli: "Gemini 3.5 Flash (Medium)", display_name: "Gemini 3.5 Flash (Medium)", description: "توازن بين الجودة والسرعة." },
      { id: "gemini-3.5-flash-low",    cli: "Gemini 3.5 Flash (Low)",    display_name: "Gemini 3.5 Flash (Low)",    description: "أسرع استجابة." },
      { id: "gemini-3.1-pro-high",     cli: "Gemini 3.1 Pro (High)",     display_name: "Gemini 3.1 Pro (High)",     description: "Gemini Pro — أقوى للاستدلال." },
      { id: "gemini-3.1-pro-low",      cli: "Gemini 3.1 Pro (Low)",      display_name: "Gemini 3.1 Pro (Low)",      description: "Gemini Pro — وضع اقتصادي." },
    ];
  }

  toOpenAIModel(entry) {
    return {
      id: entry.id,
      object: "model",
      created: 1700000000,
      owned_by: "google",
      display_name: entry.display_name,
      description: entry.description,
      backend: "acp",
      cli: entry.cli,
    };
  }

  /**
   * Combines our static catalog with whatever the ACP session exposes live.
   */
  listModels() {
    const live = this._client?.getModelState?.()?.availableModels || [];
    const seen = new Set();
    const out = [];
    for (const e of AcpBackend.catalog()) {
      out.push(this.toOpenAIModel(e));
      seen.add(e.id);
    }
    for (const m of live) {
      const id = m.modelId || m.id;
      if (!id || seen.has(id)) continue;
      out.push({
        id,
        object: "model",
        created: 1700000000,
        owned_by: "google",
        display_name: m.name || id,
        description: m.description || "",
        backend: "acp",
        cli: id,
      });
      seen.add(id);
    }
    return out;
  }

  health() {
    if (!this._client) return { ok: false, state: "uninitialized" };
    return {
      ok: true,
      state: this._client.state,
      ready: this._client.isReady(),
      model: this._client.currentModelId,
      runner: this._runner?.label,
      modes: this._client.getModeState?.()?.availableModes || [],
      control_mode: this._client.currentModeId,
      stats: this._client.stats,
      last_error: this._client.lastError || null,
    };
  }

  async setModel(modelId) {
    await this.init();
    return this._client.setModel(modelId);
  }

  async reset() {
    await this.init();
    return this._client.reset();
  }

  /**
   * @param {Object} req
   * @param {Array}  req.messages
   * @param {string} [req.model]
   * @param {boolean} [req.stream]
   * @param {number} [req.timeoutMs]
   * @param {Array}  [req.tools]     OpenAI tool definitions; presence switches
   *                                 the request into agent (tool-bridge) mode.
   * @param {(chunk:string)=>void} [req.onChunk]
   */
  async chat(req) {
    await this.init();
    const { messages, model, stream = false, timeoutMs, onChunk, tools } = req;

    if (model && this._client.currentModelId !== model) {
      await this._client.setModel(model);
    }

    // Stateless mode: wipe the ACP session (and with it agy's conversation
    // resume) so each request sees only what the caller sent. History arrives
    // in the request body; server-side memory would only cause context bleed.
    if (this.stateless) {
      try {
        await this._client.reset();
      } catch (e) {
        console.error(`[acp] stateless reset failed (continuing): ${e.message}`);
      }
    }

    // Tool-bridge mode: render harness tools into the text protocol and let
    // the model answer with one JSON call when a tool is needed.
    const allowedTools =
      Array.isArray(tools) && tools.length > 0
        ? new Map(
            tools
              .filter((t) => t?.type === "function" && t.function?.name)
              .map((t) => [t.function.name, t.function]),
          )
        : null;

    let prompt;
    if (allowedTools) {
      const { systemText, lines } = renderConversation(messages, AGENT_DIRECTIVE);
      const window = lines.slice(-HISTORY_MAX_TURNS);
      // Protocol goes LAST, right against the generation point — but the
      // closing instruction adapts to the conversation state: a fresh request
      // gets "call when needed"; a turn that just received a tool result gets
      // "answer NOW from that result, do not call again". A static call-to-
      // action here caused infinite re-calls of already-satisfied tools.
      const lastIsToolResult =
        window.length > 0 && window[window.length - 1].startsWith("نتيجة الأداة");
      const closing = lastIsToolResult
        ? "وصلتك نتيجة الأداة في نهاية السجل أعلاه. إن أتمّت الطلب كله فضع الجواب النهائي في reply. وإن بقيت خطوة لم تُنفّذ بعد فاستدعِ أداتها الآن — الممنوع الوحيد تكرار نفس الاستدعاء بنفس المعاملات. وممنوع منعاً باتاً أن تقول إنك نفّذت شيئاً لم تصلك نتيجته. ضع الجواب النهائي الكامل للمستخدم في reply فقط واترك tool فارغاً."
        : "تذكير أخير: إن كانت الخطوة التالية تحتاج أداة من القائمة أعلاه فردّك الكامل يكون JSON استدعاء واحداً فقط؛ وإذا لم تحتاج أداة فضع الجواب النهائي في reply.";
      prompt =
        systemText +
        "\n\n# سجل المحادثة\n" +
        window.join("\n\n") +
        "\n\n" +
        buildToolsProtocol(tools) +
        "\n\n" +
        closing +
        "\n\nAssistant:";
    } else {
      prompt = formatPrompt(messages);
    }

    // Hard cap: Windows spawn arg limit ~32k chars. Agent-sized prompts
    // (big system + many tool schemas) exceed it -> spawn ENAMETOOLONG.
    // Compact: slim tool list + trimmed history, keep semantics.
    {
      // كان 14000 حين كان البرومبت يمرّ عبر سطر أوامر ويندوز (سقف 32,767).
      // بعد تمرير البرومبت عبر stdin زال ذلك السقف، فالتقليم هنا صار يقتطع
      // من تاريخ المحادثة بلا سبب. يُضبط عبر GEMINI_PROMPT_COMPACT_AT.
      const MAX_PROMPT_CHARS = Number(process.env.GEMINI_PROMPT_COMPACT_AT || 110000);
      if (prompt.length > MAX_PROMPT_CHARS && allowedTools) {
        const { systemText, lines } = renderConversation(messages, AGENT_DIRECTIVE);
        const slimTools = (tools || [])
          .map((t) => {
            const fn = t?.function || {};
            const req = Array.isArray(fn.parameters?.required) ? fn.parameters.required.join("|") : "";
            return `- ${fn.name}: ${String(fn.description || "").slice(0, 60)}${req ? ` [args: ${req}]` : ""}`;
          })
          .join("\n");
        const histCap = Math.min(HISTORY_MAX_TURNS, 60);
        const hist = lines.slice(-histCap).map((line) => String(line).slice(0, 1500));
        let histText = hist.join("\n\n");
        while (
          systemText.length + slimTools.length + histText.length > MAX_PROMPT_CHARS - 500 &&
          hist.length > 1
        ) {
          hist.shift();
          histText = hist.join("\n\n");
        }
        prompt =
          systemText +
          "\n\n# Conversation\n" +
          histText +
          "\n\n# Available tools (call at most ONE as JSON {\"tool\",\"arguments\"}; otherwise put final answer in \"reply\")\n" +
          slimTools +
          "\n\nAssistant:";
        console.log(`[DBG] prompt compacted to ${prompt.length} chars (was oversized)`);
      }
    }

    // حارس صلب ضد spawn ENAMETOOLONG.
    // البرومبت يُمرَّر إلى agy كوسيط سطر أوامر (--print=...)، وحد ويندوز
    // 32767 حرفاً لسطر الأوامر كاملاً. الهروب (\") في مخططات الأدوات ينفخ
    // الطول عند الإرسال، فبرومبت 27 ألف حرف قد يتجاوز الحد فعلياً.
    // الضاغط أعلاه لا يكفي: (أ) لا يعمل إلا مع allowedTools، و(ب) لا يقصّ
    // نص النظام الذي قد يتجاوز الميزانية وحده. هذا الحارس غير مشروط.
    {
      const HARD_CAP = Number(process.env.GEMINI_PROMPT_HARD_CAP || 20000);
      if (prompt.length > HARD_CAP) {
        const before = prompt.length;
        const headLen = Math.floor(HARD_CAP * 0.5);
        const tailLen = Math.floor(HARD_CAP * 0.45);
        prompt =
          prompt.slice(0, headLen) +
          "\n\n[... اختُصر وسط البرومبت لتجاوزه حد سطر أوامر ويندوز ...]\n\n" +
          prompt.slice(-tailLen);
        console.log(`[DBG] hard cap ${before} -> ${prompt.length} chars (limit ${HARD_CAP})`);
      }
    }

    // Prompt debugging: set GEMINI_DEBUG_PROMPT=1 to dump every outgoing
    // prompt to _workspace/last-prompt.txt for inspection.
    if (process.env.GEMINI_DEBUG_PROMPT === "1") {
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path.join(this.workspace, "last-prompt.txt"), prompt, "utf8");
      } catch { /* debug only */ }
    }

    const startedAt = Date.now();

    // In tool mode we buffer the whole reply: a streamed partial could leak
    // protocol JSON to the user before we know it is a tool call.
    const result = await this._client.prompt(prompt, {
      onChunk: stream && !allowedTools ? (chunk) => onChunk?.(chunk) : undefined,
    });

    const elapsedMs = Date.now() - startedAt;
    const tokens = {
      prompt: this._client.stats?.lastInputTokens || 0,
      completion: this._client.stats?.lastOutputTokens || 0,
      total:
        (this._client.stats?.lastInputTokens || 0) +
        (this._client.stats?.lastOutputTokens || 0),
    };

    if (allowedTools) {
      // Structured mode (--json-schema) wraps every reply as
      // {"reply": "...", "tool": "...", "arguments": {...}}. Unwrap it first;
      // fall back to scanning raw text for older/free-form replies.
      let replyText = result.reply || "";
      let structured = null;
      try {
        const parsed = JSON.parse(replyText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          structured = parsed;
          replyText = typeof parsed.reply === "string" ? parsed.reply : "";
        }
      } catch {
        /* plain text reply — keep as-is */
      }

      let call = parseToolCall(
        structured?.tool
          ? JSON.stringify({ tool: structured.tool, arguments: structured.arguments ?? {} })
          : replyText,
        allowedTools,
      );

      // Loop guard: some turns re-call a tool whose identical invocation is
      // already answered in the incoming history. One hard override retry,
      // then surface a diagnostic instead of looping forever.
      if (call && wasAlreadyExecuted(messages, call)) {
        console.warn(`[acp] duplicate tool call ${call.name} — forcing final answer`);
        const override =
          prompt +
          "\n\n[تنبيه النظام — ملزم: هذه الأداة نُفّذت مسبقاً ونتيجتها كاملة أمامك في «سجل المحادثة» أعلاه. يُمنع منعاً باتاً تكرار الاستدعاء. اكتب الآن الجواب النهائي للمستخدم داخل حقل reply فقط، مبنيّاً على تلك النتيجة.]";
        const second = await this._client.prompt(override);
        let secondText = second.reply || "";
        let secondStructured = null;
        try {
          const p2 = JSON.parse(secondText);
          if (p2 && typeof p2 === "object" && !Array.isArray(p2)) {
            secondStructured = p2;
            secondText = typeof p2.reply === "string" ? p2.reply : "";
          }
        } catch { /* plain text */ }
        const secondCall = parseToolCall(
          secondStructured?.tool
            ? JSON.stringify({ tool: secondStructured.tool, arguments: secondStructured.arguments ?? {} })
            : secondText,
          allowedTools,
        );
        if (!secondCall) {
          return {
            reply: secondText || "(انتهت الجلسة دون رد نصي)",
            toolCall: null,
            tokens,
            elapsedMs: Date.now() - startedAt,
            model: this._client.currentModelId,
          };
        }
        // Model insists even after the override — refuse the call loudly.
        return {
          reply: `[tool-loop] النموذج أعاد استدعاء ${call.name} رغم وجود النتيجة. أوقف الحلقة احتياطاً.`,
          toolCall: null,
          tokens,
          elapsedMs: Date.now() - startedAt,
          model: this._client.currentModelId,
        };
      }

      return {
        reply: call ? "" : replyText,
        toolCall: call,
        tokens,
        elapsedMs,
        model: this._client.currentModelId,
      };
    }

    return {
      reply: result.reply || "",
      tokens,
      elapsedMs,
      model: this._client.currentModelId,
    };
  }
}

/**
 * Format OpenAI messages + system into a single text prompt block. Gemini ACP
 * has its own session memory, but explicit history makes results predictable
 * whether the primary engine is Gemini or the Ollama backup.
 */
// History window: only the last N user/assistant turns reach Gemini. Older
// turns — and every non-conversational role — stay out of the prompt, so tool
// transcripts replayed from a shared harness session cannot leak into replies.
const HISTORY_MAX_TURNS = Number(process.env.GEMINI_HISTORY_MAX_TURNS || 20);

// Conversational posture. The ACP runner is a coding agent by default; this
// directive asks it to answer as a plain chat assistant. Override with
// GEMINI_CHAT_DIRECTIVE (empty string disables it entirely).
const CHAT_DIRECTIVE =
  process.env.GEMINI_CHAT_DIRECTIVE ??
  "أجب مباشرة كمحادثة عادية ودودة. لا تشغّل أدوات، لا تتفشّل ملفات أو مجلدات، ولا تسرد خطوات تقنية مثل (وش سوينا؟ هل ضبط؟). ردّك نص محادثة فقط بدون ترويسات.";

// Agent posture — used INSTEAD of CHAT_DIRECTIVE when the caller attached
// tools. Without this the chat directive's "don't use tools" wins and the
// model apologizes instead of calling.
const AGENT_DIRECTIVE =
  process.env.GEMINI_AGENT_DIRECTIVE ??
  "أنت العقل المنطقي خلف واجهة API، والنظام المضيف ينفّذ نيابةً عنك. لديك قدرات فعلية عبر قائمة الأدوات أدناه: قراءة ملفات، بحث، تعديل، تنفيذ أوامر. عندما يتطلب الطلب أي معلومة من الجهاز أو أي إجراء، استدعِ الأداة المناسبة فوراً بسطر JSON المطلوب دون اعتذار ودون شرح زائد. لا تتظاهر بنتائج ولا تطلب من المستخدم نسخ محتوى — استدعِ الأداة. بين الاستدعاءات اشرح خطتك بجملة موجزة.";

function formatPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  const lines = [];
  let systemText = CHAT_DIRECTIVE ? CHAT_DIRECTIVE + "\n" : "";
  for (const m of messages) {
    const role = String(m?.role || "user");
    if (role === "system") {
      systemText += (systemText ? "\n" : "") + String(m?.content || "");
      continue;
    }
    // Tool/function/developer transcripts are harness plumbing, not chat.
    if (role !== "user" && role !== "assistant") continue;
    const content =
      typeof m?.content === "string" ? m.content : extractText(m?.content);
    if (!content) continue;
    const tag = role === "assistant" ? "Assistant" : "User";
    lines.push(`${tag}: ${content}`);
  }
  // Keep only the last HISTORY_MAX_TURNS conversational lines.
  const window = lines.slice(-HISTORY_MAX_TURNS);
  if (!window.length) throw new Error("No text content in messages");
  const body = window.join("\n\n");
  const prefix = systemText ? `System:\n${systemText}\n\n` : "";
  return prefix + body + "\n\nAssistant:";
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text")
    .map((p) => String(p.text || ""))
    .join("\n")
    .trim();
}

/**
 * True when the incoming history already contains a tool RESULT whose call
 * matches name + arguments — i.e. the model is re-requesting satisfied work.
 */
function wasAlreadyExecuted(messages, call) {
  if (!Array.isArray(messages)) return false;
  const wanted = normalizeArgs(call.arguments);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "tool") continue;
    const prev = messages[i - 1];
    const tc = prev?.tool_calls?.find((t) =>
      t?.function?.name === call.name &&
      t?.id === m.tool_call_id
    );
    if (tc && normalizeArgs(tc.function?.arguments) === wanted) return true;
  }
  return false;
}

function normalizeArgs(args) {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args || "{}") : args ?? {};
    return JSON.stringify(parsed, Object.keys(parsed ?? {}).sort());
  } catch {
    return String(args ?? "");
  }
}
