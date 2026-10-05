import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";

export function assertEnglishAccessCode(request: Request): void {
  const expected = process.env.ENGLISH_ASSISTANT_ACCESS_CODE;
  if (!expected) return;
  const supplied = request.headers.get("x-study-code") ?? "";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(expected), hash(supplied))) throw new HttpError(403, "请输入正确的英语助教访问码。");
}
