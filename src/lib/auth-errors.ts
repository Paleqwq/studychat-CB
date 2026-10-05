import { isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";

export const authUnavailableMessage = "暂时无法连接身份验证服务，请检查网络或代理连接后重试。";
export const invalidSessionMessage = "登录状态无效或已过期，请重新登录或联系管理员。";

// Only expose our own messages: upstream errors may contain URLs or credentials.
export function authFailure(error: unknown, context: "session" | "login" = "session") {
  if (isAuthError(error) && error.status === 429) {
    return { status: 429, message: "身份验证请求过于频繁，请稍后重试。" };
  }
  if (!isAuthError(error) || isAuthRetryableFetchError(error) ||
      error.status === undefined || error.status === 0 || error.status === 408 || error.status >= 500) {
    return { status: 503, message: authUnavailableMessage };
  }
  if (context === "login") {
    if (error.code === "email_not_confirmed") {
      return { status: 403, message: "管理员邮箱尚未确认，请在 Supabase 检查该账号的邮箱确认状态。" };
    }
    return { status: 401, message: "登录失败，请检查邮箱和密码。" };
  }
  return { status: 401, message: invalidSessionMessage };
}
