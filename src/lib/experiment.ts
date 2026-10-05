import { defaultSettings, publicSettings, type PublicSettings, type StudySettings, type Conversation } from "./types";
import type { QuestionMode } from "./question-mode";

export const modelFactors = ["deepseek", "chatgpt"] as const;
export type ModelFactor = typeof modelFactors[number];
export const groups = [
  { code: "deepseek_personality", model: "deepseek", personality: true, label: "DeepSeek · 有人格" },
  { code: "deepseek_control", model: "deepseek", personality: false, label: "DeepSeek · 无人格" },
  { code: "chatgpt_personality", model: "chatgpt", personality: true, label: "ChatGPT · 有人格" },
  { code: "chatgpt_control", model: "chatgpt", personality: false, label: "ChatGPT · 无人格" }
] as const;
export type GroupCode = typeof groups[number]["code"];
export type ModelConnection = Omit<StudySettings, keyof PublicSettings | "system_prompt" | "question_mode">;
export type ExperimentSettings = PublicSettings & {
  base_prompt: string;
  personality_prompt: string;
  connections: Record<ModelFactor, ModelConnection>;
  question_mode?: QuestionMode;
};
export type AdminExperiment = ExperimentSettings & {
  id: string;
  revision: number;
  has_api_keys: Record<ModelFactor, boolean>;
  enabled: boolean;
  created_at: string;
};
export type GroupCounts = Record<GroupCode, number>;
export type ResearchConversation = Conversation & {
  student_id: string | null;
  group_code: GroupCode | null;
  model_factor: ModelFactor | null;
  personality: boolean | null;
  experiment_id: string | null;
  experiment_revision: number | null;
  assigned_at: string | null;
};
export function emptyCounts(): GroupCounts {
  return Object.fromEntries(groups.map(g => [g.code, 0])) as GroupCounts;
}
export function connectionSettings(settings: StudySettings): ModelConnection {
  const { protocol, anthropic_auth, anthropic_workspace, api_base_url, api_url_mode, model, temperature, max_tokens, token_parameter } = settings;
  return { protocol, anthropic_auth, anthropic_workspace, api_base_url, api_url_mode, model, temperature, max_tokens, token_parameter };
}
export function defaultExperiment(): ExperimentSettings {
  return {
    ...publicSettings(defaultSettings),
    base_prompt: "请使用中文完成本项研究的对话任务。不要索取姓名、联系方式或其他敏感个人信息。",
    personality_prompt: "", // The investigator defines the manipulation; do not silently invent one.
    connections: {
      deepseek: { ...connectionSettings(defaultSettings), api_base_url: "https://api.deepseek.com/v1" },
      chatgpt: connectionSettings(defaultSettings)
    }
  };
}
export function effectiveSettings(settings: ExperimentSettings, group: typeof groups[number]): StudySettings {
  return { ...publicSettings(settings), ...settings.connections[group.model],
    ...(settings.question_mode ? { question_mode: settings.question_mode } : {}),
    system_prompt: settings.base_prompt + (group.personality ? "\n\n" + settings.personality_prompt : "") };
}
export function groupLabel(code: GroupCode | null) {
  return groups.find(g => g.code === code)?.label ?? "历史 / 未分组";
}
