import { databaseUpgradeMessage } from "./env";
import "server-only";
import { db } from "./db";
import { databaseError, HttpError } from "./http";
import { questionProgressSchema } from "@/lib/question-mode";

export function questionDatabaseError(error: { code?: string; message: string }): never {
  if (error.message.includes("INVALID_QUESTION_MODE")) {
    throw new HttpError(503, "题目暂时无法读取，请联系管理员核验配置。");
  }
  if (["PGRST202", "42883", "42703", "PGRST204", "42P01"].includes(error.code ?? "")) {
    throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 执行 004_question_mode.sql，再开启题目问答模式。"));
  }
  databaseError(error.message);
}
export async function ensureQuestionSession(conversationId: string, ownerId: string) {
  const { data, error } = await db().rpc("ensure_question_session", { p_conversation: conversationId, p_owner: ownerId });
  if (error) questionDatabaseError(error);
  const parsed = questionProgressSchema.safeParse(data);
  if (!parsed.success) throw new HttpError(503, "题目问答进度无法读取，请联系管理员核验配置。");
  return parsed.data;
}
