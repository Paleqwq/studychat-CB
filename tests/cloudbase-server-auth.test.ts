import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCloudBaseToken } from "@/lib/server/cloudbase-auth";
import { authFailure } from "@/lib/auth-errors";

const config = { envId: "studychat-test-env", region: "ap-shanghai", publishableKey: "public-fixture" };
const origin = `https://${config.envId}.api.tcloudbasegateway.com`;
const subject = "tencent-user-1";
function token(extra: object = {}) {
  const payload = { sub: subject, role: "authenticated", is_anonymous: false,
    iss: origin + "/auth/v1", aud: config.envId, project_id: config.envId,
    exp: Math.floor(Date.now() / 1000) + 7200, ...extra };
  return Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url") + "." +
    Buffer.from(JSON.stringify(payload)).toString("base64url") + ".test_signature";
}
function validRemote(introspection: object = {}, profile: object = {}) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ token_type: "Bearer",
    client_id: config.envId, sub: subject, scope: "openid", ...introspection }))
    .mockResolvedValueOnce(Response.json({ sub: subject, status: "ACTIVE", created_from: "password", ...profile }));
}
async function failure(promise: Promise<unknown>) {
  try { await promise; throw new Error("Expected authentication failure"); }
  catch (error) { return { error, status: authFailure(error).status }; }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CloudBase server remote token validation", () => {
  it("checks both documented remote endpoints before returning a realm-bound immutable subject", async () => {
    const accessToken = token();
    const fetcher = validRemote({}, { email: "admin@example.test" });
    expect(await verifyCloudBaseToken(accessToken, config, fetcher)).toEqual({ subject, isAnonymous: false, email: "admin@example.test" });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      origin + "/auth/v1/token/introspect", origin + "/auth/v1/user/me"
    ]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(options)).not.toContain(config.publishableKey);
    }
  });

  it("recognizes real anonymous users without relying on mutable profile name or email", async () => {
    const anonymous = token({ role: "anon", is_anonymous: true });
    expect(await verifyCloudBaseToken(anonymous, config, validRemote({ scope: "anonymous" }, {
      created_from: "anonymous", name: "Administrator", email: "admin@example.test"
    }))).toMatchObject({ subject, isAnonymous: true });
    expect(await verifyCloudBaseToken(token(), config, validRemote({}, { name: "anonymous" })))
      .toEqual({ subject, isAnonymous: false });
    expect(await verifyCloudBaseToken(token(), config, validRemote({}, { created_from: "anonymous" })))
      .toMatchObject({ isAnonymous: true });
  });

  it("rejects locally plausible claims when remote introspection returns the documented empty invalid-token object", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    expect((await failure(verifyCloudBaseToken(token(), config, fetcher))).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { client_id: "another-environment" }, { sub: "anon" }, { sub: "service_account" },
    { sub: "service_role" }, { token_type: "Basic" }, { scope: "server" }, { sub: "" }
  ])("rejects a foreign realm or non-user introspection result: %j", async introspection => {
    const fetcher = validRemote(introspection);
    expect((await failure(verifyCloudBaseToken(token(), config, fetcher))).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { role: "service_role" }, { is_system_admin: true }, { meta: { platform: "ApiKey" } },
    { meta: { platform: "PublishableKey" } }, { aud: "another-environment" },
    { iss: "https://foreign.example/auth/v1" }, { project_id: "foreign-environment" },
    { sub: "other-user" }, { role: "anon", is_anonymous: false }, { exp: 0 },
    { is_anonymous: undefined }, { role: "authenticated", is_anonymous: true },
    { client_type: "client_server" }, { app_metadata: { provider: "apikey" } }
  ])("rejects credentials whose verified PG claims are not an active user in this environment: %j", async claims => {
    expect((await failure(verifyCloudBaseToken(token(claims), config, validRemote()))).status).toBe(401);
  });

  it.each([{ sub: "different-user" }, { status: "BLOCKED" }])("rejects profile mismatch or inactive accounts: %j", async profile => {
    expect((await failure(verifyCloudBaseToken(token(), config, validRemote({}, profile)))).status).toBe(401);
  });

  it("rejects the configured public key, malformed credentials and unsafe environment IDs without a network request", async () => {
    const fetcher = validRemote();
    for (const bad of [config.publishableKey, "not-a-jwt", "x".repeat(8193), "x.y.z\n"]) {
      expect((await failure(verifyCloudBaseToken(bad, config, fetcher))).status).toBe(401);
    }
    for (const envId of ["evil.example/path", "env@evil.example", "-invalid", "x".repeat(64)]) {
      expect((await failure(verifyCloudBaseToken(token(), { ...config, envId }, fetcher))).status).toBe(503);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, 401], [403, 401], [429, 429], [408, 503], [500, 503], [503, 503], [302, 503]])
  ("maps upstream status %i to %i without exposing provider diagnostics", async (upstream, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("https://private.example?token=private-token", { status: upstream }));
    const result = await failure(verifyCloudBaseToken(token(), config, fetcher));
    expect(result.status).toBe(expected);
    expect(String(result.error)).not.toMatch(/private-token|private\.example|studychat-test-env|test_signature/);
  });

  it("sanitizes network exceptions and malformed upstream JSON", async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("private-token https://private.example"));
    expect((await failure(verifyCloudBaseToken(token(), config, network))).status).toBe(503);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-token not JSON"));
    const result = await failure(verifyCloudBaseToken(token(), config, malformed));
    expect(result.status).toBe(503);
    expect(String(result.error)).not.toContain("private-token");
  });

  it("sanitizes a profile endpoint failure after successful token introspection", async () => {
    const fetcher = validRemote();
    fetcher.mockReset().mockResolvedValueOnce(Response.json({ token_type: "Bearer", client_id: config.envId,
      sub: subject, scope: "user sso" })).mockResolvedValueOnce(new Response("private-token https://private.example", { status: 503 }));
    const result = await failure(verifyCloudBaseToken(token(), config, fetcher));
    expect(result.status).toBe(503);
    expect(String(result.error)).not.toMatch(/private-token|private\.example/);
  });

  it("limits streamed responses even when content length is absent", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    expect((await failure(verifyCloudBaseToken(token(), config, fetcher))).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels an oversized declared response before reading the body", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Length": "65537" }
    }));
    expect((await failure(verifyCloudBaseToken(token(), config, fetcher))).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
  });

  it("enforces a ten-second total timeout even if a fetcher ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const result = failure(verifyCloudBaseToken(token(), config, fetcher));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).status).toBe(503);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one ten-second deadline between introspection and the profile request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(Response.json({ token_type: "Bearer", client_id: config.envId,
        sub: subject, scope: "openid" })), 9_000);
    })).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const result = failure(verifyCloudBaseToken(token(), config, fetcher));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).status).toBe(503);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the same deadline to a response body that never finishes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const result = failure(verifyCloudBaseToken(token(), config, fetcher));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
