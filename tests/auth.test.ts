import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from "@supabase/supabase-js";
import { authUnavailableMessage, invalidSessionMessage } from "@/lib/auth-errors";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), membership: vi.fn(), from: vi.fn()
}));
vi.mock("@/lib/server/db", () => ({
  db: () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from
  })
}));
import { requireUser, requireAdmin, errorResponse } from "@/lib/server/http";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public");
  vi.stubEnv("SUPABASE_SECRET_KEY", "secret");
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "server-key");
  mocks.getUser.mockReset();
  mocks.membership.mockReset();
  mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: mocks.membership }) }) });
});
afterEach(() => vi.unstubAllEnvs());
const request = () => new Request("https://study.example/api/admin/settings", { headers: { Authorization: "Bearer test-token" } });
describe("server-side admin boundary", () => {
  it("rejects unauthenticated requests before any database access", async () => {
    await expect(requireUser(new Request("https://study.example"))).rejects.toMatchObject({ status: 401 });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it("rejects expired or invalid tokens", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError("expired", 403, "bad_jwt") });
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 401, message: invalidSessionMessage });
  });
  it.each([
    new AuthRetryableFetchError("connection-reset-with-private-data", 0),
    new AuthRetryableFetchError("upstream-unavailable", 503),
    new AuthApiError("gateway-timeout", 504, undefined),
    new AuthApiError("request-timeout", 408, undefined),
    new AuthUnknownError("unreadable-response", new SyntaxError("private-response"))
  ])("reports upstream auth outages as 503, without granting access or leaking errors: %s", async error => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error });
    const response = await requireAdmin(request()).then(() => { throw new Error("must not authenticate"); }, errorResponse);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: authUnavailableMessage });
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("handles a rejected network promise without misreporting session expiry", async () => {
    mocks.getUser.mockRejectedValue(new TypeError("fetch failed: private-upstream-url"));
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 503, message: authUnavailableMessage });
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("keeps auth rate limits distinct from expired sessions", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError("rate-limit", 429, "over_request_rate_limit") });
    await expect(requireUser(request())).rejects.toMatchObject({ status: 429 });
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("rejects missing sessions and missing users even without a network error", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    await expect(requireUser(request())).rejects.toMatchObject({ status: 401 });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireUser(request())).rejects.toMatchObject({ status: 401 });
  });
  it("fails closed even if an upstream outage also returns a user object", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "a", is_anonymous: false } }, error: new AuthRetryableFetchError("outage", 502) });
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 503 });
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("never treats an anonymous participant as an administrator", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "p", is_anonymous: true } }, error: null });
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 403 });
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it("requires database membership even for a real email account", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u", is_anonymous: false } }, error: null });
    mocks.membership.mockResolvedValue({ data: null, error: null });
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 403 });
  });
  it("allows a verified admin, and fails closed when authorization storage fails", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "a", is_anonymous: false } }, error: null });
    mocks.membership.mockResolvedValue({ data: { user_id: "a" }, error: null });
    expect((await requireAdmin(request())).id).toBe("a");
    mocks.membership.mockResolvedValue({ data: null, error: {} });
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 503 });
  });
  it("does not echo unknown upstream errors or credentials", async () => {
    const silent = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(new Error("private-key-and-prompt"));
    expect(await response.text()).not.toContain("private-key-and-prompt");
    silent.mockRestore();
  });
});
