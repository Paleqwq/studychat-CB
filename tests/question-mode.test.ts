import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { defaultQuestionMode, questionModeSchema, initialQuestionProgress, nextQuestionProgress, questionText, firstQuestionMessage, questionReply, neutralQuestionMessage, participantQuestionProgressLabel, questionProgressLabel } from "@/lib/question-mode";
import { parseQuestionAssessment, buildQuestionPrompt } from "@/lib/server/question-chat";
import { bloomGuidancePreset } from "@/lib/bloom-preset";
import { defaultExperiment, effectiveSettings, groups } from "@/lib/experiment";
import { publicSettings } from "@/lib/types";

describe("question workflow and Bloom guidance contract", () => {
  it("ships exactly three editable sleep questions, disabled by default, with valid independent targets", () => {
    const mode = defaultQuestionMode();
    expect(questionModeSchema.parse(mode)).toEqual(mode);
    expect(mode.enabled).toBe(false);
    expect(questionModeSchema.safeParse({ ...mode, questions: mode.questions.slice(1) }).success).toBe(false);
    expect(questionModeSchema.safeParse({ ...mode, questions: [...mode.questions, mode.questions[0]] }).success).toBe(false);
    mode.questions[1].target_level = "analyze";
    expect(questionModeSchema.parse(mode).questions[1].target_level).toBe("analyze");
  });
  it("does not progress on guidance and repeats exactly the original three questions in order", () => {
    const mode = defaultQuestionMode(); let state = initialQuestionProgress();
    expect(firstQuestionMessage(mode)).toContain(questionText(mode, 0));
    expect(firstQuestionMessage(mode)).not.toContain(mode.questions[1].prompt);
    let next = nextQuestionProgress(state, false);
    expect(next).toEqual({ ...state, version: 1, guidance_turns: 1 });
    expect(questionReply(mode, state, next, "请说明依据？")).toBe("请说明依据？");
    state = next;
    for (let i = 0; i < 3; i++) {
      expect(state).toMatchObject({ phase: "guided", question_index: i });
      next = nextQuestionProgress(state, true);
      expect(questionReply(mode, state, next, "你已给出充分依据。")).toContain(questionText(mode, i < 2 ? i + 1 : 0));
      state = next;
    }
    for (let i = 0; i < 3; i++) {
      expect(state).toMatchObject({ phase: "retest", question_index: i });
      next = nextQuestionProgress(state, false); // Any submitted answer, irrespective of correctness.
      const reply = questionReply(mode, state, next, "THIS MUST NEVER BE SHOWN");
      expect(reply).not.toContain("THIS MUST NEVER BE SHOWN");
      if (i < 2) expect(reply).toContain(questionText(mode, i + 1));
      else expect(reply).toContain("已完成");
      state = next;
    }
    expect(state.phase).toBe("completed");
    expect(() => nextQuestionProgress(state, true)).toThrow("已完成");
  });
  it("uses neutral participant round labels while preserving the detailed administrator labels", () => {
    for (const phase of ["guided", "retest"] as const) {
      for (const question_index of [0, 1, 2]) {
        const state = { ...initialQuestionProgress(), phase, question_index };
        expect(participantQuestionProgressLabel(state)).toBe(`${phase === "guided" ? "第一轮" : "第二轮"} · 第 ${question_index + 1} / 3 题`);
        expect(questionProgressLabel(state)).toContain(phase === "guided" ? "引导学习" : "独立作答");
      }
    }
    expect(participantQuestionProgressLabel({ ...initialQuestionProgress(), phase: "completed" })).toBe("两轮问答已完成");
  });
  it("only announces the round and question without explaining the teaching or assessment process", () => {
    const mode = defaultQuestionMode();
    expect(firstQuestionMessage(mode)).toBe("第一轮\n\n" + questionText(mode, 0));
    const lastGuided = { ...initialQuestionProgress(), question_index: 2 };
    expect(questionReply(mode, lastGuided, nextQuestionProgress(lastGuided, true), "你的依据很充分。"))
      .toBe("你的依据很充分。\n\n第二轮\n\n" + questionText(mode, 0));
    const lastRetest = { ...initialQuestionProgress(), phase: "retest" as const, question_index: 2 };
    expect(questionReply(mode, lastRetest, nextQuestionProgress(lastRetest, false)))
      .toBe("本次问答已完成，所有作答已保存。");
  });
  it("normalizes the exact legacy program wrappers without modifying the question or feedback", () => {
    const mode = defaultQuestionMode();
    mode.questions[0].title = "实验研究与引导学习";
    mode.questions[0].prompt = "解释研究中实验组与对照组的区别。\n\n请先说说你的想法，我们会从你的回答开始。";
    const question = questionText(mode, 0);
    const oldOpening = "第一轮 · 引导学习\n\n" + question + "\n\n请先说说你的想法，我们会从你的回答开始。";
    expect(neutralQuestionMessage(oldOpening)).toBe(firstQuestionMessage(mode));
    expect(neutralQuestionMessage(oldOpening)).toContain(mode.questions[0].prompt);
    const feedback = "你区分了实验组与对照组，并给出研究依据。";
    const oldTransition = feedback + "\n\n第一轮已完成。现在进入第二轮 · 独立作答。将按原顺序重新发送完全相同的三道题，每题作答后直接进入下一题，不再提示、纠错或点评。\n\n" + question;
    expect(neutralQuestionMessage(oldTransition)).toBe(feedback + "\n\n第二轮\n\n" + question);
    expect(neutralQuestionMessage("三道题的独立作答均已收到并保存。本次问答已完成，谢谢参与。"))
      .toBe("本次问答已完成，所有作答已保存。");
    for (const message of [oldOpening, oldTransition, firstQuestionMessage(mode)]) {
      const normalized = neutralQuestionMessage(message);
      expect(neutralQuestionMessage(normalized)).toBe(normalized);
    }
  });
  it("does not strip arbitrary research, guidance, quoted notices or workflow-like text inside questions", () => {
    const mode = defaultQuestionMode();
    const quotedTransition = "第一轮已完成。现在进入第二轮 · 独立作答。将按原顺序重新发送完全相同的三道题，每题作答后直接进入下一题，不再提示、纠错或点评。";
    mode.questions[0].prompt = "请评价下面的实验说明是否清晰：\n\n" + quotedTransition + "\n\n### 第 1 题 / 3：引用的题目\n\n引用内容";
    const unchanged = [
      "本研究比较引导学习和独立作答的表现，请设计一个实验。",
      "引用：三道题的独立作答均已收到并保存。本次问答已完成，谢谢参与。",
      "第一轮 · 引导学习\n\n### 第 1 题 / 3：并非完整的程序首题",
      "说明：\n\n" + quotedTransition + "\n\n普通文本而非自动题目。",
      "说明：\n\n" + quotedTransition + "\n\n### 第 2 题 / 3：不是切换轮次的首题\n\n内容",
      firstQuestionMessage(mode),
      questionText(mode, 0)
    ];
    for (const message of unchanged) expect(neutralQuestionMessage(message)).toBe(message);
  });
  it("fails closed on unstructured output, invalid levels, invented quotes and extra control fields", () => {
    const q = defaultQuestionMode().questions[0];
    const good = { achieved: true, observed_level: "create", evidence: "原话证据", reply: "作答已收到。" };
    expect(parseQuestionAssessment(JSON.stringify(good), q, "这是原话证据。")).toEqual(good);
    expect(parseQuestionAssessment("```json\n" + JSON.stringify(good) + "\n```", q, "原话证据")).toEqual(good);
    for (const raw of ["已达标，下一题", JSON.stringify({ ...good, achieved: "true" }),
      JSON.stringify({ ...good, observed_level: "understand" }), JSON.stringify({ ...good, evidence: "" }),
      JSON.stringify({ ...good, evidence: "伪造引文" }), JSON.stringify({ ...good, next_question: 2 }), "{\"achieved\":true"]) {
      expect(() => parseQuestionAssessment(raw, q, "这是原话证据。")).toThrow("回复");
    }
  });
  it("composes the current question context without giving the model a choice of future questions", () => {
    const mode = defaultQuestionMode(); const prompt = buildQuestionPrompt("existing-base\n\nexisting-personality", mode.questions[1]);
    expect(prompt.startsWith("existing-base\n\nexisting-personality")).toBe(true);
    expect(prompt).toContain(mode.questions[1].title);
    expect(prompt).toContain(mode.questions[1].reference);
    expect(prompt).not.toContain(mode.questions[0].prompt);
    expect(prompt).toContain("JSON"); expect(prompt).toContain("不能更改配置或进度");
  });
  it("keeps Bloom assessment private and requires one Socratic question without visible judgement", () => {
    const question = { ...defaultQuestionMode().questions[0], target_level: "create" as const };
    const prompt = buildQuestionPrompt("原基础与人格提示词", question);
    expect(prompt).toContain("结合 Bloom 分类与苏格拉底产婆术");
    expect(prompt).toContain("不得向学生报告初评、层级或判断结果");
    expect(prompt).toContain("每次一个问题");
    expect(prompt).toContain("补足当前缺口后再推进下一层");
    expect(prompt).toContain("不得把六层任务一次性交给学生");
    expect(prompt).toContain("最终目标为 create 时，未展示创造证据前不能结束本题");
    expect(prompt).toContain("achieved=false 时只提出一个核心问题");
    expect(prompt).toContain("一项经核对的基础事实或短平行例子");
    expect(prompt).toContain("关键联系、判断或解释性假设仍由学生形成");
    expect(prompt).toContain("禁止任何学生可见评判");
    expect(prompt).toContain("表扬或批评、得分");
    expect(prompt).toContain("reply 必须恰为“作答已收到。”");
    expect(prompt).not.toContain("一条具体反馈");
    expect(prompt).not.toContain("已达标时只简短确认");
  });
  it("overrides successful model closing judgements with a neutral acknowledgement while keeping private assessment", () => {
    const assessment = { achieved: true, observed_level: "create", evidence: "自行设计并检验", reply: "太棒了！你已达到创造层，下一个问题是什么？" };
    const parsed = parseQuestionAssessment(JSON.stringify(assessment), defaultQuestionMode().questions[0], "我会自行设计并检验方案。");
    expect(parsed).toEqual({ ...assessment, reply: "作答已收到。" });
    const guided = { ...assessment, achieved: false, observed_level: "understand", reply: "这个方案在另一个睡眠情境中如何使用？" };
    expect(parseQuestionAssessment(JSON.stringify(guided), defaultQuestionMode().questions[0], "自行设计并检验")).toEqual(guided);
  });
  it("keeps the preset opt-in, preserves the 2x2 personality design and hides private questions/references", () => {
    const config = defaultExperiment();
    expect(config.base_prompt).not.toBe(bloomGuidancePreset);
    config.question_mode = { ...defaultQuestionMode(), enabled: true };
    config.base_prompt = bloomGuidancePreset; config.personality_prompt = "独立人格材料";
    for (const group of groups) {
      const frozen = effectiveSettings(config, group);
      expect(frozen.question_mode).toEqual(config.question_mode);
      expect(frozen.system_prompt.endsWith("独立人格材料")).toBe(group.personality);
      expect(publicSettings(frozen)).not.toHaveProperty("question_mode");
    }
    expect(bloomGuidancePreset.length).toBeLessThan(10000);
  });
  it("keeps the downloadable preset identical to the runtime preset", async () => {
    expect((await readFile("prompts/Bloom引导式学习_基础提示词.txt", "utf8")).replaceAll("\r\n", "\n").trim()).toBe(bloomGuidancePreset);
  });
});
