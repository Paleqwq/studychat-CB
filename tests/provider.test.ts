import { describe, it, expect } from "vitest";
import { buildProviderRequest, decodeProviderStream, publicAddress, trimHistory } from "@/lib/server/provider";
import { defaultSettings, publicSettings } from "@/lib/types";
import { normalizeBaseUrl, isAllowedHostname, settingsSchema } from "@/lib/validation";
import { parseSse } from "@/lib/sse";

const messages = [{ role: "user" as const, content: "你好" }];
const config = { ...defaultSettings, model: "configured-model", api_key: "test-key" };
function stream(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    }
  });
}
async function collect<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
const event = (data: unknown) => "data: " + JSON.stringify(data) + "\r\n\r\n";

describe("three distinct provider protocols", () => {
  it("uses Chat Completions with server-owned system message", () => {
    const request = buildProviderRequest(config, messages);
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(request.body.messages).toEqual([{ role: "system", content: defaultSettings.system_prompt }, ...messages]);
    expect(request.body.max_tokens).toBe(2048);
    expect(request.body).not.toHaveProperty("temperature");
  });
  it("uses native Responses fields and disables remote response storage", () => {
    const request = buildProviderRequest({ ...config, protocol: "openai-responses" }, messages);
    expect(request.url.endsWith("/responses")).toBe(true);
    expect(request.body.input).toEqual(messages);
    expect(request.body.instructions).toBe(defaultSettings.system_prompt);
    expect(request.body.store).toBe(false);
    expect(request.body.max_output_tokens).toBe(2048);
    expect(request.body).not.toHaveProperty("messages");
  });
  it("uses native Anthropic headers, system and max_tokens", () => {
    const request = buildProviderRequest({ ...config, protocol: "anthropic", api_base_url: "https://api.anthropic.com/v1", anthropic_workspace: "wrkspc_example" }, messages);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("test-key");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers["anthropic-workspace-id"]).toBe("wrkspc_example");
    expect(request.headers).not.toHaveProperty("Authorization");
    expect(request.body.system).toBe(defaultSettings.system_prompt);
    expect(request.body.messages).toEqual(messages);
  });
  it("supports Anthropic bearer gateways without duplicating authentication", () => {
    const request = buildProviderRequest({ ...config, protocol: "anthropic", anthropic_auth: "bearer" }, messages);
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(request.headers).not.toHaveProperty("x-api-key");
  });
  it("parses split UTF-8, CRLF, comments and multiline SSE", async () => {
    expect(await collect(parseSse(stream(": ping\r\ndata: 你好\r\ndata: 世界\r\n\r\n", 1)))).toEqual(["你好\n世界"]);
  });
  it("decodes Chat Completions", async () => {
    const wire = event({ choices: [{ delta: { content: "你好" } }] }) +
      event({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
    expect((await collect(decodeProviderStream("openai-chat", stream(wire)))).join("")).toBe("你好");
  });
  it("decodes Responses", async () => {
    const wire = event({ type: "response.output_text.delta", delta: "你好" }) + event({ type: "response.completed" });
    expect((await collect(decodeProviderStream("openai-responses", stream(wire)))).join("")).toBe("你好");
  });
  it("decodes Anthropic while ignoring thinking and ping events", async () => {
    const wire = event({ type: "ping" }) + event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } }) +
      event({ type: "content_block_delta", delta: { type: "text_delta", text: "你好" } }) +
      event({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + event({ type: "message_stop" });
    expect((await collect(decodeProviderStream("anthropic", stream(wire)))).join("")).toBe("你好");
  });
  it("does not report a dropped stream as completed", async () => {
    await expect(collect(decodeProviderStream("openai-chat", stream(event({ choices: [{ delta: { content: "partial" } }] }))))).rejects.toThrow("连接中断");
  });
  it("rejects error events and incomplete/truncated replies", async () => {
    await expect(collect(decodeProviderStream("anthropic", stream(event({ type: "error", error: { message: "SECRET" } }))))).rejects.not.toThrow("SECRET");
    await expect(collect(decodeProviderStream("openai-responses", stream(event({ type: "response.incomplete" }))))).rejects.toThrow("截断");
    await expect(collect(decodeProviderStream("anthropic", stream(event({ type: "message_delta", delta: { stop_reason: "max_tokens" } }))))).rejects.toThrow("未完整");
  });
  it("limits context without starting with an orphan assistant", () => {
    expect(trimHistory([{ role: "user", content: "123" }, { role: "assistant", content: "456" }, { role: "user", content: "last" }], 7)).toEqual([{ role: "user", content: "last" }]);
  });
});
describe("settings and endpoint boundary", () => {
  it("normalizes pasted full endpoints for all protocols", () => {
    for (const endpoint of ["messages", "responses", "chat/completions"]) {
      expect(normalizeBaseUrl("https://api.example.com/v1/" + endpoint + "/")).toBe("https://api.example.com/v1");
    }
  });
  it("rejects HTTP, credentials, query strings and unusual ports", () => {
    for (const url of ["http://localhost/v1", "https://key@api.example.com", "https://api.example.com?key=bad", "https://api.example.com:8080"]) expect(() => normalizeBaseUrl(url)).toThrow();
  });
  it("requires exact hosts, not prefix or suffix matches", () => {
    expect(isAllowedHostname("api.example.com.evil.test", "api.example.com")).toBe(false);
    expect(isAllowedHostname("api.example.com", "api.example.com")).toBe(true);
  });
  it("blocks private IP families and mapped IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.18.1.1", "100.64.1.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1"]) expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("never returns prompts, API information or models in participant settings", () => {
    expect(Object.keys(publicSettings(config)).sort()).toEqual(["assistant_name", "disclosure", "title", "welcome_message"]);
  });
  it("rejects unknown fields and invalid settings", () => {
    const data = { ...defaultSettings, model: "test", enabled: true, expected_revision: 0 };
    expect(settingsSchema.safeParse(data).success).toBe(true);
    expect(settingsSchema.safeParse({ ...data, api_key_ciphertext: "injected" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...data, model: "" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...data, temperature: 3 }).success).toBe(false);
  });
});
