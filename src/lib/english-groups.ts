import type { ChatMessage, Conversation, StudySettings } from "./types";
import type { EnglishProgress, EnglishCurriculum } from "./english-assistant";
import type { ConversationConnectionInfo } from "./conversation-connection";

export const englishGroups = [
  { code: "deepseek_personality", model: "deepseek", personality: true, label: "DeepSeek · 有人格" },
  { code: "deepseek_control", model: "deepseek", personality: false, label: "DeepSeek · 无人格" }
] as const;
export type EnglishGroupCode = typeof englishGroups[number]["code"];
export type EnglishGroupCounts = Record<EnglishGroupCode, number>;
export function emptyEnglishCounts(): EnglishGroupCounts {
  return { deepseek_personality: 0, deepseek_control: 0 };
}
export function englishGroupLabel(code: EnglishGroupCode | null) {
  return englishGroups.find(group => group.code === code)?.label ?? "历史 / 未分组";
}
export type EnglishResearchConversation = Conversation & {
  student_id: string;
  group_code: EnglishGroupCode | null;
  model_factor: "deepseek" | null;
  personality: boolean | null;
  assigned_at: string | null;
  experiment_id: string | null;
  experiment_revision: number | null;
  prompt_revision: number | null;
  english_progress: EnglishProgress;
  english_paused?: boolean;
};
export type EnglishConversationDetail = {
  conversation: EnglishResearchConversation;
  messages: ChatMessage[];
  config: {
    id: string | null;
    settings: StudySettings;
    base_prompt: string | null;
    personality_prompt: string | null;
    curriculum?: EnglishCurriculum | null;
    prompt_revision: number | null;
    source_revision: number | null;
    created_at: string | null;
  };
  english_progress: EnglishProgress;
  english_turns?: unknown[];
  connection?: ConversationConnectionInfo;
};
