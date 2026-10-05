import "server-only";
import { timingSafeEqual, createHash } from "node:crypto";
import { db } from "./db";
import { runtimeMode } from "./env";
import { ZodError } from "zod";
import { authFailure, invalidSessionMessage } from "@/lib/auth-errors";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function authenticationError(error: unknown) {
  const failure = authFailure(error);
  return new HttpError(failure.status, failure.message);
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Non-browser clients may omit Origin, but still must pass token authentication.
  if (origin === null) return;
  const configuredOrigin = process.env.APP_ORIGIN;
  if (configuredOrigin) {
    let expected: URL;
    try { expected = new URL(configuredOrigin); }
    catch { throw new HttpError(503, "站点地址配置无效，请联系管理员。"); }
    if (expected.protocol !== "https:" || expected.username || expected.password ||
        expected.pathname !== "/" || expected.search || expected.hash ||
        configuredOrigin !== expected.origin) {
      throw new HttpError(503, "站点地址配置无效，请联系管理员。");
    }
    if (origin !== expected.origin) throw new HttpError(403, "不允许跨站请求。");
    return;
  }
  const target = new URL(request.url);
  const host = request.headers.get("host");
  const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (isLoopback(target.hostname) && host !== null) {
    // NextURL normalizes 127.x.x.x and ::1 to localhost. Recover only a literal
    // loopback Host with the same port; never trust forwarded headers or use a
    // caller-controlled public Host to broaden the accepted origin.
    if (!/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i.test(host)) {
      throw new HttpError(403, "不允许跨站请求。");
    }
    let authority: URL;
    try { authority = new URL(`${target.protocol}//${host}`); }
    catch { throw new HttpError(403, "不允许跨站请求。"); }
    if (!isLoopback(authority.hostname) || authority.port !== target.port) throw new HttpError(403, "不允许跨站请求。");
    target.host = authority.host;
  }
  if (origin !== target.origin) throw new HttpError(403, "不允许跨站请求。");
}

export function assertStudyCode(request: Request) {
  const expected = process.env.STUDY_ACCESS_CODE;
  if (!expected) return;
  const supplied = request.headers.get("x-study-code") ?? "";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(expected), hash(supplied))) throw new HttpError(403, "请输入正确的访问码。");
}

export async function requireUser(request: Request) {
  assertSameOrigin(request);
  if (runtimeMode() !== "live") throw new HttpError(503, "服务尚未配置完成。");
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || token.length > 8192) throw new HttpError(401, "请刷新页面后重新验证身份。");
  const { data, error } = await db().auth.getUser(token).catch((error: unknown) => {
    throw authenticationError(error);
  });
  if (error) throw authenticationError(error);
  if (!data.user) throw new HttpError(401, invalidSessionMessage);
  return data.user;
}

export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.is_anonymous) throw new HttpError(403, "仅管理员可访问。");
  const { data, error } = await db().from("admin_users").select("user_id").eq("user_id", user.id).maybeSingle();
  if (error) throw new HttpError(503, "权限校验暂不可用。");
  if (!data) throw new HttpError(403, "此账号没有管理员权限。");
  return user;
}

export async function readJson(request: Request, maxBytes = 40000): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "请求必须为 JSON。");
  if (Number(request.headers.get("content-length")) > maxBytes) throw new HttpError(413, "请求内容过长。");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求体为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, "请求内容过长。"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "JSON 格式不正确。");
  } finally { reader.releaseLock(); }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return Response.json({ error: "输入不符合要求，请检查长度、模型名称和参数。" }, { status: 400 });
  // Do not log prompts, credentials, upstream bodies or participant content.
  console.error("[studychat] request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "服务暂不可用，请稍后重试或联系管理员。" }, { status: 500 });
}

export function databaseError(message: string): never {
  const errors: Record<string, [number, string]> = {
    INVALID_QUESTION_MODE: [400, "题目问答模式须配置三道完整题目、参考要点和目标 Bloom 层级。"],
    QUESTION_COMPLETED: [409, "两轮问答已完成，本次会话不再接收新作答。"],
    QUESTION_ALREADY_STARTED: [409, "此会话已有消息，不能中途初始化题目模式，请联系管理员。"],
    QUESTION_NOT_STARTED: [409, "首题尚未准备好，请刷新页面后再作答。"],
    QUESTION_STATE_CONFLICT: [409, "题目进度已更新，请刷新页面后再作答。"],
    INVALID_QUESTION_ASSESSMENT: [503, "回复未通过校验，请重试本次回复。"],
    INVALID_STUDENT_ID: [400, "学号须为 1–32 位数字、字母、短横线或下划线。"],
    STUDENT_UNAVAILABLE: [409, "该学号无法在此浏览器登记，请回到原浏览器或联系管理员核验。"],
    IDENTITY_BOUND: [409, "本浏览器已绑定其他学号，不能更换学号或重新登记。"],
    LEGACY_SESSION: [409, "此浏览器保留历史会话，请联系管理员安排新的登记。"],
    INVALID_EXPERIMENT: [400, "请完整配置两套模型连接、基础提示词和人格提示词。"],
    STUDY_PAUSED: [403, "本次对话已暂停，请联系管理员。"],
    NOT_CONFIGURED: [503, "对话尚未开放，请联系管理员。"],
    CONVERSATION_NOT_FOUND: [404, "未找到此会话，可能已被其他管理员删除，请刷新列表。"],
    CONVERSATION_BUSY: [409, "此会话仍在生成回复，暂不能删除，请等待回复结束后重试。"],
    FORBIDDEN: [403, "无权访问此会话。"],
    BUSY: [409, "上一条回复仍在生成，请稍后重试。"],
    RATE_LIMITED: [429, "发送过于频繁，请一分钟后重试。"],
    SESSION_LIMIT: [429, "本次对话已达到上限，请联系管理员。"],
    CONFLICT: [409, "配置已被另一位管理员更新，请重新加载。"],
    TURN_CONFLICT: [409, "重试内容与原消息不同，请刷新后重试。"]
  };
  for (const [code, [status, text]] of Object.entries(errors)) {
    if (message.includes(code)) throw new HttpError(status, text);
  }
  throw new HttpError(503, "数据暂时无法保存，请稍后重试。");
}
