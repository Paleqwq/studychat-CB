import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudBaseBrowserAuthError, cloudBaseAuthStorageKey, cloudBaseBrowserAuthFailure,
  createCloudBaseBrowserClient, cloudBaseAuthUnavailableMessage
} from "@/lib/cloudbase-browser";
import type { BrowserIdentity } from "@/lib/browser-auth-types";

class TestStorage implements Storage {
  readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

const config = { envId: "studychat-test-123", region: "ap-shanghai", publishableKey: "public-test-key" };
const identityKinds: BrowserIdentity[] = ["participant", "english-participant", "admin"];
const mocks = { fetch: vi.fn(), lock: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
let storage: TestStorage;
function cached(kind: BrowserIdentity, extra: Record<string, unknown> = {}) {
  const session = {
    access_token: "token-" + kind, refresh_token: "refresh-" + kind,
    expires_at: Date.now() / 1000 + 7200,
    user: { id: "user-" + kind, is_anonymous: kind !== "admin" }, ...extra
  };
  storage.setItem(cloudBaseAuthStorageKey(config.envId, kind), JSON.stringify(session));
  return session;
}
function token(id: string, anonymous = true) {
  return { access_token: "access-" + id, refresh_token: "refresh-" + id, sub: id, scope: anonymous ? "anonymous" : "user", expires_in: 7200 };
}

beforeEach(() => {
  vi.clearAllMocks();
  storage = new TestStorage();
  vi.stubGlobal("window", { localStorage: storage, addEventListener: mocks.addEventListener, removeEventListener: mocks.removeEventListener });
  mocks.lock.mockImplementation((_key: string, callback: () => Promise<unknown>) => callback());
  vi.stubGlobal("navigator", { locks: { request: mocks.lock } });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("CloudBase browser identities using the official Auth HTTP API", () => {
  it("creates three concurrent identities with isolated device IDs, tokens, and locks", async () => {
    const clients = identityKinds.map(kind => createCloudBaseBrowserClient(kind, config));
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const id = new Headers(init.headers).get("X-Device-Id")!;
      return Response.json(token(id, !JSON.parse(init.body as string).password));
    });
    const results = await Promise.all([
      clients[0].auth.signInAnonymously(), clients[1].auth.signInAnonymously(),
      clients[2].auth.signInWithPassword({ email: "teacher", password: "password" })
    ]);
    const tokens = results.map(result => result.data.session?.access_token);
    expect(new Set(tokens).size).toBe(3);
    expect(results.every(result => !result.error)).toBe(true);
    expect(new Set(mocks.fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("X-Device-Id"))).size).toBe(3);
    for (const kind of identityKinds) {
      expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, kind))).toBeTruthy();
      expect(mocks.lock).toHaveBeenCalledWith(cloudBaseAuthStorageKey(config.envId, kind), expect.any(Function));
    }
    for (const [url, init] of mocks.fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/studychat-test-123\.api\.tcloudbasegateway\.com\/auth\/v1\//);
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      expect(init.credentials).toBe("omit");
    }
    expect(storage.getItem("studychat.participant.auth")).toBeNull();
  });

  it("reuses the same anonymous subject after refresh and a new client instance", async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => Response.json(token(new Headers(init.headers).get("X-Device-Id")!)));
    const first = await createCloudBaseBrowserClient("english-participant", config).auth.signInAnonymously();
    const restored = await createCloudBaseBrowserClient("english-participant", config).auth.getSession();
    expect(restored.data.session).toEqual(first.data.session);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent first-time anonymous sign-ins within one role", async () => {
    mocks.fetch.mockResolvedValue(Response.json(token("persistent-user")));
    const client = createCloudBaseBrowserClient("participant", config);
    const results = await Promise.all([client.auth.signInAnonymously(), client.auth.signInAnonymously(), client.auth.getSession()]);
    expect(results.map(result => result.data.session?.user?.id)).toEqual(["persistent-user", "persistent-user", "persistent-user"]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("does not generate an anonymous admin identity", async () => {
    const result = await createCloudBaseBrowserClient("admin", config).auth.signInAnonymously();
    expect(result.error).toMatchObject({ code: "admin_anonymous_forbidden" });
    expect(storage.length).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["teacher", "teacher@example.com"])("uses the documented username parameter for admin account %s", async account => {
    mocks.fetch.mockResolvedValue(Response.json(token("teacher-id", false)));
    const result = await createCloudBaseBrowserClient("admin", config).auth.signInWithPassword({ email: account, password: "password" });
    expect(result.error).toBeNull();
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ username: account, password: "password" });
    expect(result.data.session?.user).toMatchObject({ id: "teacher-id", is_anonymous: false });
  });

  it("refreshes once and keeps the subject when several requests arrive after expiry", async () => {
    cached("english-participant", { expires_at: Date.now() / 1000 - 1 });
    mocks.fetch.mockResolvedValue(Response.json(token("user-english-participant")));
    const client = createCloudBaseBrowserClient("english-participant", config);
    const results = await Promise.all([client.auth.getSession(), client.auth.getSession()]);
    expect(results.every(result => result.data.session?.user?.id === "user-english-participant")).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://studychat-test-123.api.tcloudbasegateway.com/auth/v1/token");
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ client_id: config.envId, grant_type: "refresh_token", refresh_token: "refresh-english-participant" });
    expect(JSON.parse(storage.getItem(cloudBaseAuthStorageKey(config.envId, "english-participant"))!).refresh_token).toBe("refresh-user-english-participant");
  });

  it("restores anonymous tokens that have no refresh token with the cached device", async () => {
    const previous = cached("participant", { refresh_token: undefined, expires_at: Date.now() / 1000 - 1 });
    storage.setItem(cloudBaseAuthStorageKey(config.envId, "participant") + ".device", "persistent-device-0123456789");
    mocks.fetch.mockResolvedValue(Response.json(token(previous.user.id)));
    const result = await createCloudBaseBrowserClient("participant", config).auth.getSession();
    expect(result.error).toBeNull();
    expect(mocks.fetch.mock.calls[0][0]).toMatch(/\/signin\/anonymously$/);
    expect(new Headers(mocks.fetch.mock.calls[0][1].headers).get("X-Device-Id")).toBe("persistent-device-0123456789");
  });

  it("keeps stored sessions and avoids anonymous replacement during a refresh outage", async () => {
    cached("participant", { expires_at: Date.now() / 1000 - 1 });
    const before = storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"));
    mocks.fetch.mockRejectedValue(new Error("private-key-and-url"));
    const result = await createCloudBaseBrowserClient("participant", config).auth.signInAnonymously();
    expect(cloudBaseBrowserAuthFailure(result.error as CloudBaseBrowserAuthError).message).toBe(cloudBaseAuthUnavailableMessage);
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"))).toBe(before);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][0]).toMatch(/\/token$/);
  });

  it("rejects a changed identity in a refresh response without overwriting history", async () => {
    cached("participant", { expires_at: Date.now() / 1000 - 1 });
    const before = storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"));
    mocks.fetch.mockResolvedValue(Response.json(token("someone-else")));
    const result = await createCloudBaseBrowserClient("participant", config).auth.getSession();
    expect(result.error).toMatchObject({ code: "invalid_auth_response" });
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"))).toBe(before);
  });

  it("does not revive a session removed by another tab during refresh", async () => {
    cached("participant", { expires_at: Date.now() / 1000 - 1 });
    mocks.fetch.mockImplementation(async () => {
      storage.removeItem(cloudBaseAuthStorageKey(config.envId, "participant"));
      return Response.json(token("user-participant"));
    });
    const result = await createCloudBaseBrowserClient("participant", config).auth.getSession();
    expect(result.error).toMatchObject({ code: "session_changed" });
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"))).toBeNull();
  });

  it("signs out only the admin session and leaves student identities and devices intact", async () => {
    identityKinds.forEach(kind => cached(kind));
    mocks.fetch.mockResolvedValue(Response.json({}));
    expect(await createCloudBaseBrowserClient("admin", config).auth.signOut()).toEqual({ error: null });
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "admin"))).toBeNull();
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"))).toBeTruthy();
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "english-participant"))).toBeTruthy();
    expect(new Headers(mocks.fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer token-admin");
    expect(mocks.fetch.mock.calls[0][0]).toMatch(/\/user\/signout$/);
  });

  it("isolates subscriptions and filters cross-tab storage events by identity", async () => {
    const participant = createCloudBaseBrowserClient("participant", config);
    const english = createCloudBaseBrowserClient("english-participant", config);
    const studentListener = vi.fn(); const englishListener = vi.fn();
    const studentSubscription = participant.auth.onAuthStateChange(studentListener);
    const englishSubscription = english.auth.onAuthStateChange(englishListener);
    await vi.waitFor(() => expect(studentListener).toHaveBeenCalledWith("INITIAL_SESSION", null));
    studentListener.mockClear(); englishListener.mockClear();
    cached("participant");
    for (const [, handler] of mocks.addEventListener.mock.calls) handler({ key: cloudBaseAuthStorageKey(config.envId, "participant") });
    await vi.waitFor(() => expect(studentListener).toHaveBeenCalledWith("SIGNED_IN", expect.objectContaining({ access_token: "token-participant" })));
    expect(englishListener).not.toHaveBeenCalled();
    studentSubscription.data.subscription.unsubscribe(); englishSubscription.data.subscription.unsubscribe();
    expect(mocks.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("preserves malformed local state for explicit recovery instead of creating another anonymous account", async () => {
    storage.setItem(cloudBaseAuthStorageKey(config.envId, "participant"), "not-json");
    const result = await createCloudBaseBrowserClient("participant", config).auth.signInAnonymously();
    expect(result.error).toMatchObject({ code: "invalid_local_session" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"))).toBe("not-json");
  });

  it("reports blocked storage without silently using a temporary identity", async () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("storage blocked"); } });
    const result = await createCloudBaseBrowserClient("participant", config).auth.signInAnonymously();
    expect(result.error).toMatchObject({ code: "storage_unavailable" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not forward Supabase Turnstile credentials to CloudBase", async () => {
    const result = await createCloudBaseBrowserClient("participant", config).auth.signInAnonymously({ options: { captchaToken: "private-turnstile-token" } });
    expect(result.error).toMatchObject({ code: "captcha_unsupported" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("never exposes upstream error text and distinguishes invalid credentials from outages", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ error: "invalid_password", error_description: "private-token-password-url" }, { status: 400 }));
    const result = await createCloudBaseBrowserClient("admin", config).auth.signInWithPassword({ email: "teacher", password: "password" });
    expect(cloudBaseBrowserAuthFailure(result.error as CloudBaseBrowserAuthError, "login")).toEqual({ status: 401, message: "登录失败，请检查管理员账号和密码。" });
    expect(JSON.stringify(result)).not.toContain("private-token-password-url");
    expect(cloudBaseBrowserAuthFailure(new CloudBaseBrowserAuthError(400, "resource_exhausted", "private-upstream"))).toEqual({ status: 429, message: "身份验证请求过于频繁，请稍后重试。" });
  });

  it("keeps storage separate when the CloudBase environment changes", async () => {
    cached("participant");
    const other = createCloudBaseBrowserClient("participant", { ...config, envId: "another-env-123" });
    expect((await other.auth.getSession()).data.session).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("CloudBase integration with the existing browser API facade", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "cloudbase");
    vi.stubEnv("NEXT_PUBLIC_CLOUDBASE_ENV_ID", config.envId);
    vi.stubEnv("NEXT_PUBLIC_CLOUDBASE_REGION", config.region);
    vi.stubEnv("NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY", config.publishableKey);
  });

  it("sends the English token to application routes and keeps the Bloom token isolated", async () => {
    const { authFetch } = await import("@/lib/browser");
    cached("participant"); cached("english-participant");
    mocks.fetch.mockResolvedValue(Response.json({ registered: true }));
    await authFetch("/api/english-assistant/session", "english-participant", { method: "POST", body: JSON.stringify({ student_id: "0001" }) }, { code: "english-code" });
    const [path, init] = mocks.fetch.mock.calls[0];
    expect(path).toBe("/api/english-assistant/session");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-english-participant");
    expect(new Headers(init.headers).get("X-Study-Code")).toBe("english-code");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("keeps old Supabase state intact and marks it for explicit identity migration", async () => {
    const { hasLegacySupabaseSession, browserClient } = await import("@/lib/browser");
    storage.setItem("studychat.english-participant.auth", "old-supabase-session");
    expect(hasLegacySupabaseSession("english-participant")).toBe(true);
    expect(hasLegacySupabaseSession("participant")).toBe(false);
    expect((await browserClient("english-participant").auth.getSession()).data.session).toBeNull();
    expect(storage.getItem("studychat.english-participant.auth")).toBe("old-supabase-session");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not replace a saved participant when the refresh token is rejected", async () => {
    const { accessToken } = await import("@/lib/browser");
    cached("participant", { expires_at: Date.now() / 1000 - 1 });
    mocks.fetch.mockResolvedValue(Response.json({ error: "invalid_grant", error_description: "private-refresh-token" }, { status: 400 }));
    await expect(accessToken("participant")).rejects.toThrow("登录状态无效或已过期");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][0]).toMatch(/\/token$/);
    expect(storage.getItem(cloudBaseAuthStorageKey(config.envId, "participant"))).toBeTruthy();
  });
});
