import { z } from "zod";

export const bloomLevels = ["remember", "understand", "apply", "analyze", "evaluate", "create"] as const;
export type BloomLevel = typeof bloomLevels[number];
export const bloomLabels: Record<BloomLevel, string> = {
  remember: "记忆", understand: "理解", apply: "应用", analyze: "分析", evaluate: "评价", create: "创造"
};
export const questionModeSchema = z.object({
  enabled: z.boolean(),
  questions: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(4000),
    reference: z.string().trim().min(1).max(6000),
    target_level: z.enum(bloomLevels)
  }).strict()).length(3)
}).strict();
export type QuestionMode = z.infer<typeof questionModeSchema>;
export type Question = QuestionMode["questions"][number];
export const questionProgressSchema = z.object({
  phase: z.enum(["guided", "retest", "completed"]),
  question_index: z.number().int().min(0).max(2),
  guidance_turns: z.number().int().nonnegative(),
  version: z.number().int().nonnegative()
}).strict();
export type QuestionProgress = z.infer<typeof questionProgressSchema>;
export type QuestionAssessment = {
  achieved: boolean;
  observed_level: BloomLevel | "unassessed";
  evidence: string;
  reply: string;
};
export const assessmentSchema = z.object({
  achieved: z.boolean(), observed_level: z.enum(["unassessed", ...bloomLevels]),
  evidence: z.string().trim().max(300), reply: z.string().trim().min(1).max(3000)
}).strict();

export function defaultQuestionMode(): QuestionMode {
  return { enabled: false, questions: [
    {
      title: "睡着以后，大脑整晚都一样吗？",
      prompt: "一位同学说：‘睡着以后，大脑整晚都处于同一种状态，而且只有快速眼动睡眠（REM）阶段才会做梦。’请根据《心理学与生活》的睡眠知识回应这一说法，解释你的依据。",
      reference: "《心理学与生活》第20版，第127、130页。睡眠包含NREM与REM并周期性交替；深睡眠较集中于前半夜，后半夜REM增多。NREM也可能做梦，不能把REM等同于唯一做梦阶段。若涉及估算，教材给出的REM占比约20%–25%，8小时对应1.6–2小时，只是估计而非个人测量。理解需解释阶段交替；应用可判读新睡眠记录或进行比例估算；分析需比较前后半夜；评价需分别核查两个主张及证据；创造可设计面向初学者的一夜睡眠导览或讲解方案，解释组织依据和如何检查其科学性。采用该版教材的术语，不把教材分期说成所有现行标准。",
      target_level: "create"
    },
    {
      title: "为了考好，应该多复习还是多睡觉？",
      prompt: "小林平日凌晨2点睡、早晨7点起，周末凌晨3点睡、中午12点起。考试前他计划通宵复习，理由是：‘复习时间越长，考试表现一定越好。’请运用睡眠章节的知识评价他的想法，并提出有依据的复习与睡眠安排。",
      reference: "《心理学与生活》第20版，第126–128、133页。昼夜节律与睡眠时机有关；睡眠参与记忆巩固，REM与NREM均有作用；睡眠不足可能损害注意和工作记忆。应区分睡眠时长不足与作息不规律，权衡额外复习时间与认知代价，不保证调整睡眠必然提高分数。分析层需区分问题及影响；评价层需依据标准、教材证据和局限权衡通宵；创造层需整合出可行的一周计划，并用白天困倦、次日回忆表现等指标检验，不设计刻意剥夺睡眠的实验。不要求具体医疗诊断或药物建议。",
      target_level: "create"
    },
    {
      title: "都说做噩梦了，一定是同一种现象吗？",
      prompt: "以下为虚构案例：甲在临近天亮时被恐怖的梦惊醒，能清楚描述梦中被追赶的情节。乙在一夜睡眠的前段突然惊叫、表现强烈恐惧，第二天却几乎不记得发生了什么。有人认为：‘他们都害怕了，所以都是同一种噩梦。’你如何判断？请说明依据，以及还需要了解什么信息。",
      reference: "《心理学与生活》第20版，第130页。甲更符合噩梦，乙更符合夜惊。夜惊通常发生于一夜前段的NREM睡眠，事后往往缺乏回忆。应比较发生时间、当时表现和事后回忆，区分观察与推断；不能仅凭恐惧断言REM，也不能根据短案例作临床诊断。评价层需检查证据充分性与缺失信息；创造层可设计含至少四项信息的课堂模拟夜间事件记录表，解释字段如何帮助区分现象及记录局限。这里仅作教材概念辨析，不提供诊疗方案。",
      target_level: "create"
    }
  ] };
}

export function initialQuestionProgress(): QuestionProgress {
  return { phase: "guided", question_index: 0, guidance_turns: 0, version: 0 };
}
// Mirrored in save_question_reply, with a database lock and compare-and-swap.
export function nextQuestionProgress(state: QuestionProgress, achieved: boolean): QuestionProgress {
  if (state.phase === "completed") throw new Error("题目问答已完成。");
  const next = { ...state, version: state.version + 1 };
  if (state.phase === "guided" && !achieved) return { ...next, guidance_turns: state.guidance_turns + 1 };
  if (state.question_index < 2) return { ...next, question_index: state.question_index + 1, guidance_turns: 0 };
  if (state.phase === "guided") return { ...next, phase: "retest", question_index: 0, guidance_turns: 0 };
  return { ...next, phase: "completed", guidance_turns: 0 };
}
export function questionText(mode: QuestionMode, index: number): string {
  const question = mode.questions[index];
  return `### 第 ${index + 1} 题 / 3：${question.title}\n\n${question.prompt}`;
}
export function firstQuestionMessage(mode: QuestionMode): string {
  return "第一轮\n\n" + questionText(mode, 0);
}
export function questionReply(mode: QuestionMode, before: QuestionProgress, after: QuestionProgress, feedback = ""): string {
  if (before.phase === "guided" && after.phase === "guided" && before.question_index === after.question_index) return feedback;
  if (after.phase === "completed") return "本次问答已完成，所有作答已保存。";
  if (before.phase === "guided" && after.phase === "retest") {
    return `${feedback}\n\n第二轮\n\n${questionText(mode, 0)}`;
  }
  return (before.phase === "retest" ? "作答已收到并保存。" : feedback) + "\n\n" + questionText(mode, after.question_index);
}
// Only normalize known, program-generated wrappers from saved assistant messages.
// Do not filter arbitrary words or rewrite the question body and feedback.
export function neutralQuestionMessage(content: string): string {
  const opening = "第一轮 · 引导学习\n\n";
  const ending = "\n\n请先说说你的想法，我们会从你的回答开始。";
  if (content.startsWith(opening + "### 第 1 题 / 3：") && content.endsWith(ending)) {
    return "第一轮\n\n" + content.slice(opening.length, -ending.length);
  }
  const completed = "三道题的独立作答均已收到并保存。本次问答已完成，谢谢参与。";
  if (content === completed) return "本次问答已完成，所有作答已保存。";

  const transition = "\n\n第一轮已完成。现在进入第二轮 · 独立作答。将按原顺序重新发送完全相同的三道题，每题作答后直接进入下一题，不再提示、纠错或点评。\n\n";
  const heading = content.search(/^### 第 [1-3] 题 \/ 3：/m);
  // The wrapper must immediately precede the first question heading. A matching
  // phrase inside the question itself is content, not a workflow instruction.
  if (heading >= transition.length && content.startsWith("### 第 1 题 / 3：", heading)
    && content.slice(heading - transition.length, heading) === transition) {
    return content.slice(0, heading - transition.length) + "\n\n第二轮\n\n" + content.slice(heading);
  }
  return content;
}
export function participantQuestionProgressLabel(state: QuestionProgress): string {
  return state.phase === "completed" ? "两轮问答已完成" :
    `${state.phase === "guided" ? "第一轮" : "第二轮"} · 第 ${state.question_index + 1} / 3 题`;
}
export function questionProgressLabel(state: QuestionProgress): string {
  return state.phase === "completed" ? "两轮问答已完成" :
    `${state.phase === "guided" ? "第一轮 · 引导学习" : "第二轮 · 独立作答"} · 第 ${state.question_index + 1} / 3 题`;
}
