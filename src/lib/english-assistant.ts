import { z } from "zod";
import { defaultSettings, type PublicSettings } from "./types";
import { PEEC_EXAMPLES } from "./english-materials";

export const englishStages = [
  { id: "bridge", label: "导入", english: "Bridge-in", description: "从写作问题出发", steps: 1 },
  { id: "objectives", label: "学习目标", english: "Objectives", description: "明确本课要学会什么", steps: 1 },
  { id: "pre_assessment", label: "前测", english: "Pre-assessment", description: "了解已有知识，不要求先答对", steps: 3 },
  { id: "participatory", label: "参与式学习", english: "Participatory Learning", description: "拆解例文，补写并练习", steps: 4 },
  { id: "post_assessment", label: "后测", english: "Post-assessment", description: "独立识别结构并迁移写作", steps: 2 },
  { id: "summary", label: "总结", english: "Summary", description: "回顾收获并安排课后练习", steps: 1 }
] as const;

export type EnglishStage = typeof englishStages[number]["id"];
export const englishWordLimitSchema = z.object({
  min: z.number().int().min(1).max(1000),
  max: z.number().int().min(1).max(1000)
}).strict().refine(limit => limit.max >= limit.min, { message: "词数上限不能小于下限。" });
export const englishActivitySchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  criterion: z.string().trim().min(1).max(2000),
  word_limit: englishWordLimitSchema.nullable().optional()
}).strict();
export type EnglishActivity = z.infer<typeof englishActivitySchema>;
const englishStageContentSchema = z.object({
  description: z.string().trim().min(1).max(300),
  activities: z.array(englishActivitySchema).min(1).max(8)
}).strict();
export const englishCurriculumSchema = z.object({
  bridge: englishStageContentSchema, objectives: englishStageContentSchema,
  pre_assessment: englishStageContentSchema, participatory: englishStageContentSchema,
  post_assessment: englishStageContentSchema, summary: englishStageContentSchema
}).strict().refine(course => englishStages.reduce((total, stage) => total + course[stage.id].activities.length, 0) <= 24,
  { message: "六阶段的活动总数最多为 24。" });
export type EnglishCurriculum = z.infer<typeof englishCurriculumSchema>;
export type EnglishCourseOutline = Record<EnglishStage, { description: string; activities: { title: string }[] }>;
export const englishProgressSchema = z.object({
  stage: z.enum(["bridge", "objectives", "pre_assessment", "participatory", "post_assessment", "summary"]),
  step: z.number().int().min(0).max(7),
  version: z.number().int().nonnegative(),
  completed: z.boolean()
}).strict().superRefine((state, context) => {
  if (state.completed && state.stage !== "summary") {
    context.addIssue({ code: "custom", message: "英语助教进度无效。" });
  }
});
export type EnglishProgress = z.infer<typeof englishProgressSchema>;

export function resolveEnglishCurriculum(course?: EnglishCurriculum | null): EnglishCurriculum {
  return englishCurriculumSchema.parse(course ?? defaultEnglishCurriculum());
}
export function englishCourseOutline(course?: EnglishCurriculum | null): EnglishCourseOutline {
  const curriculum = resolveEnglishCurriculum(course);
  return Object.fromEntries(englishStages.map(stage => [stage.id, {
    description: curriculum[stage.id].description,
    activities: curriculum[stage.id].activities.map(activity => ({ title: activity.title }))
  }])) as EnglishCourseOutline;
}
export function parseEnglishProgress(current: unknown, course?: EnglishCurriculum | null): EnglishProgress {
  const state = englishProgressSchema.parse(current);
  const length = resolveEnglishCurriculum(course)[state.stage].activities.length;
  if (state.step >= length || (state.completed && state.step !== length - 1)) throw new Error("英语学习进度与登记时的课程不一致，请联系管理员。");
  return state;
}

export function initialEnglishProgress(): EnglishProgress {
  return { stage: "bridge", step: 0, version: 0, completed: false };
}

export function englishPublicSettings(disclosure = defaultSettings.disclosure): PublicSettings {
  return {
    title: "英语助教", assistant_name: "英语助教", disclosure,
    welcome_message: "依据三份 PEEC 学习材料，按 BOPPPS 流程学习大学英语四六级段落写作。我们将从导入开始，逐步完成前测、练习和后测。"
  };
}

/** Only the server assessment decides whether the current activity is complete. */
export function advanceEnglishProgress(current: EnglishProgress, achieved: boolean, course?: EnglishCurriculum | null): EnglishProgress {
  const curriculum = resolveEnglishCurriculum(course);
  const state = parseEnglishProgress(current, curriculum);
  if (state.completed) throw new Error("英语助教课程已完成。");
  const next = { ...state, version: state.version + 1 };
  if (!achieved) return next;
  const index = englishStages.findIndex(item => item.id === state.stage);
  if (state.step + 1 < curriculum[state.stage].activities.length) return { ...next, step: state.step + 1 };
  if (state.stage === "summary") return { ...next, completed: true };
  return { ...next, stage: englishStages[index + 1].id, step: 0 };
}

export function defaultEnglishCurriculum(): EnglishCurriculum {
  const activities: Record<EnglishStage, EnglishActivity[]> = {
    bridge: [{
      title: "为什么有例子，段落仍然说不清？",
      prompt: "看看这个段落：\n\n" + PEEC_EXAMPLES.missingBoth + "\n\n它列举了读书的现象，却没有把这些现象与观点联系起来。你写四六级作文时，最常遇到的困难是什么？可以谈谈这一段，也可以说说自己的写作经历。",
      criterion: "学生表达写作困难、对示例的观察或准备参与即可；此阶段不考查知识正确性。"
    }],
    objectives: [{
      title: "本课学习目标",
      prompt: "本课会带你完成四件事：\n\n1. 识别 Point（观点）、Evidence（证据）、Explanation（解释）和 Connection（回扣主题）。\n2. 区分两个 E：证据展示事实或例子，解释说明证据为什么支持观点。\n3. 分析教案、讲课稿和课件中的段落，发现缺少的环节并补写。\n4. 在新题目中独立写出结构完整、逻辑连贯的 PEEC 段落。\n\n学习顺序是导入 → 学习目标 → 前测 → 参与式学习 → 后测 → 总结。前测只用于了解基础，不会要求你先答对。\n\n准备好后，请回复“开始前测”；也可以先说明你对这些学习目标的疑问。",
      criterion: "学生确认准备学习即可完成；如果询问目标，先解释当前目标并等待确认。"
    }],
    pre_assessment: [
      {
        title: "Teamwork 段落：观点与证据",
        prompt: PEEC_EXAMPLES.preAssessment + "\n\n请指出这一段的观点句（Point）和证据句（Evidence）。不确定也可以说出你的初步判断。",
        criterion: "诊断任务：记录学生判断，不因错答或表示不会而阻止前测推进；暂不展示完整结构答案。"
      },
      {
        title: "Teamwork 段落：两个 E 的区别",
        prompt: "继续看刚才的 Teamwork 段落。哪些句子属于 Explanation？它们与 Evidence 的作用有什么不同？不确定可以直接说“不会”。",
        criterion: "诊断任务：了解学生能否把具体团队合作事例与贡献不同专长、提高效率的解释区分开；任何真实作答都应进入下一前测任务。"
      },
      {
        title: "Teamwork 段落：回扣主题",
        prompt: "如果删掉最后一句“Therefore, teamwork increases organizational success.”，这一段的论证闭环会发生什么变化？请简短说明。",
        criterion: "诊断任务：了解学生对 Connection 回扣观点与主题的认识；答错或不会也应结束前测，进入有针对性的教学。"
      }
    ],
    participatory: [
      {
        title: "选择清楚、具体的 Point",
        prompt: "PEEC 从明确的观点开始。比较两个句子：\n\nA. Technology is important.\nB. Technology improves communication efficiency.\n\n哪一句更适合作为议论段落的 Point？请用自己的话说明理由。",
        criterion: "选择 B，并解释其明确论证方向或具体主张，而非只有笼统评价。学生已有前测表现可用来缩短讲解，但本任务需要其自己的解释。"
      },
      {
        title: "为阅读观点寻找 Evidence",
        prompt: "Evidence 可以来自个人经历、具体事例或可靠资料，不必全部是统计数字。不要编造数据。以“Reading broadens our knowledge.”为观点，请提出三个可用于支持它的具体证据或例子，并说明其中一个为什么与这一观点有关。",
        criterion: "提出三项具体且相关的证据/例子，至少解释一项与拓宽知识的联系；泛泛重复观点或虚构来源不能当作合格证据。"
      },
      {
        title: "补上 Explanation，再理解 Connection",
        prompt: "两个 E 承担不同工作：Evidence 给出“有什么事实或例子”；Explanation 说明“为什么它支持观点”。Connection 最后回扣主题。\n\n" + PEEC_EXAMPLES.missingExplanation + "\n\n请在证据句与最后一句之间补写一到两句英文 Explanation，说明运动带来的具体变化为什么支持“Exercise is beneficial.”。",
        criterion: "英文补写建立运动行为与具体身心益处的因果联系，而非重复“运动有益”、只加新事例或只用 Therefore；语言小错可以反馈，不因非关键小错阻断。"
      },
      {
        title: "完成一个 PEEC 段落",
        prompt: "参考三份材料的段落练习，从“AI in education”“healthy lifestyle”“environmental protection”“lifelong learning”中选择一个话题，写出四到六句英文段落。用 P、E1、E2、C 标注观点、证据、解释和回扣主题；每个环节都要支持同一中心观点。",
        criterion: "学生独立形成明确观点、具体相关证据、连接证据与观点的解释、回扣主题的收束；标注正确、语意连贯。可先指出最需补足的一环，让学生修改，不直接代写。"
      }
    ],
    post_assessment: [
      {
        title: "独立分析 Online learning 段落",
        prompt: PEEC_EXAMPLES.postAssessment + "\n\n这次请独立按句子标出 P / E1 / E2 / C，并说明两个 E 各自发挥什么作用。可以用句子序号作答。",
        criterion: "第1句 P，第2句 Evidence，第3和4句 Explanation，第5句 Connection；用自己的话说明平台例子与资源可及性、灵活性和机会之间的论证联系。未达标时只反馈当前缺口并让学生修改，不给完整标注答案。"
      },
      {
        title: "迁移写作：The Benefits of Reading",
        prompt: "请独立写一个 80–100 词的英文段落，主题是“The Benefits of Reading”。使用完整 PEEC 结构，确保观点、具体证据、解释和回扣主题彼此衔接；段落下用一行说明四个环节对应哪些句子。\n\n请按以下格式提交，以便把正文与标注分开：\n\n英文段落：你的英文正文\n\n结构说明：四个环节对应的句子\n\n这是将材料中的阅读作业改编成在线迁移任务。请先完成自己的初稿，助教会根据结构完整性、逻辑性和语言表达提供反馈。",
        criterion: "最新提交的完整英文正文80–100词（不含后附标注），四环节完整且论证相互支持，至少一项具体可信的例子；用自己的段落而非照抄已展示的阅读例文。词数、结构和关键逻辑不足时让学生修改并重新提交完整正文。语言表达应可理解，不把非关键小错误设为额外关卡。"
      }
    ],
    summary: [{
      title: "整理你的 PEEC 写作方法",
      prompt: "PEEC 写作检查清单：\n\n- **Point**：我提出了什么清楚、具体的观点？\n- **Evidence**：我给出了什么相关的事实或例子？\n- **Explanation**：我解释了为什么证据支持观点吗？\n- **Connection**：我把论证回扣到段落或作文主题了吗？\n\n回看三份材料：教案说明学习安排与评价维度，讲课稿解释概念和示例，课件提供结构标注、补写和独立练习。PEEC 是组织论证的工具，不能替代内容与语言质量。\n\n课后可另选一个四六级话题，用同一清单修改一段自己的作文。现在请用自己的话说说两个 E 的区别，以及你下次写作最准备改进的一点。",
      criterion: "在已完成后测的基础上收集学生学习反思，不再新增知识关卡。根据历史给出个性化总结和建议，不承诺考试分数。"
    }]
  };
  activities.post_assessment[1].word_limit = { min: 80, max: 100 };
  return Object.fromEntries(englishStages.map(stage => [stage.id, {
    description: stage.description, activities: activities[stage.id]
  }])) as EnglishCurriculum;
}

export function englishActivity(current: EnglishProgress, course?: EnglishCurriculum | null): EnglishActivity {
  const curriculum = resolveEnglishCurriculum(course);
  const state = parseEnglishProgress(current, curriculum);
  return curriculum[state.stage].activities[state.step];
}

function activityText(state: EnglishProgress, course?: EnglishCurriculum | null): string {
  const stage = englishStages.find(item => item.id === state.stage)!;
  const activity = englishActivity(state, course);
  const wordLimit = activity.word_limit && ["participatory", "post_assessment"].includes(state.stage)
    ? `\n\n英文正文词数：${activity.word_limit.min}–${activity.word_limit.max} 词（不含标题和结构说明）。修改时请重新提交完整正文。`
    : "";
  return `### ${stage.label} · ${activity.title}\n\n${activity.prompt}${wordLimit}`;
}

export function firstEnglishMessage(course?: EnglishCurriculum | null): string {
  return "你好，我是英语助教。我们将依据 PEEC 教案、讲课稿和课件，一步一步练习大学英语四六级写作。\n\n" + activityText(initialEnglishProgress(), course);
}

export function englishTurnContent(before: EnglishProgress, next: EnglishProgress, feedback: string, course?: EnglishCurriculum | null): string {
  const current = parseEnglishProgress(before, course);
  const progress = parseEnglishProgress(next, course);
  const text = feedback.trim();
  if (progress.completed) return [text, "本次 BOPPPS 学习已完成，作答与学习进度已保存。你可以按 PEEC 检查清单继续练习新的话题。"].filter(Boolean).join("\n\n");
  if (current.stage === progress.stage && current.step === progress.step) return text;
  return [text, activityText(progress, course)].filter(Boolean).join("\n\n");
}
