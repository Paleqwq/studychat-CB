import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { authUnavailableMessage, invalidSessionMessage } from "@/lib/auth-errors";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), signInAnonymously: vi.fn(), signOut: vi.fn(), fetch: vi.fn()
}));
vi.mock("@supabase/supabase-js", async importOriginal => ({
  ...await importOriginal<typeof import("@supabase/supabase-js")>(),
  createClient: () => ({ auth: {
    getSession: mocks.getSession, signInAnonymously: mocks.signInAnonymously, signOut: mocks.signOut
  } })
}));
import { accessToken, authFetch, responseJson } from "@/lib/browser";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  vi.stubGlobal("fetch", mocks.fetch);
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("browser auth during connection failures", () => {
  it.each(["admin", "participant"] as const)("does not replace the %s identity when session refresh cannot connect", async kind => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError("private-upstream-error", 0) });
    await expect(accessToken(kind)).rejects.toThrow(authUnavailableMessage);
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not silently register a new identity for an invalid existing participant session", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: new AuthSessionMissingError() });
    await expect(accessToken("participant")).rejects.toThrow(invalidSessionMessage);
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
  it("does not create anonymous accounts to access the admin console", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(accessToken("admin")).rejects.toThrow("请先登录管理员账号");
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
  it("allows a new participant session when there is genuinely no previous session error", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.signInAnonymously.mockResolvedValue({ data: { session: { access_token: "new-participant" } }, error: null });
    expect(await accessToken("participant")).toBe("new-participant");
    expect(mocks.signInAnonymously).toHaveBeenCalledOnce();
  });
  it("preserves the admin session after a 503 and reuses it on an explicit retry", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "existing-session" } }, error: null });
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: authUnavailableMessage }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ revision: 1 }));
    await expect(responseJson(await authFetch("/api/admin/settings", "admin"))).rejects.toThrow(authUnavailableMessage);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(await responseJson(await authFetch("/api/admin/settings", "admin"))).toEqual({ revision: 1 });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mocks.fetch.mock.calls) expect(init.headers.get("Authorization")).toBe("Bearer existing-session");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
  it("never automatically repeats a write after an auth service failure", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "existing-session" } }, error: null });
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: authUnavailableMessage }, { status: 503 }));
    const response = await authFetch("/api/admin/settings", "admin", { method: "PUT", body: JSON.stringify({ revision: 1 }) });
    expect(response.status).toBe(503);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
