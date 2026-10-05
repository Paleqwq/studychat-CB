import { databaseUpgradeMessage } from "@/lib/server/env";
import { z } from "zod";
import { db } from "@/lib/server/db";
import { requireAdmin, readJson, errorResponse, HttpError, databaseError } from "@/lib/server/http";
import { emptyCounts, groups, type GroupCode } from "@/lib/experiment";
import { studentIdSchema, deleteConversationSchema } from "@/lib/validation";
import { currentConversationConnection } from "@/lib/server/conversation-connection";
import type { StudySettings } from "@/lib/types";
import { questionDatabaseError } from "@/lib/server/question-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const input = deleteConversationSchema.parse(await readJson(request, 2000));
    const { data, error } = await db().rpc("admin_delete_conversation", {
      p_conversation: input.conversation_id, p_actor: admin.id
    });
    if (error) {
      if (error.code === "PGRST202" || error.code === "42883") {
        throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 执行 003_admin_delete_conversation.sql，开启管理员删除功能。"));
      }
      databaseError(error.message);
    }
    if (data !== input.conversation_id) throw new HttpError(503, "无法确认删除结果，请刷新会话列表核实。");
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
      const { data: conversation, error } = await db().from("admin_conversation_records")
        .select("*")
        .eq("id", id).maybeSingle();
      if (error) databaseError(error.message);
      if (!conversation) throw new HttpError(404, "未找到此会话。");
      const [messages, config] = await Promise.all([
        db().from("messages").select("id,role,content,status,turn_id,created_at,error_code").eq("conversation_id", id).order("sequence"),
        db().from("config_versions").select("revision,settings").eq("id", conversation.config_id).single()
      ]);
      if (messages.error || config.error) databaseError("READ_FAILED");
      const connection = await currentConversationConnection(config.data.settings as StudySettings, conversation.model_factor);
      let questionTurns: unknown[] | undefined;
      if ((config.data.settings as StudySettings).question_mode?.enabled) {
        const audit = await db().from("question_turns").select("turn_id,before_state,after_state,assessment,created_at")
          .eq("conversation_id", id).order("created_at");
        if (audit.error) questionDatabaseError(audit.error);
        questionTurns = audit.data ?? [];
      }
      // Only the explicit public description is exported, never the selected ciphertext.
      return Response.json({ conversation, messages: messages.data, config: config.data, connection: connection.info,
        ...(questionTurns ? { question_progress: conversation.question_progress, question_turns: questionTurns } : {}) });
    }
    const offset = z.coerce.number().int().min(0).max(1000000).parse(url.searchParams.get("offset") ?? 0);
    const student = url.searchParams.get("student_id");
    const group = url.searchParams.get("group");
    let query = db().from("admin_conversation_records").select("*", { count: "exact" });
    if (student) query = query.eq("student_id", studentIdSchema.parse(student));
    if (group === "legacy") query = query.is("group_code", null);
    else if (group) {
      if (!groups.some(g => g.code === group)) throw new HttpError(400, "分组参数不正确。");
      query = query.eq("group_code", group);
    }
    const { data, error, count } = await query
      .order("created_at", { ascending: false }).order("id").range(offset, offset + 49);
    if (error) databaseError(error.message);
    const counts = emptyCounts();
    const { data: rows, error: countError } = await db().rpc("experiment_group_counts");
    if (countError) databaseError(countError.message);
    for (const row of rows ?? []) if (groups.some(g => g.code === row.group_code)) counts[row.group_code as GroupCode] = Number(row.enrolled);
    return Response.json({ conversations: data, total: count ?? 0, offset, counts });
  } catch (error) { return errorResponse(error); }
}
