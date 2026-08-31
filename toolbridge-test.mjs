// Tool-bridge conformance test — simulates the harness's exact loop:
// 1. send messages + tools -> expect finish_reason "tool_calls"
// 2. append assistant tool_call + role:"tool" result -> expect final text
// Point OPENAI_SDK_ENTRY at the exact SDK build your client uses,
// or `npm i openai` next to this file and leave it unset.
const OPENAI_ENTRY = process.env.OPENAI_SDK_ENTRY || "openai";
const { default: OpenAIClient } = await import(OPENAI_ENTRY);
const client = new OpenAIClient({
  apiKey: process.env.OPENAI_API_KEY || "unused",
  baseURL: "http://127.0.0.1:3010/v1",
  maxRetries: 0,
});

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "يعيد حالة الطقس لمدينة معينة",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "اسم المدينة" } },
        required: ["city"],
      },
    },
  },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

console.log("=== STEP 1: ask question WITH tools ===");
let first;
try {
  first = await client.chat.completions.create({
    model: "gemini-3.5-flash-low",
    stream: true, // harness always streams; server buffers in tool mode
    messages: [{ role: "user", content: "وش الطقس في الرياض الحين؟" }],
    tools,
    tool_choice: "auto",
  });

  let contentText = "";
  let toolName = null, toolArgs = null, finishReason = null;
  for await (const chunk of first) {
    const c = chunk.choices?.[0];
    if (!c) continue;
    if (c.delta?.content) contentText += c.delta.content;
    const tc = c.delta?.tool_calls?.[0];
    if (tc?.function?.name) toolName = tc.function.name;
    if (tc?.function?.arguments) toolArgs = tc.function.arguments;
    if (c.finish_reason) finishReason = c.finish_reason;
  }
  check("step1: finish_reason=tool_calls", finishReason === "tool_calls", `got ${finishReason}`);
  check("step1: no stray content leaked", contentText.length === 0 || !contentText.includes('"tool"'), `${contentText.length} chars`);
  check("step1: tool name parsed", toolName === "get_weather", `got ${toolName}`);
  let argsOk = false, city = "";
  if (toolArgs) { try { const a = JSON.parse(toolArgs); city = a.city; argsOk = typeof a.city === "string"; } catch {} }
  check("step1: arguments JSON valid with city", argsOk, `city=${city}`);

  console.log("\n=== STEP 2: feed tool result back ===");
  const second = await client.chat.completions.create({
    model: "gemini-3.5-flash-low",
    stream: true,
    messages: [
      { role: "user", content: "وش الطقس في الرياض الحين؟" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_test1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city }) } }] },
      { role: "tool", tool_call_id: "call_test1", name: "get_weather", content: '{"temp_c": 34, "condition": "مشمس"}' },
    ],
    tools,
  });
  let finalText = "", sawToolCallAgain = false, finalFinish = null;
  for await (const chunk of second) {
    const c = chunk.choices?.[0];
    if (!c) continue;
    if (c.delta?.content) finalText += c.delta.content;
    if (c.delta?.tool_calls) sawToolCallAgain = true;
    if (c.finish_reason) finalFinish = c.finish_reason;
  }
  check("step2: final answer is text", finalText.trim().length > 3 && !finalText.includes('"tool"'), `"${finalText.slice(0, 60)}..."`);
  check("step2: no spurious tool call", !sawToolCallAgain);
  check("step2: finish_reason=stop", finalFinish === "stop", `got ${finalFinish}`);

  console.log("\n=== STEP 3: plain chat WITHOUT tools still works ===");
  const third = await client.chat.completions.create({
    model: "gemini-3.5-flash-low",
    stream: true,
    messages: [{ role: "user", content: "قل مرحبا بكلمة واحدة." }],
  });
  let plain = "";
  for await (const chunk of third) {
    const c = chunk.choices?.[0];
    if (c?.delta?.content) plain += c.delta.content;
  }
  check("step3: plain streaming intact", plain.trim().length > 0, `"${plain.slice(0, 40)}"`);
} catch (e) {
  check("tool loop", false, e.message);
}

console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
