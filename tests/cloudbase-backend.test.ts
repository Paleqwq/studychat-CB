import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), fetch: vi.fn<typeof fetch>(), order: [] as string[] }));
vi.mock("@/lib/server/cloudbase-auth", () => ({ verifyCloudBaseToken: mocks.verify }));
const envId = "studychat-test-env";
const appId = "11111111-1111-4111-8111-111111111111";
const subject = "cloudbase-remote-user";
const privateKey = "private-service-role-fixture";
const origin = `https://${envId}.api.tcloudbasegateway.com`;
const request = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/admin/settings", {
  headers: { Authorization: "Bearer remote-user-fixture", ...headers }
});

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.order.length = 0;
  const env = {
    NODE_ENV: "test", DEMO_MODE: "false", VERCEL: "", APP_ORIGIN: "",
    NEXT_PUBLIC_DATA_BACKEND: "cloudbase", NEXT_PUBLIC_CLOUDBASE_ENV_ID: envId,
    NEXT_PUBLIC_CLOUDBASE_REGION: "ap-shanghai", NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY: "public-fixture",
    CLOUDBASE_API_KEY: privateKey, CONFIG_ENCRYPTION_KEY: "private-encryption-fixture",
    NEXT_PUBLIC_SUPABASE_URL: "https://legacy.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "legacy-public",
    SUPABASE_SECRET_KEY: "private-legacy-fixture"
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  mocks.verify.mockImplementation(async () => {
    mocks.order.push("verify"); return { subject, isAnonymous: false, email: "admin@example.test" };
  });
  mocks.fetch.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/rpc/get_or_create_app_user")) {
      mocks.order.push("mapping");
      return Response.json({ id: appId, cloudbase_subject: subject });
    }
    if (url.pathname.endsWith("/admin_users")) return Response.json([{ user_id: appId }]);
    return Response.json([{ id: "message", role: "user", content: "学生回答" }]);
  });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("CloudBase backend configuration and REST boundary", () => {
  it("exposes only public environment, region and publishable key configuration", async () => {
    const { publicCloudBaseConfig, cloudBaseGateway } = await import("@/lib/backend");
    const config = publicCloudBaseConfig();
    expect(config).toEqual({ envId, region: "ap-shanghai", publishableKey: "public-fixture" });
    expect(cloudBaseGateway(config)).toBe(origin);
    expect(JSON.stringify(config)).not.toMatch(/private-service|private-encryption|private-legacy|API_KEY|SECRET_KEY/);
  });

  it.each(["foreign", "CLOUDBASE", "cloudbase,https://evil.example"])("fails closed for unknown backend %s", async backend => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", backend);
    const { dataBackend } = await import("@/lib/backend");
    const { runtimeMode } = await import("@/lib/server/env");
    expect(() => dataBackend()).toThrow();
    expect(runtimeMode()).toBe("setup");
  });

  it.each(["", "env.evil.example", "env@evil.example", "env/path", "env?x=1", "x".repeat(64)])
  ("rejects missing or unsafe environment IDs before sending any private REST credential: %s", async id => {
    vi.stubEnv("NEXT_PUBLIC_CLOUDBASE_ENV_ID", id);
    const { publicCloudBaseConfig } = await import("@/lib/backend");
    const { runtimeMode } = await import("@/lib/server/env");
    const { db } = await import("@/lib/server/db");
    expect(() => publicCloudBaseConfig()).toThrow();
    expect(runtimeMode()).toBe("setup");
    expect(() => db()).toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY", "CLOUDBASE_API_KEY", "CONFIG_ENCRYPTION_KEY"])
  ("does not fall back to an otherwise configured Supabase backend when CloudBase requires %s", async missing => {
    vi.stubEnv(missing, "");
    const { runtimeMode } = await import("@/lib/server/env");
    expect(runtimeMode()).toBe("setup");
  });

  it("preserves explicit Supabase selection for rollback", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "supabase");
    vi.stubEnv("CLOUDBASE_API_KEY", "");
    const { runtimeMode } = await import("@/lib/server/env");
    expect(runtimeMode()).toBe("live");
  });

  it("uses the CloudBase REST path and a server-only service credential with redirect blocking and a deadline", async () => {
    const { db } = await import("@/lib/server/db");
    const result = await db().from("messages").select("id,content").eq("conversation_id", appId);
    expect(result.error).toBeNull();
    const [input, options] = mocks.fetch.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/v1/rdb/rest/messages");
    expect(url.searchParams.get("conversation_id")).toBe(`eq.${appId}`);
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${privateKey}`);
    expect(headers.get("apikey")).toBeNull();
    expect(options).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it("verifies identity before mapping a CloudBase subject to its application UUID", async () => {
    const { db } = await import("@/lib/server/db");
    const result = await db().auth.getUser("remote-user-fixture");
    expect(mocks.order).toEqual(["verify", "mapping"]);
    expect(mocks.verify).toHaveBeenCalledWith("remote-user-fixture", {
      envId, region: "ap-shanghai", publishableKey: "public-fixture"
    });
    const [input, options] = mocks.fetch.mock.calls[0];
    expect(String(input)).toBe(origin + "/v1/rdb/rest/rpc/get_or_create_app_user");
    expect(JSON.parse(String(options?.body))).toEqual({ p_subject: subject });
    expect(result).toEqual({ data: { user: { id: appId, is_anonymous: false, email: "admin@example.test" } }, error: null });
    expect(JSON.stringify(result)).not.toMatch(/private-service|cloudbase_subject/);
  });

  it("never maps a subject when remote verification rejects the credential", async () => {
    mocks.verify.mockRejectedValue(new AuthApiError("private-provider-detail", 401, "bad_token"));
    const { requireUser } = await import("@/lib/server/http");
    await expect(requireUser(request())).rejects.toMatchObject({ status: 401 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    null, { id: "not-a-uuid", cloudbase_subject: subject }, { id: appId, cloudbase_subject: "another-user" }
  ])("treats an unavailable or inconsistent identity mapping as a service failure: %j", async data => {
    mocks.fetch.mockResolvedValue(Response.json(data));
    const { requireUser } = await import("@/lib/server/http");
    await expect(requireUser(request())).rejects.toMatchObject({ status: 503 });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

  it("does not report database mapping outages as session expiry or echo private upstream details", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ code: "PGRST_PRIVATE", message: `private-database-info ${privateKey}` }, { status: 503 }));
    const { requireUser, errorResponse } = await import("@/lib/server/http");
    const response = await requireUser(request()).then(() => { throw new Error("must fail"); }, errorResponse);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/private-database-info|private-service|PGRST_PRIVATE/);
  });
});

describe("CloudBase administrator and trusted proxy boundary", () => {
  it("rejects anonymous users before querying the administrator allowlist", async () => {
    mocks.verify.mockResolvedValue({ subject, isAnonymous: true, email: "admin@example.test" });
    const { requireAdmin } = await import("@/lib/server/http");
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 403 });
    expect(mocks.fetch.mock.calls.map(call => String(call[0]))).toEqual([origin + "/v1/rdb/rest/rpc/get_or_create_app_user"]);
  });

  it("requires the mapped application UUID in the administrator allowlist even for an email account", async () => {
    const { requireAdmin } = await import("@/lib/server/http");
    expect((await requireAdmin(request())).id).toBe(appId);
    const url = new URL(String(mocks.fetch.mock.calls[1][0]));
    expect(url.pathname).toBe("/v1/rdb/rest/admin_users");
    expect(url.searchParams.get("user_id")).toBe(`eq.${appId}`);
    mocks.fetch.mockImplementation(async input => String(input).includes("/admin_users")
      ? Response.json([]) : Response.json({ id: appId, cloudbase_subject: subject }));
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when the administrator allowlist is unavailable", async () => {
    mocks.fetch.mockImplementation(async input => String(input).includes("/admin_users")
      ? Response.json({ message: "private-allowlist-error" }, { status: 503 })
      : Response.json({ id: appId, cloudbase_subject: subject }));
    const { requireAdmin } = await import("@/lib/server/http");
    await expect(requireAdmin(request())).rejects.toMatchObject({ status: 503 });
  });

  it("accepts only the configured HTTPS browser origin behind the internal HTTP proxy", async () => {
    vi.stubEnv("APP_ORIGIN", "https://study.example");
    const { assertSameOrigin } = await import("@/lib/server/http");
    expect(() => assertSameOrigin(request({ Origin: "https://study.example", Host: "internal:3000" }))).not.toThrow();
    for (const Origin of ["https://evil.example", "http://study.example", "https://study.example/", "null"]) {
      expect(() => assertSameOrigin(request({ Origin, Host: "evil.example", "X-Forwarded-Host": "study.example",
        "X-Forwarded-Proto": "https", Forwarded: "host=study.example;proto=https" }))).toThrow("不允许跨站请求");
    }
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it.each(["http://study.example", "https://study.example/", "https://study.example/path", "https://study.example?x=1",
    "https://study.example#fragment", "https://user:password@study.example", "not-a-url"])
  ("rejects invalid configured origins with a configuration error: %s", async configured => {
    vi.stubEnv("APP_ORIGIN", configured);
    const { assertSameOrigin } = await import("@/lib/server/http");
    try { assertSameOrigin(request({ Origin: "https://study.example" })); throw new Error("must fail"); }
    catch (error) { expect(error).toMatchObject({ status: 503 }); }
  });

  it("rejects spoofed proxy origin before any token verification, and authenticates non-browser clients independently", async () => {
    vi.stubEnv("APP_ORIGIN", "https://study.example");
    const { requireUser } = await import("@/lib/server/http");
    await expect(requireUser(request({ Origin: "https://evil.example", "X-Forwarded-Host": "study.example" })))
      .rejects.toMatchObject({ status: 403 });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect((await requireUser(request())).id).toBe(appId);
  });
});
