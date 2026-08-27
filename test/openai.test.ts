import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../src/llm/openai.ts";
import type { ChatMessage, ToolFunctionSpec } from "../src/llm/provider.ts";

function fakeFetch(
  status: number,
  payload: unknown,
  capture?: (body: Record<string, unknown>) => void,
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (capture && init?.body) capture(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const provider = (fetchFn: typeof fetch) =>
  new OpenAIProvider({
    baseUrl: "https://example.test/v1/",
    apiKey: "sk-test",
    model: "gpt-mini",
    fetchFn,
  });

test("parses a tool call, turning JSON-string arguments into an object", async () => {
  const p = provider(
    fakeFetch(200, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"a.md","content":"hi"}' },
              },
            ],
          },
        },
      ],
    }),
  );

  const reply = await p.chat([{ role: "user", content: "make a file" }]);
  assert.equal(reply.tool_calls?.length, 1);
  assert.equal(reply.tool_calls?.[0].function.name, "write_file");
  assert.deepEqual(reply.tool_calls?.[0].function.arguments, { path: "a.md", content: "hi" });
});

test("translates history: object args -> string, tool result carries tool_call_id", async () => {
  let sent: Record<string, unknown> = {};
  const p = provider(
    fakeFetch(200, { choices: [{ message: { role: "assistant", content: "done" } }] }, (b) => {
      sent = b;
    }),
  );

  const history: ChatMessage[] = [
    { role: "system", content: "be brief" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", function: { name: "list_files", arguments: { dir: "." } } }],
    },
    { role: "tool", tool_name: "list_files", tool_call_id: "call_1", content: "a\nb" },
  ];
  const tools: ToolFunctionSpec[] = [
    { type: "function", function: { name: "list_files", description: "", parameters: {} } },
  ];

  await p.chat(history, tools);

  const msgs = sent.messages as Array<Record<string, any>>;
  const assistant = msgs[2];
  assert.equal(typeof assistant.tool_calls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { dir: "." });
  const toolMsg = msgs[3];
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "call_1");
  assert.equal(sent.tool_choice, "auto");
});

test("omits tools/tool_choice when no tools are given", async () => {
  let sent: Record<string, unknown> = {};
  const p = provider(
    fakeFetch(200, { choices: [{ message: { role: "assistant", content: "hi" } }] }, (b) => {
      sent = b;
    }),
  );
  await p.chat([{ role: "user", content: "hi" }]);
  assert.equal("tools" in sent, false);
  assert.equal("tool_choice" in sent, false);
});

test("a non-2xx response throws with the status", async () => {
  const p = provider(fakeFetch(429, { error: "rate limited" }));
  await assert.rejects(() => p.chat([{ role: "user", content: "x" }]), /openai 429/);
});

test("label reflects the model", () => {
  assert.equal(provider(fakeFetch(200, {})).label, "openai:gpt-mini");
});
