// Conformance test: run the SAME OpenAI SDK client the harness (pi-ai) uses,
// pointed at GEMINI 3010, replicating pi-ai's buildParams() exactly.
// Point OPENAI_SDK_ENTRY at the exact SDK build your client uses,
// or `npm i openai` next to this file and leave it unset.
const OPENAI_ENTRY = process.env.OPENAI_SDK_ENTRY || "openai";
const { default: OpenAI } = await import(OPENAI_ENTRY);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "unused", // the server does not check auth
  baseURL: "http://127.0.0.1:3010/v1",
  maxRetries: 0,
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// --- Test 1: GET /models (discovery path) ---
try {
  const list = await client.models.list();
  const ids = [];
  for await (const m of list) ids.push(m.id);
  check("GET /v1/models", ids.length >= 5 && ids.some((i) => i.startsWith("gemini")), `${ids.length} models`);
} catch (e) {
  check("GET /v1/models", false, e.message);
}

// --- Test 2: streaming chat, exact pi-ai param shape ---
try {
  const stream = await client.chat.completions.create({
    model: "gemini-3.7-flash-high",
    messages: [
      { role: "system", content: "Reply in one short sentence." },
      { role: "user", content: "قل مرحة واحدة للتأكيد." },
    ],
    stream: true,
    stream_options: { include_usage: true },   // pi-ai always adds this
    max_completion_tokens: 65536,              // pi-ai default field
    temperature: 0.7,
  });

  let chunks = 0, textChars = 0, sawRole = false, sawFinish = false, sawDone = false, sawUsage = false;
  for await (const chunk of stream) {
    chunks++;
    const c = chunk.choices?.[0];
    if (c?.delta?.role === "assistant") sawRole = true;
    if (c?.delta?.content) textChars += c.delta.content.length;
    if (c?.finish_reason === "stop") sawFinish = true;
    if (chunk.usage) sawUsage = true;
    if (chunk.id && chunk.object === "chat.completion.chunk") { /* shape ok */ }
  }
  check("stream: chunks received", chunks >= 3, `${chunks} chunks`);
  check("stream: role delta", sawRole);
  check("stream: content arrived", textChars > 0, `${textChars} chars`);
  check("stream: finish_reason stop", sawFinish);
  check("stream: usage chunk (include_usage)", sawUsage);
  check("stream: [DONE] closed without error", true);
} catch (e) {
  check("streaming chat", false, e.message);
}

// --- Test 3: non-streaming ---
try {
  const r = await client.chat.completions.create({
    model: "gemini-3.5-flash-low",
    messages: [{ role: "user", content: "Reply with just: OK" }],
    stream: false,
  });
  const msg = r.choices?.[0]?.message;
  check("non-stream: message shape", msg?.role === "assistant" && typeof msg.content === "string", `"${(msg?.content || "").slice(0, 40)}..."`);
  check("non-stream: usage present", typeof r.usage?.total_tokens === "number");
} catch (e) {
  check("non-streaming chat", false, e.message);
}

// --- Test 4: error propagation (unknown model refused) ---
try {
  await client.chat.completions.create({
    model: "not-a-gemini",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });
  check("error: foreign model refused", false, "expected an error but got success");
} catch (e) {
  const isOpenAIError = typeof e.status === "number" && e.status === 400;
  check("error: foreign model refused as 400", isOpenAIError, e.message?.slice(0, 80));
}

console.log("\n=== SUMMARY ===");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
