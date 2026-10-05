import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { BasePromptPresets } from "@/components/base-prompt-presets";
import { QuestionModeSettings } from "@/components/question-mode-settings";
import { QuestionProgress } from "@/components/question-progress";
import { demoConfig, saveDemoConfig, demoSession, saveDemoSession, demoQuestionReply, demoRecord } from "@/lib/demo";
import { defaultQuestionMode, initialQuestionProgress, questionText } from "@/lib/question-mode";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
describe("explicit base prompt presets and question-mode presentation", () => {
  it("does not replace an existing prompt simply by rendering the preset area", () => {
    const apply = vi.fn();
    const html = renderToStaticMarkup(createElement(BasePromptPresets, { value: "existing production prompt", onApply: apply }));
    expect(html).toContain("预设基础模型提示词"); expect(html).toContain("保留当前提示词");
    expect(html).toContain("不会自动替换或发布"); expect(html).toContain("不修改人格提示词");
    expect(apply).not.toHaveBeenCalled();
  });
  it("provides three editable questions and links to the base preset instead of adding a competing guidance field", () => {
    const html = renderToStaticMarkup(createElement(QuestionModeSettings, { value: defaultQuestionMode(), onChange: vi.fn(), onOpenPrompts: vi.fn() }));
    expect(html).toContain("前往基础提示词预设");
    for (const number of [1, 2, 3]) expect(html).toContain("第 " + number + " 题目标 Bloom 层级");
    expect(html).toContain("不提示、不纠错、不评分"); expect(html).toContain("已有会话");
  });
  it("shows only the round and question number, or completion, to participants", () => {
    for (const phase of ["guided", "retest", "completed"] as const) {
      const html = renderToStaticMarkup(createElement(QuestionProgress, { state: { ...initialQuestionProgress(), phase } }));
      expect(html).toContain('role="status"'); expect(html).not.toMatch(/deepseek|chatgpt|人格|引导|独立|提示|点评|实验|研究|Bloom/);
      if (phase === "completed") {
        expect(html).toContain("两轮问答已完成");
        expect(html).toContain("所有作答已保存。");
      } else {
        expect(html).toContain(`${phase === "guided" ? "第一轮" : "第二轮"} · 第 1 / 3 题`);
        expect(html).not.toContain("<span>");
      }
    }
  });
  it("preserves detailed progress labels and instructions for administrators only", () => {
    const labels = { guided: "第一轮 · 引导学习 · 第 1 / 3 题", retest: "第二轮 · 独立作答 · 第 1 / 3 题", completed: "两轮问答已完成" };
    const descriptions = { guided: "先作答，再根据引导完善想法。", retest: "本轮独立作答，不提供提示或点评。", completed: "所有作答已保存，无须继续发送消息。" };
    for (const phase of ["guided", "retest", "completed"] as const) {
      const state = { ...initialQuestionProgress(), phase };
      const html = renderToStaticMarkup(createElement(QuestionProgress, { state, audience: "admin" }));
      expect(html).toContain(labels[phase]);
      expect(html).toContain(descriptions[phase]);
      const participant = renderToStaticMarkup(createElement(QuestionProgress, { state, audience: "participant" }));
      expect(participant).toBe(renderToStaticMarkup(createElement(QuestionProgress, { state })));
      expect(participant).not.toContain(descriptions[phase]);
    }
  });
  it("simulates and restores both rounds on the frozen questions while leaving the admin base prompt intact", () => {
    const config = demoConfig(); const originalPrompt = config.base_prompt;
    config.question_mode = { ...defaultQuestionMode(), enabled: true }; saveDemoConfig(config);
    let session = demoSession("BLOOMTEST")!;
    expect(session.messages).toHaveLength(1); expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].content).toContain(questionText(config.question_mode, 0));
    const modified = demoConfig(); modified.question_mode!.questions[0].prompt = "new draft question"; saveDemoConfig(modified);
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      const reply = demoQuestionReply(session)!;
      seen.push(reply.content);
      session.question_progress = reply.question_progress; saveDemoSession(session); session = demoSession()!;
    }
    expect(session.question_progress?.phase).toBe("completed");
    expect(seen.join("\n")).toContain(questionText(config.question_mode, 0));
    expect(seen.join("\n")).not.toContain("new draft question");
    expect(seen.join("\n")).toContain("演示流程，非真实 AI 评估");
    expect(demoConfig().base_prompt).toBe(originalPrompt);
    expect(demoRecord()?.question_progress?.phase).toBe("completed");
    expect(() => demoQuestionReply(session)).toThrow("已完成");
  });
});
