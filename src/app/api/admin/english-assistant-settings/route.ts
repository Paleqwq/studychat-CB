import { db } from "@/lib/server/db";
import { requireAdmin, readJson, errorResponse } from "@/lib/server/http";
import { currentEnglishConfiguration, redactedEnglishConfiguration, englishSettingsDatabaseError } from "@/lib/server/english-settings";
import { englishSettingsSchema } from "@/lib/english-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const { config, enabled, course } = await currentEnglishConfiguration();
    return Response.json(redactedEnglishConfiguration(config, enabled, course));
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const input = englishSettingsSchema.parse(await readJson(request, 600000));
    const { error } = await db().rpc("publish_english_course", {
      p_actor: admin.id, p_expected_revision: input.expected_revision, p_enabled: input.enabled,
      p_disclosure: input.disclosure, p_base_prompt: input.base_prompt, p_personality_prompt: input.personality_prompt,
      p_curriculum: input.curriculum
    });
    if (error) englishSettingsDatabaseError(error);
    const { config, enabled, course } = await currentEnglishConfiguration();
    return Response.json(redactedEnglishConfiguration(config, enabled, course));
  } catch (error) { return errorResponse(error); }
}
