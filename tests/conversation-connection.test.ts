import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/lib/types";
import { defaultExperiment, type ModelFactor } from "@/lib/experiment";
import { applyConnectionSettings, describeConversationConnection, transportSettings } from "@/lib/conversation-connection";
const mocks = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("@/lib/server/settings", () => ({ currentExperiment: mocks.current }));
import { currentConversationConnection } from "@/lib/server/conversation-connection";
import { buildProviderRequest } from "@/lib/server/provider";

const original = { ...defaultSettings, model: "frozen-model", system_prompt: "frozen-prompt",
  temperature: 0.4, max_tokens: 1024, api_base_url: "https://old.example/custom/", api_url_mode: "endpoint" as const };
function publication() {
  const settings = defaultExperiment();
  settings.connections.chatgpt = { ...settings.connections.chatgpt, protocol: "openai-responses", api_url_mode: "endpoint",
    api_base_url: "https://new.example/relay/responses/", model: "different-new-model", max_tokens: 4096, temperature: 1 };
  settings.connections.deepseek = { ...settings.connections.deepseek, protocol: "anthropic", anthropic_auth: "bearer",
    anthropic_workspace: "workspace", api_base_url: "https://deepseek.example/anthropic/v1", api_url_mode: "base" };
  return { id: "new-experiment", revision: 7, created_at: "2026-10-02T09:00:00Z", settings,
    encrypted_keys: { deepseek: "private-deepseek-ciphertext", chatgpt: "private-chatgpt-ciphertext" } };
}
beforeEach(() => { mocks.current.mockReset().mockResolvedValue({ config: publication(), enabled: true }); });

describe("connection-only overlays", () => {
  it("updates only transport fields and preserves all experimental and presentation settings", () => {
    const connection = publication().settings.connections.chatgpt;
    const oldCopy = structuredClone(original), connectionCopy = structuredClone(connection);
    const actual = applyConnectionSettings(original, connection);
    expect(actual).toEqual({ ...original, ...transportSettings(connection) });
    expect(actual).toMatchObject({ model: "frozen-model", system_prompt: "frozen-prompt", temperature: 0.4, max_tokens: 1024,
      title: original.title, disclosure: original.disclosure, welcome_message: original.welcome_message });
    expect(original).toEqual(oldCopy); expect(connection).toEqual(connectionCopy);
  });
  it("does not inherit a stale endpoint mode when the new publication uses the legacy base default", () => {
    const connection = { ...defaultExperiment().connections.chatgpt, api_base_url: "https://new.example/v1" };
    const actual = applyConnectionSettings(original, connection);
    expect(actual.api_url_mode).toBe("base");
    expect(describeConversationConnection(original, "chatgpt", { ...publication(), settings: {
      ...publication().settings, connections: { ...publication().settings.connections, chatgpt: connection }
    } }).endpoint).toBe("https://new.example/v1/chat/completions");
  });
  it("updates authentication/workspace and wire parameter names without changing the output budget", () => {
    const connection = { ...publication().settings.connections.deepseek, token_parameter: "max_completion_tokens" as const };
    expect(applyConnectionSettings(original, connection)).toMatchObject({ protocol: "anthropic", anthropic_auth: "bearer",
      anthropic_workspace: "workspace", token_parameter: "max_completion_tokens", max_tokens: 1024, model: "frozen-model" });
  });
  it("selects fields explicitly instead of allowing unexpected fields to overwrite frozen settings or leak keys", () => {
    const untrusted = { ...publication().settings.connections.chatgpt, system_prompt: "replace-prompt", api_key: "private-key",
      api_key_ciphertext: "private-ciphertext", group_code: "other-group" };
    const actual = applyConnectionSettings(original, untrusted);
    expect(actual.system_prompt).toBe("frozen-prompt");
    expect(JSON.stringify(actual)).not.toMatch(/private-|other-group|replace-prompt/);
    expect(Object.keys(transportSettings(untrusted)).sort()).toEqual([
      "anthropic_auth", "anthropic_workspace", "api_base_url", "api_url_mode", "protocol", "token_parameter"
    ]);
  });
  it("describes only the current connection and preserves an explicit endpoint including its trailing slash", () => {
    const info = describeConversationConnection(original, "chatgpt", publication());
    expect(info).toMatchObject({ source: "latest", experiment_revision: 7,
      endpoint: "https://new.example/relay/responses/", published_at: "2026-10-02T09:00:00Z" });
    expect(JSON.stringify(info)).not.toMatch(/ciphertext|encrypted_keys|different-new-model|frozen-prompt/);
  });
  it("retains an ungrouped original connection without guessing a model", () => {
    expect(describeConversationConnection(original, null, publication())).toMatchObject({ source: "original",
      experiment_revision: null, endpoint: "https://old.example/custom/" });
  });
  it.each(["openai-chat", "openai-responses", "anthropic"] as const)("keeps the original model, prompt and budget on a rotated %s transport", protocol => {
    const connection = { ...publication().settings.connections.deepseek, protocol, api_base_url: "https://rotated.example/v1",
      api_url_mode: "base" as const, token_parameter: "max_completion_tokens" as const };
    const effective = applyConnectionSettings(original, connection);
    const request = buildProviderRequest({ ...effective, api_key: "test-only-new-key" }, [{ role: "user", content: "test" }]);
    expect(request.body.model).toBe("frozen-model");
    expect(request.headers.Authorization).toBe("Bearer test-only-new-key");
    const budgetName = protocol === "openai-responses" ? "max_output_tokens" : protocol === "anthropic" ? "max_tokens" : "max_completion_tokens";
    expect(request.body[budgetName]).toBe(1024);
    expect(request.body.temperature).toBe(0.4);
    if (protocol === "openai-responses") {
      expect(request.url).toBe("https://rotated.example/v1/responses"); expect(request.body.instructions).toBe("frozen-prompt");
    } else if (protocol === "anthropic") expect(request.body.system).toBe("frozen-prompt");
    else expect(request.body.messages).toEqual([{ role: "system", content: "frozen-prompt" }, { role: "user", content: "test" }]);
  });
});

describe("server selection of published credentials", () => {
  it.each(["deepseek", "chatgpt"] as ModelFactor[])("uses only the %s factor key and transport", async factor => {
    const result = await currentConversationConnection(original, factor);
    expect(result.api_key_ciphertext).toBe(publication().encrypted_keys[factor]);
    expect(result.settings.api_base_url).toBe(publication().settings.connections[factor].api_base_url);
    expect(result.settings.model).toBe("frozen-model");
    expect(result.info.source).toBe("latest");
    expect(mocks.current).toHaveBeenCalledTimes(1);
  });
  it("does not cache a publication across requests or mutate an already selected configuration", async () => {
    const first = await currentConversationConnection(original, "chatgpt");
    const next = publication(); next.revision = 8; next.encrypted_keys.chatgpt = "rotated-ciphertext";
    next.settings.connections.chatgpt.api_base_url = "https://rotated.example/responses";
    mocks.current.mockResolvedValue({ config: next, enabled: true });
    const second = await currentConversationConnection(original, "chatgpt");
    expect(first.info.experiment_revision).toBe(7);
    expect(first.api_key_ciphertext).toBe("private-chatgpt-ciphertext");
    expect(second.info.experiment_revision).toBe(8);
    expect(second.api_key_ciphertext).toBe("rotated-ciphertext");
    expect(mocks.current).toHaveBeenCalledTimes(2);
  });
  it("never reads or borrows the latest credentials for an ungrouped historical conversation", async () => {
    const result = await currentConversationConnection(original, null);
    expect(result.settings).toEqual(original);
    expect(result.info.source).toBe("original");
    expect(result.api_key_ciphertext).toBeNull(); expect(mocks.current).not.toHaveBeenCalled();
  });
  it("reports an unavailable publication or missing factor key without substituting the other key", async () => {
    mocks.current.mockResolvedValue({ config: null, enabled: false });
    expect((await currentConversationConnection(original, "chatgpt")).info.source).toBe("unavailable");
    const broken = publication(); broken.encrypted_keys.chatgpt = "";
    mocks.current.mockResolvedValue({ config: broken, enabled: true });
    const result = await currentConversationConnection(original, "chatgpt");
    expect(result.info.source).toBe("unavailable"); expect(result.api_key_ciphertext).toBeNull();
  });
  it("rejects an invalid factor and propagates database outages without falling back", async () => {
    await expect(currentConversationConnection(original, "other" as ModelFactor)).rejects.toMatchObject({ status: 503 });
    expect(mocks.current).not.toHaveBeenCalled();
    mocks.current.mockRejectedValue(new Error("database outage"));
    await expect(currentConversationConnection(original, "chatgpt")).rejects.toThrow("database outage");
  });
});
