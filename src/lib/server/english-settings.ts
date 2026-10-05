import { databaseUpgradeMessage } from "./env";
import "server-only";
import { db } from "./db";
import { databaseError, HttpError } from "./http";
import { currentExperiment } from "./settings";
import { connectionSettings } from "@/lib/experiment";
import type { StudySettings } from "@/lib/types";
import { englishPublicSettings, resolveEnglishCurriculum, type EnglishCurriculum } from "@/lib/english-assistant";
import { defaultEnglishBasePrompt, defaultEnglishSettings, type EnglishAdminConfiguration } from "@/lib/english-settings";

export type EnglishCourseState = {
  active_config_id: string | null;
  enabled: boolean;
  revision: number;
  disclosure: string;
  base_prompt: string;
  personality_prompt: string | null;
  curriculum: EnglishCurriculum;
};
export type PrivateEnglishConfiguration = {
  id: string;
  settings: StudySettings;
  api_key_ciphertext: string;
  created_at: string;
  base_prompt: string;
  personality_prompt: string;
  source_revision: number;
  prompt_revision: number;
  curriculum: EnglishCurriculum;
};
export function englishSettingsDatabaseError(error: { code?: string; message: string }): never {
  if (["PGRST202", "42883", "42703", "PGRST204", "42P01"].includes(error.code ?? "")) {
    throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 依次执行 005_english_assistant.sql、006_english_groups.sql 和 007_english_curriculum_and_delete.sql，再使用英语助教。"));
  }
  if (/INVALID_ENGLISH_(CONFIG|COURSE|CURRICULUM)/.test(error.message)) throw new HttpError(400, "请完整填写英语课程提示词及六阶段的活动内容，并检查活动数量与词数限制。");
  databaseError(error.message);
}

/** English owns course state and history while reading the shared DeepSeek connection. */
export async function currentEnglishConfiguration(): Promise<{ config: PrivateEnglishConfiguration | null; enabled: boolean; course: EnglishCourseState }> {
  const [stateResult, source] = await Promise.all([
    db().from("english_assistant_state").select("active_config_id,enabled,revision,disclosure,base_prompt,personality_prompt,curriculum").eq("id", 1).single(),
    currentExperiment()
  ]);
  if (stateResult.error) englishSettingsDatabaseError(stateResult.error);
  const course: EnglishCourseState = { ...stateResult.data, curriculum: resolveEnglishCurriculum(stateResult.data.curriculum) };
  const published = source.config;
  const connection = published?.settings.connections.deepseek;
  if (!published || !connection?.model || !published.encrypted_keys.deepseek) return { config: null, enabled: course.enabled, course };
  const settings: StudySettings = { ...defaultEnglishSettings(), ...connectionSettings({ ...defaultEnglishSettings(), ...connection }),
    ...englishPublicSettings(course.disclosure), system_prompt: "BOPPPS PEEC" };
  return { config: { id: published.id, settings, api_key_ciphertext: published.encrypted_keys.deepseek,
    created_at: published.created_at, base_prompt: course.base_prompt,
    personality_prompt: course.personality_prompt ?? published.settings.personality_prompt,
    source_revision: published.revision, prompt_revision: course.revision, curriculum: course.curriculum }, enabled: course.enabled, course };
}

export function redactedEnglishConfiguration(config: PrivateEnglishConfiguration | null, enabled: boolean, course?: EnglishCourseState): EnglishAdminConfiguration {
  return { id: config?.id ?? null,
    settings: config?.settings ?? { ...defaultEnglishSettings(), ...englishPublicSettings(course?.disclosure ?? defaultEnglishSettings().disclosure) },
    enabled, has_api_key: Boolean(config?.api_key_ciphertext), created_at: config?.created_at ?? null,
    revision: course?.revision ?? config?.prompt_revision ?? 0,
    base_prompt: course?.base_prompt ?? config?.base_prompt ?? defaultEnglishBasePrompt,
    personality_prompt: course?.personality_prompt ?? config?.personality_prompt ?? "",
    shared_experiment_revision: config?.source_revision ?? null,
    curriculum: resolveEnglishCurriculum(course?.curriculum ?? config?.curriculum)
  };
}
