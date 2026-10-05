import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
import { validateEndpoint, buildProviderRequest, generateReply } from "@/lib/server/provider";
import { defaultSettings } from "@/lib/types";

beforeEach(() => {
  vi.stubEnv("AI_ALLOWED_HOSTS", "api.openai.com,ai.megumi.ovh");
  mocks.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("explicitly allowed New API gateway", () => {
  it("accepts the exact gateway host with a public DNS address", async () => {
    expect(await validateEndpoint("https://ai.megumi.ovh/v1/")).toBe("https://ai.megumi.ovh/v1");
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("ai.megumi.ovh", { all: true });
  });
  it("validates full endpoints without stripping their custom path", async () => {
    expect(await validateEndpoint("https://ai.megumi.ovh/claude/v2/messages/", "anthropic", "endpoint"))
      .toBe("https://ai.megumi.ovh/claude/v2/messages/");
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith("ai.megumi.ovh", { all: true });
  });
  it("rejects protocol mismatches before DNS resolution or requests", async () => {
    await expect(validateEndpoint("https://ai.megumi.ovh/v1/messages", "openai-chat", "endpoint")).rejects.toMatchObject({ status: 400 });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("does not bypass the allowlist or private DNS checks in full endpoint mode", async () => {
    await expect(validateEndpoint("https://unapproved.example/relay/messages", "anthropic", "endpoint")).rejects.toMatchObject({ status: 400 });
    expect(mocks.lookup).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(validateEndpoint("https://ai.megumi.ovh/relay/messages", "anthropic", "endpoint")).rejects.toThrow("私有网络");
  });
  it("does not allow suffix lookalikes or unapproved subdomains", async () => {
    for (const host of ["ai.megumi.ovh.evil.example", "other.megumi.ovh"]) {
      await expect(validateEndpoint("https://" + host + "/v1")).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("still blocks private or mixed public/private DNS responses", async () => {
    for (const addresses of [
      [{ address: "172.19.1.148", family: 4 }],
      [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]
    ]) {
      mocks.lookup.mockResolvedValue(addresses);
      await expect(validateEndpoint("https://ai.megumi.ovh/v1")).rejects.toThrow("私有网络");
    }
  });
  it.each([
    ["openai-chat", "/chat/completions"], ["openai-responses", "/responses"], ["anthropic", "/messages"]
  ] as const)("preserves %s routing on a custom gateway", (protocol, suffix) => {
    const request = buildProviderRequest({ ...defaultSettings, api_base_url: "https://ai.megumi.ovh/v1",
      protocol, model: "gateway-model-id", api_key: "test-only-key" }, [{ role: "user", content: "测试" }]);
    expect(request.url).toBe("https://ai.megumi.ovh/v1" + suffix);
    expect(request.body.model).toBe("gateway-model-id");
  });
  it("sends an explicit endpoint unchanged and keeps upstream 401 details private", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("secret-upstream-body", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...defaultSettings, protocol: "anthropic" as const, anthropic_auth: "bearer" as const,
      api_base_url: "https://ai.megumi.ovh/relay/claude/", api_url_mode: "endpoint" as const, api_key: "test-only-key" };
    const reply = generateReply(config, [{ role: "user", content: "test" }], new AbortController().signal);
    await expect(reply.next()).rejects.toMatchObject({ message: "AI 服务认证失败（HTTP 401），请联系管理员检查该模型的 API 地址、认证方式及密钥。" });
    expect(fetchMock).toHaveBeenCalledWith(config.api_base_url, expect.objectContaining({
      redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer test-only-key" })
    }));
  });
});
