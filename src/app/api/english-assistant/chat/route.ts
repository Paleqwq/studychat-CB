import { z } from "zod";
import { db } from "@/lib/server/db";
import { requireUser, readJson, errorResponse, HttpError } from "@/lib/server/http";
import { assertEnglishAccessCode } from "@/lib/server/english-access";
import { englishChat, englishDatabaseError } from "@/lib/server/english-chat";
import { chatSchema } from "@/lib/validation";
import type { StudySettings } from "@/lib/types";
import { isEnglishLearningPauseRequest } from "@/lib/english-learning-pause";
import { englishLearningPauseStream, setEnglishLearningPause } from "@/lib/server/english-learning-pause";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const englishChatSchema = chatSchema.omit({ question_version: true }).extend({
  english_version: z.number().int().nonnegative()
}).strict();

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    assertEnglishAccessCode(request);
    const input = englishChatSchema.parse(await readJson(request));
    const { data: session, error: sessionError } = await db().from("english_assistant_sessions")
      .select("id,config_id,model_factor,group_code").eq("id", input.conversation_id).eq("owner_id", user.id).maybeSingle();
    if (sessionError) englishDatabaseError(sessionError);
    if (!session) throw new HttpError(403, "无权访问此英语学习会话。");
    if (isEnglishLearningPauseRequest(input.content)) {
      return englishLearningPauseStream(await setEnglishLearningPause(user.id, input, true));
    }
    const { data: snapshot, error: snapshotError } = await db().from("english_assistant_configs")
      .select("settings,api_key_ciphertext,base_prompt,personality_prompt,curriculum").eq("id", session.config_id).single();
    if (snapshotError) englishDatabaseError(snapshotError);
    if (session.model_factor != null && session.model_factor !== "deepseek") throw new HttpError(503, "英语模型分组信息不完整，请联系管理员。");
    return await englishChat(request, user.id, input, snapshot.settings as StudySettings, snapshot.api_key_ciphertext, {
      model_factor: session.model_factor ?? null,
      base_prompt: snapshot.base_prompt,
      curriculum: snapshot.curriculum,
      personality_prompt: session.group_code === "deepseek_personality" ? snapshot.personality_prompt : null
    });
  } catch (error) { return errorResponse(error); }
}
