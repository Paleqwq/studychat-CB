"use client";

import { cloudBaseGateway, type PublicCloudBaseConfig } from "./backend";
import type { BrowserAuthClient, BrowserAuthEvent, BrowserAuthResult, BrowserIdentity, BrowserSession } from "./browser-auth-types";

const refreshMarginSeconds = 60;
export const cloudBaseAuthUnavailableMessage = "暂时无法连接 CloudBase 身份验证服务，请检查网络后重试。";
const invalidSessionMessage = "登录状态无效或已过期，请重新登录或联系管理员。";

export class CloudBaseBrowserAuthError extends Error {
  readonly name = "CloudBaseBrowserAuthError";
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function cloudBaseBrowserAuthFailure(error: CloudBaseBrowserAuthError, context: "session" | "login" = "session") {
  if (error.code === "storage_unavailable" || error.code === "captcha_unsupported") return { status: error.status, message: error.message };
  if (error.status === 429 || error.code === "resource_exhausted") return { status: 429, message: "身份验证请求过于频繁，请稍后重试。" };
  if (!error.status || error.status === 408 || error.status >= 500 || ["unreachable", "unavailable", "deadline_exceeded", "internal"].includes(error.code)) return { status: 503, message: cloudBaseAuthUnavailableMessage };
  if (error.code === "unimplemented" || error.code === "provider_not_enabled") {
    return { status: 403, message: "此登录方式尚未开启，请联系管理员检查 CloudBase 身份认证设置。" };
  }
  if (error.code === "permission_denied") {
    return { status: 403, message: "身份认证访问被拒绝，请联系管理员检查 CloudBase 安全域名与登录配置。" };
  }
  return { status: 401, message: context === "login" ? "登录失败，请检查管理员账号和密码。" : invalidSessionMessage };
}

type StoredSession = BrowserSession & { expires_at: number; user: { id: string; is_anonymous: boolean; email?: string } };
type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; sub?: unknown; scope?: unknown };
type AuthCallback = (event: BrowserAuthEvent, session: BrowserSession | null) => void;

function safeError(error: unknown) {
  return error instanceof CloudBaseBrowserAuthError ? error : new CloudBaseBrowserAuthError(503, "unreachable", cloudBaseAuthUnavailableMessage);
}

export function cloudBaseAuthStorageKey(envId: string, kind: BrowserIdentity) {
  return "studychat.cloudbase." + envId + "." + kind + ".auth";
}

// The current SDK broadcasts and deduplicates by environment client ID, which
// merges these three roles. The documented HTTP Auth API keeps their device IDs,
// sessions and refresh locks independent without inventing extra platform clients.
export function createCloudBaseBrowserClient(kind: BrowserIdentity, config: PublicCloudBaseConfig): BrowserAuthClient {
  const origin = cloudBaseGateway(config);
  const sessionKey = cloudBaseAuthStorageKey(config.envId, kind);
  const deviceKey = sessionKey + ".device";
  const listeners = new Set<AuthCallback>();
  let operations: Promise<unknown> = Promise.resolve();
  let listeningForStorage = false;

  function storage() {
    try {
      if (typeof window === "undefined") throw new Error();
      return window.localStorage;
    } catch {
      throw new CloudBaseBrowserAuthError(503, "storage_unavailable", "无法保存浏览器登录状态，请允许此网站使用本地存储后重试。");
    }
  }
  function read(key: string) {
    try { return storage().getItem(key); }
    catch (error) { throw error instanceof CloudBaseBrowserAuthError ? error : new CloudBaseBrowserAuthError(503, "storage_unavailable", "无法读取浏览器登录状态，请允许此网站使用本地存储后重试。"); }
  }
  function write(key: string, value: string | null) {
    try { if (value === null) storage().removeItem(key); else storage().setItem(key, value); }
    catch (error) { throw error instanceof CloudBaseBrowserAuthError ? error : new CloudBaseBrowserAuthError(503, "storage_unavailable", "无法保存浏览器登录状态，请允许此网站使用本地存储后重试。"); }
  }
  function readSession(): StoredSession | null {
    const raw = read(sessionKey);
    if (!raw) return null;
    try {
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== "object") throw new Error();
      const session = data as Partial<StoredSession>;
      if (typeof session.access_token !== "string" || !session.access_token ||
        typeof session.expires_at !== "number" || !Number.isFinite(session.expires_at) ||
        !session.user || typeof session.user.id !== "string" || !session.user.id || session.user.id === "anon" ||
        typeof session.user.is_anonymous !== "boolean" ||
        (session.refresh_token !== undefined && typeof session.refresh_token !== "string") ||
        (kind === "admin" && session.user.is_anonymous)) throw new Error();
      return session as StoredSession;
    } catch { throw new CloudBaseBrowserAuthError(401, "invalid_local_session", invalidSessionMessage); }
  }
  function deviceId() {
    const saved = read(deviceKey);
    if (saved && /^[a-zA-Z0-9_-]{16,48}$/.test(saved)) return saved;
    if (saved) throw new CloudBaseBrowserAuthError(401, "invalid_local_device", invalidSessionMessage);
    const value = crypto.randomUUID();
    write(deviceKey, value);
    return value;
  }
  function synchronize<T>(operation: () => Promise<T>): Promise<T> {
    const next = operations.then(async () => {
      // Refresh tokens rotate on use. Web Locks also serializes tabs of the same
      // role; the persistent-state comparison below guards older browsers.
      if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request(sessionKey, operation);
      return await operation();
    });
    operations = next.then(() => undefined, () => undefined);
    return next;
  }
  function notify(event: BrowserAuthEvent, session: BrowserSession | null) {
    for (const listener of listeners) queueMicrotask(() => listener(event, session));
  }
  function saveSession(session: StoredSession, event: BrowserAuthEvent) {
    write(sessionKey, JSON.stringify(session));
    notify(event, session);
  }

  async function request(path: string, body?: Record<string, unknown>, token?: string): Promise<TokenResponse> {
    const device = deviceId();
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json", "X-Device-Id": device });
    if (token) headers.set("Authorization", "Bearer " + token);
    let response: Response;
    try {
      response = await fetch(origin + "/auth/v1" + path, {
        method: "POST", headers, body: JSON.stringify(body ?? {}),
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000)
      });
    } catch { throw new CloudBaseBrowserAuthError(503, "unreachable", cloudBaseAuthUnavailableMessage); }
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = await response.json();
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { data = {}; }
    if (!response.ok || data.error) {
      // Keep only a constrained error code; upstream descriptions can contain
      // passwords, tokens or internal URLs and must never reach logs or the UI.
      const code = typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error) ? data.error : "auth_error";
      const status = response.ok ? 400 : response.status;
      throw new CloudBaseBrowserAuthError(status, code, status >= 500 ? cloudBaseAuthUnavailableMessage : invalidSessionMessage);
    }
    if (read(deviceKey) !== device) throw new CloudBaseBrowserAuthError(401, "device_changed", invalidSessionMessage);
    return data;
  }
  function tokenSession(data: TokenResponse, anonymous: boolean, previous?: StoredSession, email?: string): StoredSession {
    const id = data.sub === undefined && previous ? previous.user.id : data.sub;
    if (typeof data.access_token !== "string" || !data.access_token || typeof id !== "string" || !id || id === "anon" ||
      typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      (previous && id !== previous.user.id) || (kind === "admin" && typeof data.scope === "string" && data.scope.split(" ").includes("anonymous"))) {
      throw new CloudBaseBrowserAuthError(503, "invalid_auth_response", cloudBaseAuthUnavailableMessage);
    }
    return {
      access_token: data.access_token,
      ...(typeof data.refresh_token === "string" && data.refresh_token ? { refresh_token: data.refresh_token } : previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}),
      expires_at: Date.now() / 1000 + data.expires_in,
      user: { id, is_anonymous: anonymous, ...(email ? { email } : previous?.user.email ? { email: previous.user.email } : {}) }
    };
  }
  async function currentSession(): Promise<StoredSession | null> {
    const session = readSession();
    if (!session || session.expires_at > Date.now() / 1000 + refreshMarginSeconds) return session;
    if (!session.refresh_token) {
      // Anonymous login is tied to the cached device ID. Repeating it restores
      // that subject; it must not replace a previously registered participant.
      if (!session.user.is_anonymous || kind === "admin") throw new CloudBaseBrowserAuthError(401, "session_expired", invalidSessionMessage);
      const restored = tokenSession(await request("/signin/anonymously"), true, session);
      const latest = readSession();
      if (!latest || latest.access_token !== session.access_token) throw new CloudBaseBrowserAuthError(401, "session_changed", invalidSessionMessage);
      saveSession(restored, "TOKEN_REFRESHED");
      return restored;
    }
    let response: TokenResponse;
    try {
      response = await request("/token", { client_id: config.envId, grant_type: "refresh_token", refresh_token: session.refresh_token });
    } catch (error) {
      const latest = readSession();
      if (latest && latest.user.id === session.user.id && latest.access_token !== session.access_token && latest.expires_at > Date.now() / 1000 + refreshMarginSeconds) return latest;
      throw error;
    }
    const refreshed = tokenSession(response, session.user.is_anonymous, session);
    const latest = readSession();
    if (!latest || latest.access_token !== session.access_token) {
      if (latest && latest.user.id === session.user.id) return latest;
      throw new CloudBaseBrowserAuthError(401, "session_changed", invalidSessionMessage);
    }
    saveSession(refreshed, "TOKEN_REFRESHED");
    return refreshed;
  }
  async function result(operation: () => Promise<StoredSession | null>): Promise<BrowserAuthResult> {
    try { return { data: { session: await synchronize(operation) }, error: null }; }
    catch (error) { return { data: { session: null }, error: safeError(error) }; }
  }
  function storageChanged(event: StorageEvent) {
    if (event.key !== sessionKey && event.key !== null) return;
    try {
      const session = readSession();
      notify(session ? "SIGNED_IN" : "SIGNED_OUT", session);
    } catch { /* Keep a failed stored session intact for explicit recovery. */ }
  }

  return { auth: {
    getSession: () => result(currentSession),
    signInAnonymously: options => result(async () => {
      if (kind === "admin") throw new CloudBaseBrowserAuthError(401, "admin_anonymous_forbidden", "请先登录管理员账号。");
      if (options?.options?.captchaToken) throw new CloudBaseBrowserAuthError(400, "captcha_unsupported", "CloudBase 登录不能使用 Supabase 的 Turnstile 验证，请联系管理员检查登录配置。");
      const session = await currentSession();
      if (session) return session;
      const created = tokenSession(await request("/signin/anonymously"), true);
      saveSession(created, "SIGNED_IN");
      return created;
    }),
    signInWithPassword: credentials => result(async () => {
      if (kind !== "admin") throw new CloudBaseBrowserAuthError(401, "student_password_forbidden", invalidSessionMessage);
      const rawBefore = read(sessionKey);
      const session = tokenSession(await request("/signin", { username: credentials.email.trim(), password: credentials.password }), false, undefined,
        credentials.email.includes("@") ? credentials.email.trim() : undefined);
      if (read(sessionKey) !== rawBefore) throw new CloudBaseBrowserAuthError(401, "session_changed", invalidSessionMessage);
      saveSession(session, "SIGNED_IN");
      return session;
    }),
    signOut: async () => {
      try {
        await synchronize(async () => {
          const session = readSession();
          if (session) await request("/user/signout", {}, session.access_token);
          const latest = readSession();
          if (latest?.access_token !== session?.access_token) throw new CloudBaseBrowserAuthError(401, "session_changed", invalidSessionMessage);
          write(sessionKey, null);
          notify("SIGNED_OUT", null);
        });
        return { error: null };
      } catch (error) { return { error: safeError(error) }; }
    },
    onAuthStateChange: callback => {
      listeners.add(callback);
      if (!listeningForStorage && typeof window !== "undefined") { window.addEventListener("storage", storageChanged); listeningForStorage = true; }
      void result(currentSession).then(({ data, error }) => { if (listeners.has(callback) && !error) callback("INITIAL_SESSION", data.session); });
      return { data: { subscription: { unsubscribe() {
        listeners.delete(callback);
        if (listeningForStorage && !listeners.size) { window.removeEventListener("storage", storageChanged); listeningForStorage = false; }
      } } } };
    }
  } };
}
