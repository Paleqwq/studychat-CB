import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/server/crypto";
import { runtimeMode } from "@/lib/server/env";
import { assertSameOrigin, assertStudyCode, readJson } from "@/lib/server/http";

afterEach(() => vi.unstubAllEnvs());
describe("credential and runtime safety", () => {
  it("encrypts with randomized authenticated encryption and detects tampering", () => {
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
    const one = encryptSecret("secret-test-key");
    expect(one).not.toContain("secret-test-key");
    expect(one).not.toBe(encryptSecret("secret-test-key"));
    expect(decryptSecret(one)).toBe("secret-test-key");
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
    expect(() => decryptSecret(one)).toThrow();
  });
  it("rejects a misconfigured encryption key", () => {
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", "short");
    expect(() => encryptSecret("key")).toThrow("32 字节");
  });
  it("cannot activate demo mode in production or Vercel", () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(runtimeMode()).not.toBe("demo");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    expect(runtimeMode()).not.toBe("demo");
    vi.stubEnv("VERCEL", "");
    expect(runtimeMode()).toBe("demo");
  });
  it("rejects cross-origin requests and incorrect study codes", () => {
    expect(() => assertSameOrigin(new Request("https://study.example/api/chat", { headers: { Origin: "https://evil.example" } }))).toThrow();
    expect(() => assertSameOrigin(new Request("https://study.example/api/chat", { headers: { Origin: "https://study.example" } }))).not.toThrow();
    vi.stubEnv("STUDY_ACCESS_CODE", "study-123");
    expect(() => assertStudyCode(new Request("https://study.example"))).toThrow();
    expect(() => assertStudyCode(new Request("https://study.example", { headers: { "X-Study-Code": "study-123" } }))).not.toThrow();
  });
  it("limits request bodies before parsing", async () => {
    const request = new Request("https://study.example", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "too large" }) });
    await expect(readJson(request, 4)).rejects.toThrow("过长");
  });
});
