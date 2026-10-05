"use client";
import Link from "next/link";
import { BookOpen, MessageSquare } from "lucide-react";
import type { ConversationMode, OpenedConversation } from "@/lib/opened-conversations";

export function ConversationHistory({ items, currentMode, busy, isBusy, onSelect }: {
  items: OpenedConversation[]; currentMode: ConversationMode; busy: boolean;
  isBusy: () => boolean; onSelect: (mode: ConversationMode) => void;
}) {
  return <nav className="conversation-history" aria-label="已打开的会话">
    {items.map(item => {
      const active = item.mode === currentMode;
      const Icon = item.mode === "english" ? BookOpen : MessageSquare;
      return <Link key={item.mode} href={item.mode === "english" ? "/english-assistant" : "/"}
        className={"current-chat" + (active ? " active" : "")} aria-current={active ? "page" : undefined}
        aria-disabled={busy || undefined} title={busy ? "正在回复，请等待完成后切换" : item.title}
        onClick={event => { if (isBusy()) event.preventDefault(); }}
        onNavigate={event => {
          if (isBusy()) { event.preventDefault(); return; }
          if (active) event.preventDefault();
          onSelect(item.mode);
        }}>
        <Icon size={16} strokeWidth={1.7}/><span>{item.title}</span>
      </Link>;
    })}
  </nav>;
}
