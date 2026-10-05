import { neutralQuestionMessage } from "./question-mode";
import { questionMessageFeedback } from "./question-feedback";
import { defaultSettings, publicSettings, type ChatMessage, type PublicSettings } from "./types";

// Old sessions keep their frozen configuration. Translate only the former
// built-in labels for presentation; never mutate a snapshot or custom content.
const legacyDisclosure = "学号用于关联本项研究的对话记录。对话将被保存并用于研究；请勿在聊天中输入姓名、联系方式或其他敏感个人信息。";
export function participantSettings(settings: PublicSettings): PublicSettings {
  const visible = publicSettings(settings);
  return {
    ...visible,
    title: visible.title === "研究对话" ? defaultSettings.title : visible.title,
    assistant_name: visible.assistant_name === "研究助手" ? defaultSettings.assistant_name : visible.assistant_name,
    disclosure: visible.disclosure === legacyDisclosure ? defaultSettings.disclosure : visible.disclosure
  };
}

export function participantMessageContent(message: Pick<ChatMessage, "role" | "content">, questionMode: boolean): string {
  // Student answers and ordinary assistant discussions (including sleep
  // research) must not be filtered or rewritten.
  return questionMode && message.role === "assistant" ? questionMessageFeedback(neutralQuestionMessage(message.content)) : message.content;
}
