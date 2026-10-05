import "server-only";
import { AuthApiError, AuthRetryableFetchError, isAuthError } from "@supabase/supabase-js";
import { cloudBaseGateway, type PublicCloudBaseConfig } from "@/lib/backend";

type JsonObject = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 65_536;
const TIMEOUT_MS = 10_000;

const invalidToken = () => new AuthApiError("登录状态无效或已过期，请重新登录。", 401, "cloudbase_token_invalid");
const unavailable = () => new AuthRetryableFetchError("身份验证服务暂不可用，请稍后重试。", 503);

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw unavailable();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readObject(response: Response, signal: AbortSignal): Promise<JsonObject> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await withinDeadline(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(parsed)) throw unavailable();
    return parsed;
  } catch { throw unavailable(); }
  finally {
    // Cancellation is best-effort; an upstream stream must not prolong the deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Official HTTP contracts: /http-api/auth/auth-token-introspect and /http-api/auth/user-me.
// PG claim semantics: /authentication-v2/auth/auth-pg. Local decoding alone never authenticates.
export async function verifyCloudBaseToken(token: string, config: PublicCloudBaseConfig,
  fetcher: typeof fetch = fetch): Promise<{ subject: string; isAnonymous: boolean; email?: string }> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.envId) ||
      !/^[a-z][a-z0-9-]{1,31}$/.test(config.region) || !config.publishableKey) throw unavailable();
  if (typeof token !== "string" || token.length > 8192 || token === config.publishableKey ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalidToken();
  // This deployment supports mainland CloudBase PG; the origin is never caller-controlled.
  const origin = cloudBaseGateway(config);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const get = async (path: string) => {
    const response = await withinDeadline(fetcher(origin + path, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store", redirect: "error", signal: abort.signal
    }), abort.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) throw new AuthApiError("身份验证请求过于频繁，请稍后重试。", 429, "cloudbase_rate_limited");
      if (response.status >= 500 || response.status === 408 || response.status === 404 || response.status < 400) throw unavailable();
      throw invalidToken();
    }
    return readObject(response, abort.signal);
  };
  try {
    const introspection = await get("/auth/v1/token/introspect");
    const subject = introspection.sub;
    const scopes = typeof introspection.scope === "string" ? introspection.scope.split(/\s+/) : [];
    if (introspection.token_type !== "Bearer" || introspection.client_id !== config.envId ||
        typeof subject !== "string" || subject.length === 0 || subject.length > 64 || /\s|[\u0000-\u001f]/.test(subject) ||
        ["anon", "anonymous", "service_account", "service_role"].includes(subject.toLowerCase()) ||
        !scopes.some(scope => ["user", "openid", "anonymous"].includes(scope))) throw invalidToken();
    const profile = await get("/auth/v1/user/me");
    if (profile.sub !== subject || (profile.status !== undefined && profile.status !== "ACTIVE")) throw invalidToken();
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
    catch { throw invalidToken(); }
    // The two remote calls verified the credential. Deployed PG tokens use the
    // gateway origin; the official PG example uses its /auth/v1 issuer variant.
    // Accept only these exact issuers in this environment before mapping the user.
    if (!object(claims) || claims.sub !== subject ||
        (claims.iss !== origin && claims.iss !== origin + "/auth/v1") ||
        claims.aud !== config.envId || claims.project_id !== config.envId ||
        typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 ||
        !["anon", "authenticated"].includes(String(claims.role)) ||
        (claims.is_anonymous !== undefined && typeof claims.is_anonymous !== "boolean") ||
        (claims.role === "anon" ? claims.is_anonymous !== true : claims.is_anonymous === true) ||
        claims.is_system_admin === true ||
        claims.client_type === "client_server" ||
        (object(claims.meta) && ["PublishableKey", "ApiKey"].includes(String(claims.meta.platform))) ||
        (object(claims.app_metadata) && claims.app_metadata.provider === "apikey")) throw invalidToken();
    // Real password-login PG tokens may omit is_anonymous. An anonymous role must
    // explicitly carry true; a remotely verified authenticated role defaults false.
    const isAnonymous = claims.is_anonymous === true || profile.created_from === "anonymous";
    return { subject, isAnonymous, ...(typeof profile.email === "string" && profile.email.length <= 320 ? { email: profile.email } : {}) };
  } catch (error) {
    if (isAuthError(error)) throw error;
    // Never forward provider bodies, request URLs, credentials, or fetch diagnostics.
    throw unavailable();
  } finally { clearTimeout(timer); abort.abort(); }
}
