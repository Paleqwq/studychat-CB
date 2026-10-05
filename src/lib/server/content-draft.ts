import "server-only";
import { db } from "./db";
import { databaseError, HttpError } from "./http";
import { databaseUpgradeMessage } from "./env";
import { experimentContentSchema, type ExperimentContent } from "@/lib/validation";

export type ContentDraft = {
  content: ExperimentContent | null;
  revision: number;
  enabled: boolean;
};
export function contentDraftDatabaseError(error: { code?: string; message: string }): never {
  if (["42703", "PGRST204", "PGRST202", "42883"].includes(error.code ?? "")) {
    throw new HttpError(503, databaseUpgradeMessage("请先执行 content_drafts 数据库迁移，再保存独立内容草稿。"));
  }
  if (error.message.includes("CONTENT_DRAFT_UNAVAILABLE")) {
    throw new HttpError(409, "模型配置已发布，请重新加载并使用保存并发布更新内容。");
  }
  if (error.message.includes("INVALID_CONTENT_DRAFT")) {
    throw new HttpError(400, "请完整填写页面内容、基础提示词、人格提示词和题目配置。");
  }
  databaseError(error.message);
}
export async function currentContentDraft(): Promise<ContentDraft | undefined> {
  const { data, error } = await db().from("study_state")
    .select("content_draft,draft_revision,draft_enabled").eq("id", 1).single();
  // Older installations can still use their existing model publishing flow.
  if (error && ["42703", "PGRST204"].includes(error.code ?? "")) return undefined;
  if (error) contentDraftDatabaseError(error);
  return { content: data.content_draft ? experimentContentSchema.parse(data.content_draft) : null,
    revision: Number(data.draft_revision ?? 0), enabled: data.draft_enabled ?? false };
}
