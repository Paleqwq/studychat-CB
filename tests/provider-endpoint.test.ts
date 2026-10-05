import { describe, expect, it } from "vitest";
import { normalizeProviderAddress, resolveProviderEndpoint, type ApiUrlMode, type ProviderProtocol } from "@/lib/provider-endpoint";
import { defaultSettings } from "@/lib/types";
import { defaultExperiment, effectiveSettings, groups } from "@/lib/experiment";
import { experimentSchema } from "@/lib/validation";
import { buildProviderRequest } from "@/lib/server/provider";

describe("protocol-specific API addresses", () => {
  it.each([
    ["openai-chat", "https://api.openai.com", "https://api.openai.com/v1/chat/completions"],
    ["openai-responses", "https://api.openai.com/", "https://api.openai.com/v1/responses"],
    ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["anthropic", "https://api.anthropic.com/v1/messages/", "https://api.anthropic.com/v1/messages"],
    ["openai-chat", "https://api.deepseek.com", "https://api.deepseek.com/chat/completions"],
    ["anthropic", "https://api.deepseek.com", "https://api.deepseek.com/anthropic/v1/messages"],
    ["anthropic", "https://api.deepseek.com/v1", "https://api.deepseek.com/anthropic/v1/messages"],
    ["anthropic", "https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1/messages"],
    ["anthropic", "https://api.deepseek.com/anthropic/v1/messages", "https://api.deepseek.com/anthropic/v1/messages"],
    ["openai-chat", "https://gateway.example", "https://gateway.example/chat/completions"],
    ["openai-responses", "https://gateway.example/openai/v3", "https://gateway.example/openai/v3/responses"],
    ["anthropic", "https://gateway.example/claude/v2", "https://gateway.example/claude/v2/messages"]
  ] as const)("resolves %s at %s without guessing custom prefixes", (protocol, api_base_url, expected) => {
    expect(resolveProviderEndpoint({ protocol, api_base_url })).toBe(expected);
  });

  it.each(["openai-chat", "openai-responses", "anthropic"] as const)("preserves exact custom endpoints for %s", protocol => {
    for (const api_base_url of ["https://gateway.example/relay/generate", "https://gateway.example/relay/generate/"]) {
      const config = { protocol, api_base_url, api_url_mode: "endpoint" as const };
      expect(normalizeProviderAddress(config)).toBe(api_base_url);
      expect(resolveProviderEndpoint(config)).toBe(api_base_url);
      expect(buildProviderRequest({ ...defaultSettings, ...config, api_key: "test-only" }, []).url).toBe(api_base_url);
    }
  });

  it("does not add official prefixes in explicit endpoint mode", () => {
    expect(resolveProviderEndpoint({ protocol: "anthropic", api_base_url: "https://api.deepseek.com/anthropic/messages/", api_url_mode: "endpoint" }))
      .toBe("https://api.deepseek.com/anthropic/messages/");
  });

  it.each(["base", "endpoint"] as const)("rejects mismatched known endpoint suffixes in %s mode", api_url_mode => {
    for (const [protocol, path] of [
      ["openai-chat", "/messages"], ["openai-chat", "/responses"],
      ["openai-responses", "/chat/completions"], ["openai-responses", "/messages"],
      ["anthropic", "/chat/completions"], ["anthropic", "/responses"]
    ] as const) {
      expect(() => resolveProviderEndpoint({ protocol, api_url_mode, api_base_url: "https://gateway.example/v1" + path + "/" })).toThrow("协议不匹配");
    }
  });

  it.each(["base", "endpoint"] as const)("retains HTTPS and credential restrictions in %s mode", api_url_mode => {
    for (const api_base_url of ["http://gateway.example/v1", "https://secret@gateway.example/v1", "https://gateway.example/v1?key=secret",
      "https://gateway.example/v1#secret", "https://gateway.example:8080/v1", "not a URL"]) {
      expect(() => resolveProviderEndpoint({ protocol: "anthropic", api_url_mode, api_base_url })).toThrow();
    }
  });

  it("keeps each model's protocol, exact URL, request body and credentials independent", () => {
    const config = defaultExperiment();
    config.connections.deepseek = { ...config.connections.deepseek, model: "deepseek-test", protocol: "openai-chat",
      api_base_url: "https://deepseek-gateway.example/compat/v1", api_url_mode: "base" };
    config.connections.chatgpt = { ...config.connections.chatgpt, model: "chatgpt-test", protocol: "anthropic", anthropic_auth: "bearer",
      api_base_url: "https://chatgpt-gateway.example/proxy/messages", api_url_mode: "endpoint" };
    for (const group of groups) {
      const request = buildProviderRequest({ ...effectiveSettings(config, group), api_key: group.model + "-test-key" }, []);
      expect(request.body.model).toBe(group.model + "-test");
      expect(request.headers.Authorization).toBe("Bearer " + group.model + "-test-key");
      expect(request.url).toBe(group.model === "deepseek"
        ? "https://deepseek-gateway.example/compat/v1/chat/completions" : "https://chatgpt-gateway.example/proxy/messages");
      expect(request.body).toHaveProperty(group.model === "deepseek" ? "messages" : "system");
    }
  });

  it("validates independent address modes and preserves backwards-compatible settings", () => {
    const config = defaultExperiment();
    config.connections.deepseek.model = "deepseek-test";
    config.connections.chatgpt.model = "chatgpt-test";
    const input = { ...config, personality_prompt: "test", enabled: true, expected_revision: 0, api_keys: { deepseek: "", chatgpt: "" } };
    expect(experimentSchema.safeParse(input).success).toBe(true);
    input.connections.chatgpt.api_url_mode = "endpoint";
    input.connections.chatgpt.api_base_url = "https://gateway.example/responses";
    input.connections.chatgpt.protocol = "openai-responses";
    expect(experimentSchema.parse(input).connections.chatgpt.api_url_mode).toBe("endpoint");
    input.connections.chatgpt.protocol = "anthropic";
    const mismatch = experimentSchema.safeParse(input);
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) expect(mismatch.error.issues[0].path).toEqual(["connections", "chatgpt", "api_base_url"]);
    expect(experimentSchema.safeParse({ ...input, connections: { ...input.connections, chatgpt: {
      ...input.connections.chatgpt, api_url_mode: "unsafe" as ApiUrlMode, protocol: "unsupported" as ProviderProtocol
    } } }).success).toBe(false);
  });
});
