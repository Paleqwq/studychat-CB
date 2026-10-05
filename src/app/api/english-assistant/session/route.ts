import { db } from "@/lib/server/db";
import { requireUser, errorResponse, readJson } from "@/lib/server/http";
import { assertEnglishAccessCode } from "@/lib/server/english-access";
import { currentEnglishConfiguration } from "@/lib/server/english-settings";
import { englishDatabaseError } from "@/lib/server/english-chat";
import { englishPublicSettings, parseEnglishProgress, firstEnglishMessage, englishCourseOutline, resolveEnglishCurriculum } from "@/lib/english-assistant";
import { participantConversation } from "@/lib/participant";
import { registrationSchema } from "@/lib/validation";
import type { ChatMessage, StudySettings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function sessionRequest(request: Request, register: boolean) {
  try {
    const user = await requireUser(request);
    assertEnglishAccessCode(request);
    const current = await currentEnglishConfiguration();
    const input = register ? registrationSchema.parse(await readJson(request, 1024)) : null;
    const { data: session, error } = input
      ? await db().rpc("register_english_session", { p_owner: user.id, p_student_id: input.student_id,
        p_initial_content: firstEnglishMessage(current.course.curriculum), p_expected_revision: current.course.revision })
      : await db().rpc("restore_english_session", { p_owner: user.id });
    if (error) englishDatabaseError(error);
    if (!session?.id) return Response.json({ registration_required: true,
      settings: englishPublicSettings(current.course.disclosure), enabled: current.enabled });
    const [config, messages] = await Promise.all([
      db().from("english_assistant_configs").select("settings,curriculum").eq("id", session.config_id).single(),
      db().from("english_assistant_messages").select("id,role,content,status,turn_id,created_at,error_code")
        .eq("session_id", session.id).order("sequence")
    ]);
    if (config.error) englishDatabaseError(config.error);
    if (messages.error) englishDatabaseError(messages.error);
    const curriculum = resolveEnglishCurriculum(config.data.curriculum);
    return Response.json({ student_id: session.student_id,
      conversation: participantConversation(session), messages: messages.data as ChatMessage[],
      settings: englishPublicSettings((config.data.settings as StudySettings).disclosure),
      enabled: current.enabled, english_progress: parseEnglishProgress(session.english_progress, curriculum),
      english_course: englishCourseOutline(curriculum), english_paused: session.english_paused ?? false });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request) { return sessionRequest(request, false); }
export async function POST(request: Request) { return sessionRequest(request, true); }
