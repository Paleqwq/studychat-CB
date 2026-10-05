"use client";
import { createClient } from "@supabase/supabase-js";
import { authFailure } from "./auth-errors";
import { dataBackend, publicCloudBaseConfig } from "./backend";
import { CloudBaseBrowserAuthError, cloudBaseBrowserAuthFailure, createCloudBaseBrowserClient } from "./cloudbase-browser";
import type { BrowserAuthClient, BrowserIdentity } from "./browser-auth-types";

export type { BrowserIdentity } from "./browser-auth-types";
const clients = new Map<string, BrowserAuthClient>();
const anonymousSignIns = new WeakMap<BrowserAuthClient, Promise<string>>();

export function browserAuthFailure(error: unknown, context: "session" | "login" = "session") {
  return error instanceof CloudBaseBrowserAuthError ? cloudBaseBrowserAuthFailure(error, context) : authFailure(error, context);
}

export function hasLegacySupabaseSession(kind: BrowserIdentity) {
  if (dataBackend() !== "cloudbase" || typeof window === "undefined") return false;
  try { return Boolean(window.localStorage.getItem("studychat." + kind + ".auth")); }
  catch { return false; }
}

export function browserClient(kind: BrowserIdentity): BrowserAuthClient {
  if (dataBackend() === "cloudbase") {
    const config = publicCloudBaseConfig();
    const cacheKey = "cloudbase." + config.envId + "." + kind;
    if (!clients.has(cacheKey)) clients.set(cacheKey, createCloudBaseBrowserClient(kind, config));
    return clients.get(cacheKey)!;
  }
  const cacheKey = "supabase." + kind;
  if (!clients.has(cacheKey)) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Supabase 尚未配置。");
    clients.set(cacheKey, createClient(url, key, {
      auth: { storageKey: "studychat." + kind + ".auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    }));
  }
  return clients.get(cacheKey)!;
}

export async function accessToken(kind: BrowserIdentity, captchaToken?: string): Promise<string> {
  const client = browserClient(kind);
  const { data: { session }, error } = await client.auth.getSession();
  if (error) throw new Error(browserAuthFailure(error).message);
  if (session) return session.access_token;
  if (kind === "admin") throw new Error("请先登录管理员账号。");
  if (!anonymousSignIns.has(client)) anonymousSignIns.set(client, (async () => {
    const { data, error } = await client.auth.signInAnonymously({ options: { captchaToken } });
    if (error && dataBackend() === "cloudbase") throw new Error(browserAuthFailure(error).message);
    if (error || !data.session) throw new Error("无法建立匿名会话，请确认网络或联系管理员检查登录配置。");
    return data.session.access_token;
  })());
  try { return await anonymousSignIns.get(client)!; }
  finally { anonymousSignIns.delete(client); }
}

export async function authFetch(path: string, kind: BrowserIdentity, init: RequestInit = {}, options?: { code?: string; captchaToken?: string }) {
  const token = await accessToken(kind, options?.captchaToken);
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + token);
  if (init.body) headers.set("Content-Type", "application/json");
  if (options?.code) headers.set("X-Study-Code", options.code);
  return fetch(path, { ...init, headers, cache: "no-store" });
}

export async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请稍后重试。");
  return data as T;
}
