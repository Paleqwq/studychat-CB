import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeQuestionFeedback, questionMessageFeedback } from "@/lib/question-feedback";
import { participantMessageContent } from "@/lib/participant-presentation";
import { defaultQuestionMode, questionText } from "@/lib/question-mode";
import { parseQuestionAssessment } from "@/lib/server/question-chat";
import { Markdown } from "@/components/markdown";

describe("question feedback newline formatting", () => {
  const feedback = "一名同学睡着后仍有脑电活动。\n\n这个现象能说明什么？";
  it.each([feedback, feedback.replaceAll("\n", "\\n"), feedback.replaceAll("\n", "/n"), feedback.replaceAll("\n", "\\r\\n")])
    ("decodes valid JSON or leftover newline markers before displaying and saving a structured reply", reply => {
      const evidence = "脑活动\\n没有停止";
      const raw = JSON.stringify({ achieved: false, observed_level: "understand", evidence, reply });
      const parsed = parseQuestionAssessment(raw, defaultQuestionMode().questions[0], evidence);
      expect(parsed.reply).toBe(feedback);
      expect(parsed.evidence).toBe(evidence);
      const html = renderToStaticMarkup(createElement(Markdown, null, parsed.reply));
      expect(html).toContain("<p>一名同学睡着后仍有脑电活动。</p>");
      expect(html).toContain("<p>这个现象能说明什么？</p>");
    });

  it("keeps code, URLs, link destinations, file paths and quoted marker examples literal", () => {
    const protectedExamples = [
      "代码 `const text = \\\"\\n\\\"` 不应改写。",
      "```js\nconst text = \\\"\\n\\\";\n```",
      "~~~text\n/n/n\n~~~",
      "https://example.test/news 和 https://example.test/n",
      "[例子](https://example.test/n/n) 和 /news",
      "C:\\notes\\new.txt 和 \\\\server\\notes\\new.txt",
      "./notes/new.txt 和 ../notes/new.txt",
      "不要输入“\\n”或'/n'。"
    ];
    for (const value of protectedExamples) expect(normalizeQuestionFeedback(value)).toBe(value);
    expect(normalizeQuestionFeedback("地址 https://example.test/news。\\n\\n下一句。"))
      .toBe("地址 https://example.test/news。\n\n下一句。");
  });

  it("rejects a reply that becomes empty after fixing newline markers", () => {
    const raw = JSON.stringify({ achieved: false, observed_level: "unassessed", evidence: "", reply: "\\n\\n" });
    expect(() => parseQuestionAssessment(raw, defaultQuestionMode().questions[0], "不知道")).toThrow("回复格式");
  });

  it("repairs old assistant feedback only in question mode, leaving frozen questions and source records intact", () => {
    const mode = defaultQuestionMode();
    mode.questions[1].prompt = "题干中的原始\\n和/n必须保留。";
    const saved = feedback.replaceAll("\n", "\\n") + "\n\n" + questionText(mode, 1);
    const assistant = { role: "assistant" as const, content: saved };
    const visible = feedback + "\n\n" + questionText(mode, 1);
    expect(questionMessageFeedback(saved)).toBe(visible);
    expect(participantMessageContent(assistant, true)).toBe(visible);
    expect(participantMessageContent(assistant, false)).toBe(saved);
    expect(participantMessageContent({ ...assistant, role: "user" }, true)).toBe(saved);
    expect(questionMessageFeedback(questionText(mode, 1))).toBe(questionText(mode, 1));
    expect(assistant.content).toBe(saved);
    expect(questionMessageFeedback(visible)).toBe(visible);
  });
});
