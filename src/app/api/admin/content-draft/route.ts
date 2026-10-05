import { db } from "@/lib/server/db";
import { requireAdmin, readJson, errorResponse } from "@/lib/server/http";
import { currentExperiment, redactedExperiment } from "@/lib/server/settings";
import { currentContentDraft, contentDraftDatabaseError } from "@/lib/server/content-draft";
import { contentDraftSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const input = contentDraftSchema.parse(await readJson(request, 240000));
    const { error } = await db().rpc("save_content_draft", {
      p_content: input.content, p_actor: admin.id,
      p_expected_draft_revision: input.expected_draft_revision, p_enabled: input.enabled
    });
    if (error) contentDraftDatabaseError(error);
    const { config, enabled } = await currentExperiment();
    return Response.json(redactedExperiment(config, enabled, config ? undefined : await currentContentDraft()));
  } catch (error) { return errorResponse(error); }
}
