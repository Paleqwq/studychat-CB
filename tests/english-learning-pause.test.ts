import { describe, expect, it } from "vitest";
import { isEnglishLearningPauseRequest } from "@/lib/english-learning-pause";

describe("English student learning pause intent", () => {
  it.each([
    "不想学了", "我不想学了。", "我不想学", "我真的不想学习了", "今天太累了，先不学了",
    "我不想继续学英语了", "我学不下去了", "算了，不学了", "我不想继续了", "我不想再继续了",
    "我没心情做题", "我不想答题了", "先暂停一下", "能不能暂停学习？", "我想休息一下", "让我歇一会儿",
    "先停止会话", "别再问了", "I don't want to study anymore.", "I don’t want to learn anymore.",
    "I need a break.", "I want to stop learning.", "Can we pause?", "Please stop", "pause", "我想继续学习，但现在不想学了",
    "我现在不想继续，但如果明天有时间，我想继续学。"
  ])("pauses on the student's stop request: %s", answer => {
    expect(isEnglishLearningPauseRequest(answer)).toBe(true);
  });
  it.each([
    "不会", "不知道", "懂了", "这题太难了", "我不理解两个E", "我好累但想请你讲清楚解释句", "我不想学了，但我还是要继续学习",
    "我不想继续了，不过我想继续做题", "我不是不想学了，只是没搞懂", "我没有说不想学了", "不学了这句话是什么意思",
    "把“不想学了”翻译成英文", "请解释不想学了是什么意思", "翻译 I don't want to study anymore.",
    "如果我说不想学了会怎么样", "如果学生很累，就说不想学了", "学生说不想学了应该怎么办", "他的意思是暂停功能",
    "这段有‘不同意’和负面词，但是观点很清楚", "我不想学习这个单词，我想写完整段落", "这是暂停功能的示例",
    "E1：学生说不想学了\nE2：这个例子说明学习动力的差异", "英文段落：I don't want to study anymore.\n结构说明：观点句",
    "```${\"text\":\"不想学了\"}```", "`不想学了` 是测试用语", "> 不想学了\n这是引用的句子",
    "The student says \"I don't want to study anymore\".", "If I don't want to study anymore, I may take a break.",
    "I don't want to study anymore, but I want to continue learning.", "The importance of taking a break is evidence.",
    "我想停止浪费时间，继续练习。", "老师说暂停学习会影响进度，我不同意。",
    "I want to stop making mistakes and continue learning.", "I want to take a break from social media and improve my study habits.",
    "我想休息一下，但我还想继续学习。", "老师说'不想学了'是一个例子", "Please pause the music."
  ])("keeps help, quotations, negations and task content in the teaching flow: %s", answer => {
    expect(isEnglishLearningPauseRequest(answer)).toBe(false);
  });
});
