import { databaseUpgradeMessage } from "@/lib/server/env";
import { db } from "@/lib/server/db";
import { requireAdmin, readJson, HttpError, errorResponse, databaseError } from "@/lib/server/http";
import { encryptSecret } from "@/lib/server/crypto";
import { currentExperiment, redactedExperiment, type PrivateExperiment } from "@/lib/server/settings";
import { validateEndpoint } from "@/lib/server/provider";
import { experimentSchema } from "@/lib/validation";
import { modelFactors, type ModelFactor } from "@/lib/experiment";
import { questionDatabaseError } from "@/lib/server/question-session";
import { currentContentDraft, contentDraftDatabaseError } from "@/lib/server/content-draft";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const { config, enabled } = await currentExperiment();
    const draft = config ? undefined : await currentContentDraft();
    return Response.json(redactedExperiment(config, enabled, draft));
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const { api_keys, expected_revision, expected_draft_revision, enabled, ...settings } = experimentSchema.parse(await readJson(request, 240000));
    if (settings.question_mode?.enabled) {
      const ready = await db().rpc("question_mode_available");
      if (ready.error) questionDatabaseError(ready.error);
      if (ready.data !== true) throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 执行 004_question_mode.sql，再开启题目问答模式。"));
    }
    const { config: previous } = await currentExperiment();
    if (!previous && expected_draft_revision === undefined && (await currentContentDraft())?.content) {
      throw new HttpError(409, "已有教学内容草稿，请重新加载后台后再发布模型配置。");
    }
    const encryptedKeys = {} as Record<ModelFactor, string>;
    for (const factor of modelFactors) {
      const connection = settings.connections[factor];
      connection.api_base_url = await validateEndpoint(connection.api_base_url, connection.protocol, connection.api_url_mode);
      const key = api_keys[factor];
      if (!key && !previous?.encrypted_keys[factor]) throw new HttpError(400, `${factor} 首次发布请填写 API 密钥。`);
      if (!key && previous && new URL(previous.settings.connections[factor].api_base_url).origin !== new URL(connection.api_base_url).origin) {
        throw new HttpError(400, `${factor} API 域名已改变，请重新填写对应密钥。`);
      }
      encryptedKeys[factor] = key ? encryptSecret(key) : previous!.encrypted_keys[factor];
    }
    const { data, error } = await db().rpc(expected_draft_revision === undefined ? "publish_experiment" : "publish_experiment_with_content_draft", {
      p_settings: settings, p_keys: encryptedKeys, p_actor: admin.id,
      p_expected_revision: expected_revision, p_enabled: enabled,
      ...(expected_draft_revision === undefined ? {} : { p_expected_draft_revision: expected_draft_revision })
    });
    if (error) {
      if (expected_draft_revision !== undefined) contentDraftDatabaseError(error);
      databaseError(error.message);
    }
    return Response.json(redactedExperiment(data as PrivateExperiment, enabled));
  } catch (error) { return errorResponse(error); }
}
