import { describe, expect, it } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from "@supabase/supabase-js";
import { authFailure, authUnavailableMessage, invalidSessionMessage } from "@/lib/auth-errors";

describe("safe auth error messages", () => {
  it.each(["session", "login"] as const)("does not blame credentials for an outage during %s", context => {
    expect(authFailure(new AuthRetryableFetchError("secret-token-and-url", 0), context))
      .toEqual({ status: 503, message: authUnavailableMessage });
  });
  it("distinguishes invalid credentials from invalid sessions", () => {
    const error = new AuthApiError("private-response", 400, "invalid_credentials");
    expect(authFailure(error, "login")).toEqual({ status: 401, message: "登录失败，请检查邮箱和密码。" });
    expect(authFailure(error)).toEqual({ status: 401, message: invalidSessionMessage });
  });
  it("explains unconfirmed email without exposing account information", () => {
    expect(authFailure(new AuthApiError("private-email", 400, "email_not_confirmed"), "login"))
      .toEqual({ status: 403, message: "管理员邮箱尚未确认，请在 Supabase 检查该账号的邮箱确认状态。" });
  });
  it.each([
    new TypeError("private-network-details"),
    new AuthUnknownError("private-body", new Error("private-cause")),
    new AuthApiError("private-upstream-error", 500, "unexpected_failure"),
    {}
  ])("fails safely for unknown and upstream failures: %s", error => {
    expect(authFailure(error)).toEqual({ status: 503, message: authUnavailableMessage });
  });
  it("preserves rate limiting as a retry-later condition", () => {
    expect(authFailure(new AuthApiError("private-rate-details", 429, "over_request_rate_limit"), "login"))
      .toEqual({ status: 429, message: "身份验证请求过于频繁，请稍后重试。" });
  });
});
