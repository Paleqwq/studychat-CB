import { db } from "@/lib/server/db";
import { requireUser, assertStudyCode, databaseError, errorResponse, readJson } from "@/lib/server/http";
import { defaultSettings, type ChatMessage, type StudySettings } from "@/lib/types";
import { participantSettings, participantMessageContent } from "@/lib/participant-presentation";
import { participantConversation } from "@/lib/participant";
import { registrationSchema } from "@/lib/validation";
import { currentExperiment } from "@/lib/server/settings";
import { ensureQuestionSession } from "@/lib/server/question-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function sessionRequest(request: Request, register: boolean) {
  try {
    const user = await requireUser(request);
    assertStudyCode(request);
    const current = await currentExperiment();
    const input = register ? registrationSchema.parse(await readJson(request, 1024)) : null;
    const { data: conversation, error } = input
      ? await db().rpc("register_participant", { p_owner: user.id, p_student_id: input.student_id })
      : await db().rpc("restore_conversation", { p_owner: user.id });
    if (error) databaseError(error.message);
    if (!conversation?.id) return Response.json({ registration_required: true,
      settings: participantSettings(current.config?.settings ?? defaultSettings), enabled: current.enabled });
    const [config, messages, state, enrollment] = await Promise.all([
      db().from("config_versions").select("settings").eq("id", conversation.config_id).single(),
      db().from("messages").select("id,role,content,status,turn_id,created_at,error_code").eq("conversation_id", conversation.id).order("sequence"),
      db().from("study_state").select("enabled").eq("id", 1).single(),
      db().from("participant_enrollments").select("student_id").eq("conversation_id", conversation.id).eq("owner_id", user.id).maybeSingle()
    ]);
    if (config.error || messages.error || state.error || enrollment.error) databaseError("READ_FAILED");
    const questionProgress = (config.data.settings as StudySettings).question_mode?.enabled
      ? await ensureQuestionSession(conversation.id, user.id) : null;
    // The first question is inserted atomically once, without fabricating a user message.
    if (questionProgress) {
      const refreshed = await db().from("messages").select("id,role,content,status,turn_id,created_at,error_code")
        .eq("conversation_id", conversation.id).order("sequence");
      if (refreshed.error) databaseError(refreshed.error.message);
      messages.data = refreshed.data;
    }
    return Response.json({
      student_id: enrollment.data?.student_id ?? null,
      conversation: participantConversation(questionProgress && conversation.title === "尚未开始对话"
        ? { ...conversation, title: "题目问答 · " + (config.data.settings as StudySettings).question_mode!.questions[0].title.slice(0, 50) }
        : conversation), messages: (messages.data as ChatMessage[]).map(message => ({ ...message,
          content: participantMessageContent(message, Boolean(questionProgress)) })),
      settings: participantSettings(config.data!.settings as StudySettings), enabled: state.data!.enabled,
      ...(questionProgress ? { question_progress: questionProgress } : {})
    });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request) { return sessionRequest(request, false); }
export async function POST(request: Request) { return sessionRequest(request, true); }
