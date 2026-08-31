// Tool bridge — prompt-based function calling over a text-only backend.
//
// OpenAI-compatible harnesses speak standard tool-calling. Our backend (Antigravity
// ACP) only returns text. This module closes the gap: it renders the harness's
// tool schemas into a strict text protocol, instructs the model to answer with
// exactly one JSON call when it wants a tool, and parses that JSON back out so
// the server can emit a genuine OpenAI `tool_calls` response. Execution itself
// never happens here — the harness runs the tool and posts the result back as
// a `role:"tool"` message.

/**
 * @param {Array} tools OpenAI tool definitions [{type:"function", function:{name, description, parameters}}]
 * @returns {string} protocol block appended to the system prompt
 */
export function buildToolsProtocol(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const rendered = tools
    .filter((t) => t?.type === "function" && t.function?.name)
    .map((t) => {
      const f = t.function;
      const params = f.parameters?.properties
        ? Object.entries(f.parameters.properties)
            .map(([pname, p]) => {
              const req = Array.isArray(f.parameters.required) && f.parameters.required.includes(pname);
              return `    - ${pname} (${p?.type || "any"}${req ? ", مطلوب" : ""}): ${p?.description || ""}`;
            })
            .join("\n")
        : "    (بدون معاملات)";
      return `  * ${f.name}: ${f.description || ""}\n${params}`;
    })
    .join("\n");

  return `
# أدوات متاحة لك — لديك قدرات تنفيذ حقيقية عبرها

الأدوات التالية يوفرها النظام المضيف وسيقوم هو بتنفيذها فعلياً وإعادة النتائج إليك.
بفضلها تستطيع قراءة الملفات وتنفيذ الأوامر وكل ما توفره القائمة — فلا تعتذر أبداً
بأنك «لا تملك وصولاً للملفات أو الجهاز»: هذا كلام غير صحيح ما دامت الأدوات معرفة أدناه.
${rendered}

## قاعدة الاستدعاء الإلزامية
إذا كانت الخطوة التالية منطقياً تتطلب أداة (قراءة ملف، تشغيل أمر، بحث...)، أجب فوراً بسطر
JSON واحد فقط وبلا أي نص آخر — دون اعتذار ودون إرشاد المستخدم كيف يفعلها بنفسه:
{"tool": "<اسم الأداة>", "arguments": {<المعاملات>}}

مثال — لو طلب المستخدم قراءة ملف وأداتك هي read:
{"tool": "read", "arguments": {"file_path": "C:/path/file.txt"}}

- استخدم الأسماء والمعاملات كما هي أعلاه حرفياً.
- لا تنفّذ الأداة بنفسك ولا تتظاهر بنتيجتها ولا تقترح أوامر طرفية على المستخدم —
  أعد طلب الاستدعاء فقط وانتظر النتيجة من النظام المضيف.
- **قاعدة إنهاء الحلقة**: إذا وصلتك «نتيجة الأداة» وتكفي للإجابة، ممنوع إعادة
  الاستدعاء — أجب نهائياً بالنص في حقل reply فقط واترك tool فارغاً.
- إذا لم تحتاج أداة، ضع ردّك كاملاً في reply بدون JSON استدعاء وبدون ذكر البروتوكول.`.trim();
}

/**
 * Extract an intended tool call from model text.
 * @param {string} text
 * @param {Map<string, {name:string}> | null} allowed map of valid tool names
 * @returns {{name:string, arguments:string, id:string} | null}
 */
export function parseToolCall(text, allowed) {
  if (!allowed || !text) return null;
  // Strip code fences, find the first balanced JSON object containing "tool".
  const cleaned = String(text).replace(/```(?:json)?/gi, "");
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = cleaned.slice(start, i + 1);
        start = -1;
        try {
          const obj = JSON.parse(candidate);
          if (obj && typeof obj.tool === "string" && allowed.has(obj.tool)) {
            return {
              name: obj.tool,
              arguments: JSON.stringify(obj.arguments ?? {}),
              id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            };
          }
        } catch {
          /* not valid JSON — keep scanning */
        }
      }
    }
  }
  return null;
}

const TOOL_RESULT_MAX_CHARS = Number(process.env.TOOL_RESULT_MAX_CHARS || 16_000);

/**
 * Render full OpenAI history — including tool calls/results — into the flat
 * text prompt our backend expects.
 * @returns {{systemText: string, lines: string[]}}
 */
export function renderConversation(messages, baseDirective) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  let systemText = baseDirective ? baseDirective + "\n" : "";
  const lines = [];

  for (const m of messages) {
    const role = String(m?.role || "user");
    if (role === "system") {
      systemText += (systemText.endsWith("\n") ? "" : "\n") + contentToText(m.content);
      continue;
    }
    if (role === "user") {
      const t = contentToText(m.content);
      if (t) lines.push(`User: ${t}`);
      continue;
    }
    if (role === "assistant") {
      const t = contentToText(m.content);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name || "unknown";
          const args = tc?.function?.arguments || "{}";
          lines.push(`Assistant: [استدعت الأداة ${name} بالمعاملات ${args}]`);
        }
        if (t) lines.push(`Assistant: ${t}`);
        continue;
      }
      if (t) lines.push(`Assistant: ${t}`);
      continue;
    }
    if (role === "tool") {
      let body = contentToText(m.content);
      if (body.length > TOOL_RESULT_MAX_CHARS) {
        body =
          body.slice(0, TOOL_RESULT_MAX_CHARS) +
          `\n... [تم اقتطاع ${(body.length - TOOL_RESULT_MAX_CHARS).toLocaleString("en")} حرفاً]`;
      }
      lines.push(`نتيجة الأداة (${m.name || m.tool_call_id || ""}): ${body}`);
      continue;
    }
    // Unknown roles are plumbing noise — skipped on purpose.
  }

  return { systemText: systemText.trim(), lines };
}

function contentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text")
      .map((p) => String(p.text || ""))
      .join("\n")
      .trim();
  }
  return "";
}
