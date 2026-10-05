import { z } from "zod";
import { defaultSettings, type StudySettings } from "./types";
import { demoConfig } from "./demo";
import { englishCurriculumSchema, resolveEnglishCurriculum, type EnglishCurriculum } from "./english-assistant";

export const defaultEnglishBasePrompt = "请依据三份 PEEC 学习材料，以清晰、耐心的中文辅导大学英语四六级写作；例句使用英语，每次围绕当前学习活动给出具体反馈。";
export type EnglishAdminConfiguration = {
  id: string | null;
  settings: StudySettings;
  enabled: boolean;
  has_api_key: boolean;
  created_at: string | null;
  revision: number;
  base_prompt: string;
  personality_prompt: string;
  shared_experiment_revision: number | null;
  curriculum: EnglishCurriculum;
};
export const englishSettingsSchema = z.object({
  disclosure: z.string().trim().min(1).max(2000),
  base_prompt: z.string().trim().min(1).max(10000),
  personality_prompt: z.string().trim().min(1).max(10000),
  enabled: z.boolean(),
  expected_revision: z.number().int().nonnegative(),
  curriculum: englishCurriculumSchema
}).strict();
export type EnglishSettingsInput = z.infer<typeof englishSettingsSchema>;

export function defaultEnglishSettings(): StudySettings {
  return { ...defaultSettings,
    title: "英语助教", assistant_name: "英语助教",
    welcome_message: "依据三份 PEEC 学习材料，按 BOPPPS 六阶段完成大学英语四六级段落写作学习。",
    disclosure: "学号用于关联英语助教学习记录。英语对话将独立保存；请勿输入姓名、联系方式或其他敏感个人信息。",
    system_prompt: "英语助教的 BOPPPS 教学提示词由服务端固定生成。",
    api_url_mode: "base", question_mode: undefined
  };
}

const DEMO_ENGLISH_CONFIG_KEY = "studychat.english-assistant.config.v1";
/** The English store contains teaching settings only; connections remain shared. */
export function demoEnglishConfig(): EnglishAdminConfiguration {
  const shared = demoConfig();
  const defaults = defaultEnglishSettings();
  let stored: Partial<EnglishAdminConfiguration> | null = {};
  try { stored = JSON.parse(localStorage.getItem(DEMO_ENGLISH_CONFIG_KEY) ?? "{}"); }
  catch { /* Recover the teaching defaults when browser storage is damaged. */ }
  const revision = Number.isSafeInteger(stored?.revision) && stored!.revision! >= 0 ? stored!.revision! : 0;
  const disclosure = stored?.settings?.disclosure;
  const basePrompt = stored?.base_prompt;
  const personalityPrompt = stored?.personality_prompt;
  return {
    id: typeof stored?.id === "string" ? stored.id : null,
    revision,
    settings: { ...defaults, ...shared.connections.deepseek,
      disclosure: typeof disclosure === "string" && disclosure.trim().length > 0 && disclosure.length <= 2000 ? disclosure : defaults.disclosure },
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : true,
    has_api_key: false,
    created_at: typeof stored?.created_at === "string" ? stored.created_at : null,
    base_prompt: typeof basePrompt === "string" && basePrompt.trim() && basePrompt.length <= 10000 ? basePrompt : defaultEnglishBasePrompt,
    personality_prompt: typeof personalityPrompt === "string" && personalityPrompt.trim() && personalityPrompt.length <= 10000 ? personalityPrompt : shared.personality_prompt,
    shared_experiment_revision: shared.revision,
    curriculum: resolveEnglishCurriculum(stored?.curriculum)
  };
}

export function saveDemoEnglishConfig(config: EnglishAdminConfiguration): void {
  const input = englishSettingsSchema.parse({ disclosure: config.settings.disclosure,
    base_prompt: config.base_prompt, personality_prompt: config.personality_prompt,
    enabled: config.enabled, expected_revision: config.revision, curriculum: config.curriculum });
  localStorage.setItem(DEMO_ENGLISH_CONFIG_KEY, JSON.stringify({
    id: config.id, revision: config.revision, enabled: input.enabled,
    settings: { disclosure: input.disclosure }, base_prompt: input.base_prompt,
    personality_prompt: input.personality_prompt, created_at: config.created_at, curriculum: input.curriculum
  }));
}
