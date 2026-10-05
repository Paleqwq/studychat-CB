import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishProgress } from "@/components/english-progress";
import { ParticipantChat } from "@/components/participant-chat";
import { demoConfig, demoSession, saveDemoConfig, saveDemoSession } from "@/lib/demo";
import { demoEnglishReply, demoEnglishSession, saveDemoEnglishSession } from "@/lib/english-demo";
import { englishStages, initialEnglishProgress } from "@/lib/english-assistant";
import { demoEnglishConfig, saveDemoEnglishConfig } from "@/lib/english-settings";
import { defaultQuestionMode } from "@/lib/question-mode";
import { defaultSettings, type SessionPayload } from "@/lib/types";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
});
afterEach(() => vi.unstubAllGlobals());

function submit(session: SessionPayload, turn = crypto.randomUUID()) {
  session.messages.push({ id: crypto.randomUUID(), role: "user", content: "演示作答", turn_id: turn,
    status: "complete", created_at: new Date().toISOString() });
  return demoEnglishReply(session);
}

describe("independent PEEC demonstration", () => {
  it("requires its own enrollment and never creates Bloom student history", () => {
    expect(demoEnglishSession()).toBeNull();
    const session = demoEnglishSession("ENG001")!;
    expect(session.student_id).toBe("ENG001");
    expect(session.conversation.title).toBe("英语助教");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toContain("PEEC");
    expect(session.english_progress).toEqual(initialEnglishProgress());
    expect(session.question_progress).toBeUndefined();
    expect(storage.has("studychat.demo.session.v2")).toBe(false);
    // English reads the shared DeepSeek connection configuration, without enrolling in Bloom.
    expect(demoEnglishConfig().settings.model).toBe(demoConfig().connections.deepseek.model);
    expect([...storage.keys()].some(key => key.startsWith("studychat.demo.experiment-snapshot."))).toBe(false);
  });

  it("keeps Bloom enrollment, frozen questions, messages and settings untouched while Bloom is paused", () => {
    const config = demoConfig();
    config.question_mode = { ...defaultQuestionMode(), enabled: true };
    saveDemoConfig(config);
    const general = demoSession("BLOOM001")!;
    general.messages.push({ id: "general-message", role: "user", content: "已有普通课程回答", turn_id: "general-turn",
      status: "complete", created_at: "" });
    saveDemoSession(general);
    config.enabled = false;
    saveDemoConfig(config);
    const original = new Map(storage);
    const english = demoEnglishSession("ENG002")!;
    const reply = submit(english);
    english.english_progress = reply.english_progress;
    saveDemoEnglishSession(english);
    expect(english.enabled).toBe(true);
    expect(english.student_id).toBe("ENG002");
    expect(english.question_progress).toBeUndefined();
    for (const [key, value] of original) expect(storage.get(key), key).toBe(value);
    expect(demoSession()!.student_id).toBe("BLOOM001");
    expect(demoSession()!.messages).toEqual(general.messages);
    expect(demoSession()!.question_progress).toEqual(general.question_progress);
  });

  it("restores an interrupted English response without changing progress or allowing a different enrollment", () => {
    const session = demoEnglishSession("000123")!;
    session.messages.push({ id: "pending", role: "assistant", content: "部分回复", turn_id: "pending-turn",
      status: "pending", created_at: "" });
    saveDemoEnglishSession(session);
    const restored = demoEnglishSession()!;
    expect(restored.student_id).toBe("000123");
    expect(restored.messages.at(-1)).toMatchObject({ status: "failed", content: "部分回复", error_code: "interrupted" });
    expect(restored.english_progress).toEqual(session.english_progress);
    expect(() => demoEnglishSession("other-id")).toThrow("其他学号");
  });

  it("uses only English availability and freezes its enrollment disclosure while general chat stays available", () => {
    const general = demoSession("BLOOM002")!;
    const config = demoEnglishConfig();
    config.settings.disclosure = "英语课程初始说明";
    saveDemoEnglishConfig(config);
    const english = demoEnglishSession("ENG005")!;
    expect(english.settings.disclosure).toBe("英语课程初始说明");
    config.settings.disclosure = "下一次新课程说明";
    config.enabled = false;
    saveDemoEnglishConfig(config);
    expect(demoEnglishSession()!.enabled).toBe(false);
    expect(demoEnglishSession()!.settings.disclosure).toBe("英语课程初始说明");
    expect(demoSession()!.enabled).toBe(true);
    expect(demoSession()!.conversation.id).toBe(general.conversation.id);
    storage.delete("studychat.demo.english-session.v1");
    expect(() => demoEnglishSession("ENG006")).toThrow("课程已暂停");
  });

  it("simulates revision gates only during practice and assessment, with stable transport retries", () => {
    const session = demoEnglishSession("ENG003")!;
    const bridge = submit(session);
    expect(bridge.english_progress.stage).toBe("objectives");
    session.english_progress = { ...initialEnglishProgress(), stage: "participatory" };
    const turn = crypto.randomUUID();
    const first = submit(session, turn);
    expect(first.english_progress).toMatchObject({ stage: "participatory", step: 0, version: 1 });
    expect(first.content).toContain("非真实 AI 评估");
    const retry = demoEnglishReply(session);
    expect(retry).toEqual(first);
    session.english_progress = first.english_progress;
    const revised = submit(session);
    expect(revised.english_progress).toMatchObject({ stage: "participatory", step: 1, version: 2 });
    expect(revised.content).toContain("Evidence");
  });

  it("restores the entire ordered BOPPPS course and rejects later submissions after its final reflection", () => {
    let session = demoEnglishSession("ENG004")!;
    const visited: string[] = [];
    for (let count = 0; !session.english_progress!.completed && count < 40; count++) {
      const stage = session.english_progress!.stage;
      if (visited.at(-1) !== stage) visited.push(stage);
      const reply = submit(session);
      session.english_progress = reply.english_progress;
      session.messages.push({ id: crypto.randomUUID(), role: "assistant", content: reply.content, turn_id: crypto.randomUUID(),
        status: "complete", created_at: "" });
      saveDemoEnglishSession(session);
      session = demoEnglishSession()!;
    }
    expect(visited).toEqual(["bridge", "objectives", "pre_assessment", "participatory", "post_assessment", "summary"]);
    expect(session.english_progress!.completed).toBe(true);
    expect(session.messages.at(-1)!.content).toContain("BOPPPS 学习已完成");
    expect(() => demoEnglishReply(session)).toThrow("已完成");
  });
});

describe("English assistant presentation", () => {
  it("shows six stages in order, only the current stage and its activity, without jump controls", () => {
    const html = renderToStaticMarkup(createElement(EnglishProgress, {
      state: { ...initialEnglishProgress(), stage: "participatory", step: 1 }
    }));
    let position = -1;
    for (const stage of englishStages) {
      const next = html.indexOf(stage.label, position + 1);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("当前活动");
    expect(html).toContain("当前活动 2 / 4");
    expect(html).toContain("Evidence");
    expect(html).toContain("完整任务见上方消息");
    expect(html).not.toContain("Reading broadens our knowledge.");
    expect(html).not.toMatch(/<button|<a\b/);
    const finished = renderToStaticMarkup(createElement(EnglishProgress, {
      state: { ...initialEnglishProgress(), stage: "summary", completed: true }
    }));
    expect(finished).toContain("六阶段学习已完成");
    expect(finished).not.toContain('aria-current="step"');
  });

  it("offers one new-conversation entry on every sidebar surface and two choices in its dialog", () => {
    const english = renderToStaticMarkup(createElement(ParticipantChat, {
      mode: "demo", requireCode: false, initialSettings: defaultSettings, assistantMode: "english"
    }));
    expect(english).toContain('class="chat-title">英语助教');
    expect(english.match(/aria-label="新对话" aria-haspopup="dialog"/g)).toHaveLength(3);
    const picker = english.match(/<dialog\b[^>]*id="new-conversation-dialog"[^]*?<\/dialog>/)![0];
    expect(picker).toContain('aria-labelledby="new-conversation-title"');
    expect(picker.match(/class="conversation-type-option(?: active)?"/g)).toHaveLength(2);
    expect(picker).toMatch(/href="\/"[^]*?对话实验[^]*?href="\/english-assistant"[^]*?英语助教/);
    expect(picker).toMatch(/<a(?=[^>]*href="\/english-assistant")(?=[^>]*aria-current="page")[^>]*>/);
    expect(picker).not.toContain(" open=");
    expect(english).not.toContain("assistant-navigation");
    expect(english).toContain("当前会话");
    const general = renderToStaticMarkup(createElement(ParticipantChat, {
      mode: "demo", requireCode: false, initialSettings: defaultSettings
    }));
    expect(general).toContain('class="chat-title">学习对话');
    expect(general).toContain("学习助手");
    expect(general).toMatch(/<a(?=[^>]*href="\/")(?=[^>]*aria-current="page")[^>]*>/);
  });
});
