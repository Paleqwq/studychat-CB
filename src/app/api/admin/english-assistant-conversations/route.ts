import { databaseUpgradeMessage } from "@/lib/server/env";
import { z } from "zod";
import { db } from "@/lib/server/db";
import { requireAdmin, readJson, errorResponse, HttpError, databaseError } from "@/lib/server/http";
import { englishSettingsDatabaseError } from "@/lib/server/english-settings";
import { currentConversationConnection } from "@/lib/server/conversation-connection";
import { englishGroups, emptyEnglishCounts, type EnglishGroupCode, type EnglishResearchConversation } from "@/lib/english-groups";
import { englishProgressSchema } from "@/lib/english-assistant";
import { deleteConversationSchema, studentIdSchema } from "@/lib/validation";
import type { StudySettings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const input = deleteConversationSchema.parse(await readJson(request, 2000));
    const result = await db().rpc("admin_delete_english_conversation", {
      p_conversation: input.conversation_id, p_actor: admin.id,
    });
    if (result.error) {
      if (["PGRST202", "42883", "42703", "PGRST204", "42P01"].includes(result.error.code ?? "")) {
        throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 执行 007_english_curriculum_and_delete.sql，开启英语会话删除功能。"));
      }
      databaseError(result.error.message);
    }
    if (result.data !== input.conversation_id) throw new HttpError(503, "无法确认英语会话删除结果，请刷新列表核实。");
    return Response.json({ deleted: true, conversation_id: input.conversation_id });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      z.uuid().parse(id);
      const { data: row, error } = await db().from("admin_english_conversation_records").select("*").eq("id", id).maybeSingle();
      if (error) englishSettingsDatabaseError(error);
      if (!row) throw new HttpError(404, "未找到此英语学习会话。");
      const conversation = row as EnglishResearchConversation;
      const [messages, config, turns] = await Promise.all([
        db().from("english_assistant_messages").select("id,role,content,status,turn_id,created_at,error_code").eq("session_id", id).order("sequence"),
        db().from("english_assistant_configs").select("id,settings,base_prompt,personality_prompt,prompt_revision,source_revision,created_at,curriculum").eq("id", row.config_id).single(),
        db().from("english_assistant_turns").select("turn_id,before_state,after_state,assessment,created_at").eq("session_id", id).order("created_at")
      ]);
      for (const result of [messages, config, turns]) if (result.error) englishSettingsDatabaseError(result.error);
      if (!config.data) throw new HttpError(503, "英语学习档案的配置快照无法读取，请稍后重试。");
      const connection = await currentConversationConnection(config.data.settings as StudySettings, conversation.model_factor);
      return Response.json({ conversation, messages: messages.data, config: config.data,
        english_progress: englishProgressSchema.parse(conversation.english_progress),
        english_turns: turns.data, connection: connection.info });
    }
    const offset = z.coerce.number().int().min(0).max(1000000).parse(url.searchParams.get("offset") ?? 0);
    const student = url.searchParams.get("student_id");
    const group = url.searchParams.get("group");
    let query = db().from("admin_english_conversation_records").select("*", { count: "exact" });
    if (student) query = query.eq("student_id", studentIdSchema.parse(student));
    if (group === "legacy") query = query.is("group_code", null);
    else if (group) {
      if (!englishGroups.some(item => item.code === group)) throw new HttpError(400, "英语分组参数不正确。");
      query = query.eq("group_code", group);
    }
    const [list, totals] = await Promise.all([
      query.order("created_at", { ascending: false }).order("id").range(offset, offset + 49),
      db().rpc("english_group_counts")
    ]);
    if (list.error) englishSettingsDatabaseError(list.error);
    if (totals.error) englishSettingsDatabaseError(totals.error);
    const counts = emptyEnglishCounts();
    for (const row of totals.data ?? []) if (englishGroups.some(group => group.code === row.group_code)) {
      counts[row.group_code as EnglishGroupCode] = Number(row.enrolled);
    }
    return Response.json({ conversations: list.data, total: list.count ?? 0, offset, counts });
  } catch (error) { return errorResponse(error); }
}
