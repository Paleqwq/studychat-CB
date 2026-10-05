import type { RuntimeMode, SessionPayload } from "./types";

export type ConversationMode = "general" | "english";
export type OpenedConversation = { mode: ConversationMode; title: string };

export function conversationTitle(mode: ConversationMode, session: SessionPayload | null): string {
  if (mode === "english") return "英语助教";
  return session?.messages.length && session.conversation.title !== "尚未开始对话"
    ? session.conversation.title : "对话实验";
}

export function openedConversationsKey(runtime: RuntimeMode): string {
  return "studychat.opened-conversations.v1." + runtime;
}

export function readOpenedConversations(runtime: RuntimeMode): OpenedConversation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(openedConversationsKey(runtime)) ?? "[]");
    if (!Array.isArray(value)) return [];
    const items: OpenedConversation[] = [];
    for (const item of value) {
      if (!item || (item.mode !== "general" && item.mode !== "english") ||
        typeof item.title !== "string" || !item.title.trim() || items.some(previous => previous.mode === item.mode)) continue;
      items.push({ mode: item.mode, title: item.title.slice(0, 60) });
    }
    return items;
  } catch { return []; }
}

export function rememberOpenedConversation(runtime: RuntimeMode, mode: ConversationMode, title?: string): OpenedConversation[] {
  const items = readOpenedConversations(runtime);
  if (runtime === "demo") {
    const sessions = [["general", "studychat.demo.session.v2"], ["english", "studychat.demo.english-session.v1"]] as const;
    for (const [sessionMode, key] of sessions) {
      if (items.some(item => item.mode === sessionMode)) continue;
      try {
        const session = JSON.parse(localStorage.getItem(key) ?? "null");
        if (typeof session?.conversation?.id === "string" && typeof session.conversation.title === "string" && Array.isArray(session.messages)) {
          items.push({ mode: sessionMode, title: conversationTitle(sessionMode, session).slice(0, 60) });
        }
      } catch {}
    }
  }
  const previous = items.find(item => item.mode === mode);
  if (previous) {
    if (title) previous.title = title.slice(0, 60);
  } else items.push({ mode, title: (title || conversationTitle(mode, null)).slice(0, 60) });
  // This index stores only sidebar labels. Messages and progress still come
  // from each type's existing authenticated session or independent demo store.
  try { localStorage.setItem(openedConversationsKey(runtime), JSON.stringify(items)); } catch {}
  return items;
}
