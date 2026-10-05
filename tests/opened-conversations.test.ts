import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHistory } from "@/components/conversation-history";
import { conversationTitle, openedConversationsKey, readOpenedConversations, rememberOpenedConversation } from "@/lib/opened-conversations";
import { demoSession } from "@/lib/demo";
import { demoEnglishSession, setDemoEnglishLearningPause } from "@/lib/english-demo";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("previously opened conversations", () => {
  it("keeps both entries after switching and reloading, updating titles without duplicates", () => {
    rememberOpenedConversation("live", "general", "第一段对话");
    rememberOpenedConversation("live", "english");
    rememberOpenedConversation("live", "general");
    expect(readOpenedConversations("live")).toEqual([
      { mode: "general", title: "第一段对话" }, { mode: "english", title: "英语助教" }
    ]);
    rememberOpenedConversation("live", "general", "更新后的对话标题");
    expect(readOpenedConversations("live")).toHaveLength(2);
    expect(readOpenedConversations("live")[0].title).toBe("更新后的对话标题");
    expect(readOpenedConversations("demo")).toEqual([]);
  });

  it("restores pre-existing demo entries without writing to either session or its paused learning progress", () => {
    const general = demoSession("HISTORY001")!;
    const english = demoEnglishSession("HISTORY001")!;
    setDemoEnglishLearningPause(english, true, "暂停学习", crypto.randomUUID());
    const original = new Map(storage);
    expect(rememberOpenedConversation("demo", "general")).toEqual([
      { mode: "general", title: "对话实验" }, { mode: "english", title: "英语助教" }
    ]);
    for (const [key, value] of original) expect(storage.get(key), key).toBe(value);
    expect(demoSession()!.conversation.id).toBe(general.conversation.id);
    expect(demoEnglishSession()!.conversation.id).toBe(english.conversation.id);
    expect(demoEnglishSession()!.english_paused).toBe(true);
    expect(demoEnglishSession()!.english_progress!.stage).toBe(english.english_progress!.stage);
  });

  it("ignores invalid stored entries and remains usable when storage is unavailable", () => {
    storage.set(openedConversationsKey("live"), "invalid json");
    expect(readOpenedConversations("live")).toEqual([]);
    storage.set(openedConversationsKey("live"), JSON.stringify([
      { mode: "other", title: "不支持的页面", href: "https://example.com" },
      { mode: "general", title: "对话实验" }, { mode: "general", title: "重复项" }, { mode: "english", title: 7 }
    ]));
    expect(readOpenedConversations("live")).toEqual([{ mode: "general", title: "对话实验" }]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(rememberOpenedConversation("live", "english")).toEqual([{ mode: "english", title: "英语助教" }]);
    expect(conversationTitle("general", null)).toBe("对话实验");
  });

  it("links both histories to their original routes and highlights only the viewed conversation", () => {
    const props = { items: rememberOpenedConversation("live", "general"), currentMode: "english" as const,
      busy: false, isBusy: () => false, onSelect: vi.fn() };
    props.items = rememberOpenedConversation("live", "english");
    const html = renderToStaticMarkup(createElement(ConversationHistory, props));
    expect(html).toContain('aria-label="已打开的会话"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/"[^]*?对话实验/);
    expect(html).toMatch(/class="current-chat active"[^>]*href="\/english-assistant"/);
    const links = ConversationHistory(props).props.children;
    const samePage = { preventDefault: vi.fn() };
    links[1].props.onNavigate(samePage);
    expect(samePage.preventDefault).toHaveBeenCalled();
    expect(props.onSelect).toHaveBeenLastCalledWith("english");
    const previousPage = { preventDefault: vi.fn() };
    links[0].props.onNavigate(previousPage);
    expect(previousPage.preventDefault).not.toHaveBeenCalled();
    expect(props.onSelect).toHaveBeenLastCalledWith("general");
  });

  it("blocks navigation during streaming even before the disabled state is rendered", () => {
    const onSelect = vi.fn();
    const tree = ConversationHistory({ items: [{ mode: "general", title: "对话实验" }],
      currentMode: "english", busy: false, isBusy: () => true, onSelect });
    const link = tree.props.children[0];
    const click = { preventDefault: vi.fn() };
    const navigation = { preventDefault: vi.fn() };
    link.props.onClick(click);
    link.props.onNavigate(navigation);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(navigation.preventDefault).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
