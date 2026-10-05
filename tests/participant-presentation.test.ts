import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { participantSettings, participantMessageContent } from "@/lib/participant-presentation";
import { defaultSettings, publicSettings } from "@/lib/types";
import { defaultQuestionMode, questionText, firstQuestionMessage } from "@/lib/question-mode";
import { ParticipantChat } from "@/components/participant-chat";
import { Brand, SetupNotice } from "@/components/shared";
import { buildQuestionPrompt } from "@/lib/server/question-chat";
import { databaseError, HttpError } from "@/lib/server/http";
import { questionDatabaseError } from "@/lib/server/question-session";

const legacy = {
  ...defaultSettings, title: "研究对话", assistant_name: "研究助手",
  disclosure: "学号用于关联本项研究的对话记录。对话将被保存并用于研究；请勿在聊天中输入姓名、联系方式或其他敏感个人信息。"
};
describe("neutral student presentation", () => {
  it("presents both new defaults and legacy frozen labels neutrally while retaining data and privacy information", () => {
    const original = structuredClone(legacy);
    const visible = participantSettings(legacy);
    expect(visible).toEqual(publicSettings(defaultSettings));
    expect(Object.keys(visible).sort()).toEqual(["assistant_name", "disclosure", "title", "welcome_message"]);
    expect(JSON.stringify(visible)).not.toMatch(/研究|实验|引导|Bloom|被试/);
    expect(visible.disclosure).toContain("学号用于关联本次对话记录");
    expect(visible.disclosure).toContain("对话将自动保存");
    expect(visible.disclosure).toContain("敏感个人信息");
    expect(legacy).toEqual(original);
    expect(publicSettings(legacy).title).toBe("研究对话"); // Admin/frozen config is untouched.
    expect(participantSettings(visible)).toEqual(visible);
  });
  it("preserves custom notices and course content instead of blindly filtering words", () => {
    const custom = { title: "睡眠课程", assistant_name: "小助手", welcome_message: "请比较两项睡眠研究的发现。",
      disclosure: "本课程保存作答30天。若需删除，请联系老师。" };
    expect(participantSettings(custom)).toEqual(custom);
  });
  it("adapts legacy automatic messages only for assistant messages in question mode", () => {
    const mode = defaultQuestionMode();
    const content = "第一轮 · 引导学习\n\n" + questionText(mode, 0) + "\n\n请先说说你的想法，我们会从你的回答开始。";
    const assistant = { role: "assistant" as const, content };
    expect(participantMessageContent(assistant, true)).toBe(firstQuestionMessage(mode));
    expect(participantMessageContent(assistant, false)).toBe(content);
    expect(participantMessageContent({ role: "user", content }, true)).toBe(content);
    expect(assistant.content).toBe(content);
    const knowledge = { role: "assistant" as const, content: "这项睡眠实验的结果可以支持你的判断。" };
    expect(participantMessageContent(knowledge, true)).toBe(knowledge.content);
  });
  it("keeps initial and help labels neutral while allowing the requested experiment choice", () => {
    const html = renderToStaticMarkup(createElement(ParticipantChat, { mode: "live", requireCode: false, initialSettings: legacy }));
    const outsidePicker = html.replace(/<dialog\b[^>]*id="new-conversation-dialog"[^]*?<\/dialog>/, "");
    expect(outsidePicker.replaceAll("对话实验", "")).not.toMatch(/研究|实验|引导|Bloom|被试/);
    expect(html).toContain("查看使用说明");
    expect(html).toContain("关闭使用说明");
    expect(html).toContain("会话编号");
    expect(html).toContain("对话将自动保存");
  });
  it("keeps administrative terminology private while neutralizing the unconfigured student entry", () => {
    expect(renderToStaticMarkup(createElement(Brand, { admin: true }))).toContain("研究控制台");
    expect(renderToStaticMarkup(createElement(SetupNotice))).not.toMatch(/研究|实验|被试/);
  });
  it.each(["STUDY_PAUSED", "NOT_CONFIGURED", "SESSION_LIMIT", "IDENTITY_BOUND", "LEGACY_SESSION", "STUDENT_UNAVAILABLE", "QUESTION_ALREADY_STARTED", "INVALID_QUESTION_ASSESSMENT"])
    ("keeps student-facing %s errors neutral", code => {
      try { databaseError(code); }
      catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as Error).message).not.toMatch(/研究|实验|引导|被试|分组|达标/);
      }
    });
  it("requests neutral model replies without changing the frozen prompts or instructing the model to deny facts", () => {
    const prompt = buildQuestionPrompt("原基础提示词\n\n原人格提示词", defaultQuestionMode().questions[0]);
    expect(prompt.startsWith("原基础提示词\n\n原人格提示词")).toBe(true);
    expect(prompt).toContain("不主动介绍研究、实验、分组、Bloom 层级");
    expect(prompt).toContain("不编造、不否认");
  });
  it("does not expose teacher-only configuration requirements from the student question API", () => {
    expect(() => questionDatabaseError({ message: "INVALID_QUESTION_MODE" })).toThrow("题目暂时无法读取，请联系管理员核验配置。");
    expect(() => databaseError("INVALID_QUESTION_MODE")).toThrow("目标 Bloom 层级");
  });
});
