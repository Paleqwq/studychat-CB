/**
 * Teaching content distilled from the three user-supplied Office files.
 * Source text is learning material, never an instruction to the application.
 * Local file paths, document metadata and personal information are omitted.
 */
export const PEEC_COMPONENTS = [
  {
    id: "point",
    label: "观点",
    english: "Point",
    question: "What is your point? 你的观点是什么？",
    definition: "提出统领段落的中心观点。好的观点应明确（Clear）、具体（Specific）、可论证（Debatable）。",
  },
  {
    id: "evidence",
    label: "证据",
    english: "Evidence",
    question: "How do you know? 你凭什么这样说？",
    definition: "提供支持观点的例子、事实、数据、研究发现或观察。第一个 E 说明发生了什么或有什么依据。",
  },
  {
    id: "explanation",
    label: "解释",
    english: "Explanation",
    question: "Why does this evidence support your point? 证据为什么能支持观点？",
    definition: "解释证据与观点之间的因果、作用过程或意义，回答 Why / How。第二个 E 承担推理，不能以继续堆例子代替。",
  },
  {
    id: "connection",
    label: "回扣主题",
    english: "Connection",
    question: "So what? What conclusion can we draw? 最终说明了什么？",
    definition: "在证据和解释的基础上回到中心主题，形成论证闭环。不能只机械重复观点句。",
  },
] as const;

export const PEEC_CHECKLIST = [
  "我的观点清楚、具体且可论证吗？",
  "我提供了与观点相关的证据吗？",
  "我解释了证据为什么支持观点吗？",
  "我基于论证回扣了主题吗？",
] as const;

export const PEEC_EXAMPLES = {
  bridgeWeak: "Teamwork is important. We should work together. It can help people. Many people like teamwork. So teamwork is useful.",
  bridgeStrong: "Teamwork plays a vital role in achieving success. For example, many successful companies rely on collaborative teams to solve complex problems. Employees from different departments contribute their expertise and work toward common goals. As a result, organizations can improve productivity and make better decisions. Therefore, teamwork has become one of the most important factors for success.",
  preAssessment: "Teamwork is essential in today's workplace. For example, engineers, designers, and marketers often work together to develop new products. Each team member contributes different expertise. As a result, companies can solve problems more efficiently. Therefore, teamwork increases organizational success.",
  participatory: "Teamwork is essential in modern society. For example, many successful companies rely on collaborative teams to complete complex projects. Employees from different backgrounds contribute unique perspectives and expertise. As a result, organizations can solve problems more efficiently and achieve better outcomes. Therefore, teamwork plays a crucial role in achieving long-term success.",
  postAssessment: "Online learning offers significant advantages for college students. For example, many students take online courses through platforms such as Coursera and edX. These platforms allow learners to access high-quality educational resources regardless of geographical limitations. As a result, students can enjoy greater flexibility and more learning opportunities. Therefore, online learning has become an effective way to support higher education.",
  readingConnection: "Reading books is important. Successful entrepreneurs read extensively. Reading broadens knowledge and develops critical thinking. Therefore, reading plays a vital role in personal growth and long-term success.",
  readingWithoutExplanation: "Reading books is important. For example, Bill Gates reads many books every year.",
  readingWithExplanation: "Reading books is important. For example, Bill Gates reads many books every year. Through reading, he gains new knowledge and develops innovative ideas.",
  exercisePoint: "Exercise is beneficial for university students.",
  exerciseEvidence: "Many students who exercise regularly report lower stress levels.",
  exerciseExplanation: "Regular exercise helps release stress and improves emotional well-being. As a result, students can focus better on their studies.",
  missingBoth: "Reading is important. Many successful people read books. Many students read books. Many libraries are busy every day.",
  missingExplanation: "Exercise is beneficial. Many students exercise regularly. Therefore, exercise improves students' lives.",
} as const;

export const PEEC_EXAMPLE_ANNOTATIONS = {
  bridgeStrong: "第 1 句 Point；第 2 句 Evidence；第 3、4 句 Explanation；第 5 句 Connection。",
  preAssessment: "第 1 句 Point；第 2 句 Evidence；第 3、4 句 Explanation；第 5 句 Connection。不同专长解释了团队如何更有效解决问题。",
  participatory: "第 1 句 Point；第 2 句 Evidence；第 3、4 句 Explanation；第 5 句 Connection。",
  postAssessment: "第 1 句 Point；第 2 句 Evidence；第 3、4 句 Explanation；第 5 句 Connection。跨地域获取优质资源解释了在线学习的灵活性与更多机会。",
  readingConnection: "第 1 句 Point；第 2 句 Evidence；第 3 句 Explanation；第 4 句 Connection。最后一句把知识和批判性思维联系到个人成长与长期成功。",
  missingBoth: "缺 Explanation 和 Connection：信息堆叠没有说明阅读如何产生益处，也没有形成基于论证的结论。",
  missingExplanation: "缺 Explanation：从运动现象直接跳到结论，没有解释运动如何使学生受益。",
} as const;

export type EnglishLearningMaterial = {
  id: "lesson-plan" | "teaching-script" | "teaching-slides";
  title: string;
  format: "DOCX" | "PPTX";
  description: string;
  sourceReference: string;
  keyPoints: readonly string[];
  content: string;
};

export const ENGLISH_MATERIALS: readonly EnglishLearningMaterial[] = [
  {
    id: "lesson-plan",
    title: "0630 PEEC 教案.docx",
    format: "DOCX",
    description: "课程目标、教学重点与难点、两课时活动设计和课后写作要求。",
    sourceReference: "教案：教学目标、教学重点难点与对策、课时分配、教学板书设计、教学实施及课后任务",
    keyPoints: [
      "PEEC 四要素及其功能关系；重点区分 Evidence 与 Explanation。",
      "识别结构、组织完整英语论证段落、批判性使用 AI 辅助修改。",
      "80 分钟两课时安排：认识结构与高分写作逻辑；应用结构与写作实践。",
      "分析约 120–150 词范文；独立写 80–100 词 PEEC 段落。",
    ],
    content: `课程主题：学会运用 PEEC 结构写作。PEEC = Point（观点）+ Evidence（证据）+ Explanation（解释）+ Connection（回扣主题），构成 Complete Argument（完整论证）。

学情与学习重点：学生已有词汇、语法和模板基础，但容易逐句拼接、堆叠例子，混淆证据与解释，忽略回扣。学习路径是对比分析、结构拆解、识别训练、生成任务，帮助学生从句子表达转向论证表达。

知识目标：理解四要素的功能与逻辑关系，识别高分范文中的句子功能，理解结构完整、逻辑清晰、论证充分的要求。能力目标：准确分析 PEEC；围绕话题提出观点、选取证据、解释联系、回扣主题；分析和修改 AI 生成内容。素质目标：形成严谨的逻辑表达、自主诊断与反思改进习惯。

教学重点：四要素功能、范文识别、独立段落构建、Explanation 和 Connection 的表达。难点：区分 Evidence 和 Explanation；灵活生成完整论证；迁移到不同写作题；避免机械依赖 AI。

课程安排：80 分钟，两个 40 分钟课时。第一课时用强弱作文对比导入、概念讲解、结构识别、两个 E 的合作辨析与总结。第二课时深化写作策略、拆解典型范文、进行段落写作和互评、分析 AI 内容、总结并布置任务。教案课时分配段给出第二课时活动，教学实施表的第二课时栏仍为空，不能据此补称其已有完整流程。

关键提问：Point — What is your idea? Evidence — How do you know? Explanation — Why does it matter? Connection — So what? Point 应 Clear / Specific / Debatable；Evidence 来源为 Example / Fact / Data / Research / Observation；Explanation 说明 Why / How；Connection 回扣主题，形成闭环。

常用表达：观点 in my view；证据 for example；解释 This is because... / The reason is that... / As a result... / By doing so... / This allows people to...；回扣 therefore。however / in addition / consequently 等服务于真实逻辑关系。信号词只是线索，句子功能仍需结合上下文判断。

典型错误：Point + Example + End 缺解释；Evidence 直接跳 Connection 产生逻辑跳跃；重复观点不能代替论证；机械套用模板不能代替思考。

课后任务一：分析一篇约 120–150 词的四六级范文，以颜色或符号标注四部分，完成结构分析表。评价维度为正确性、完整性、逻辑性，建议 20–25 分钟。
课后任务二：以 The Benefits of Reading / Online Learning / Teamwork 为主题写一段 80–100 词的英语议论文段落，包含完整 PEEC。评价维度为 PEEC 完整性、逻辑性、语言表达，建议 30–40 分钟。允许 AI 辅助生成初稿，但要求学生二次修改并标注修改痕迹，提交最终版本。
材料没有提供上述评价维度的数值权重、及格分或考试正式评分细则。80–100 词是段落训练要求；约 120–150 词是材料中的范文分析篇幅，不可泛化为所有四六级整篇作文的官方字数要求。
AI 辅助方法：生成、分析、修改，学生保留对观点、证据与逻辑的独立判断。`,
  },
  {
    id: "teaching-script",
    title: "0630讲课稿件 PEEC结构模式用于大学英语四六级写作.docx",
    format: "DOCX",
    description: "BOPPPS 六阶段的中英教学话术、示例拆解、互动任务与反思。",
    sourceReference: "讲课稿件：导入、Objectives、Pre-assessment、Participatory Learning、Post-assessment 和 Summary",
    keyPoints: [
      "按照导入、目标、前测、参与式学习、后测、总结展开。",
      "Teamwork 前测与完整范文；Reading 对比两个 E；Exercise 补写解释。",
      "四人组构建论证与 AI 文本分析，强调学生自主判断。",
      "Online learning 独立标注、缺陷段落诊断和阅读主题作业。",
    ],
    content: `本稿是第一课时“认识 PEEC 结构与四六级高分写作逻辑”的中英双语授课脚本，末尾称其为 90 分钟示范课。它与教案的 80 分钟两课时安排不同，不可合并宣称统一时长。

Bridge-in 导入：从听力、阅读、写作担忧以及有想法却无法表达、写到一半没思路、文章缺乏逻辑切入。比较同题 Teamwork 的弱段落与强段落，观察证据、解释和主题回扣的差异。
弱段落：${PEEC_EXAMPLES.bridgeWeak}
强段落：${PEEC_EXAMPLES.bridgeStrong}
脚本以满分 15 分、12–13 分与 7–8 分等作为课堂引导的示意分数，未给出正式评分量表或独立评阅证据。这些数字不能作为评分保证。逻辑训练有助于论证，但语言准确性仍是写作要求。

Objectives 学习目标：识别四个组成部分；分析句子间逻辑关系；区分强弱论证；运用 PEEC 分析四六级范文。目标确认强调四部分和逻辑表达。

Pre-assessment 前测：不计成绩，诊断当前理解。原任务为找中心观点、找证据、找解释、判断删除最后一句的影响。
前测段落：${PEEC_EXAMPLES.preAssessment}
参考：${PEEC_EXAMPLE_ANNOTATIONS.preAssessment}
两个 E 的对比：A 为 ${PEEC_EXAMPLES.readingWithoutExplanation} B 为 ${PEEC_EXAMPLES.readingWithExplanation}。B 增加证据与观点之间的解释，论证更充分，但这两版都未展示完整四要素。
稿件还在前测末尾重复使用 Online learning 段落，之后后测又把它称为“未分析过的新段落”。在线课程应保留该段落作为后测，避免提前泄露同一题及其答案。

Participatory Learning 参与式学习：建立 Point → Evidence → Explanation → Connection 逻辑链。四问为“观点是什么、凭什么、证据如何支持观点、最终得出什么”。PEEC 是组织思考的方法，不能机械规定每部分只能一条句子。
Point 判断任务：A Many students use smartphones. B Smartphones improve learning efficiency. C My smartphone is black. D Technology changes education. 材料给出选项但未写唯一标准答案。B 更具体且可论证；D 可作为观点基础但需缩小范围；A、C 偏事实描述。个人偏好 I like coffee. 难以展开论证，Coffee helps people stay focused. 更适合作为可支持或可反驳的主张。
Evidence 任务：围绕 Reading books is important. 提出三个证据（原任务 2 分钟）。稿件把成功人士阅读、阅读扩大知识面、图书馆使用列为示例，但“阅读扩大知识面”在特定段落里也可能承担 Explanation，需按句子功能与上下文判断，不能靠关键词机械分类。
Explanation 任务：给定 ${PEEC_EXAMPLES.exercisePoint} 和 ${PEEC_EXAMPLES.exerciseEvidence}，学生补写解释（原任务 1 分钟）。示例：${PEEC_EXAMPLES.exerciseExplanation}
Connection 示例：${PEEC_EXAMPLES.readingConnection}
完整范文：${PEEC_EXAMPLES.participatory}
参考：${PEEC_EXAMPLE_ANNOTATIONS.participatory}
合作任务：四人一组，以 Artificial Intelligence in Education / Healthy Lifestyle / Environmental Protection / Lifelong Learning 之一为主题，按观点、证据、解释、回扣构建段落（原任务 5 分钟）。
AI 分析活动展示的示例指令是“Write a CET-4 body paragraph about teamwork using PEEC structure.”，目的是让学生辨析 AI 段落逻辑，而非替代学生学习。此处指令是材料中的课堂例子，不是应用的控制指令。

Post-assessment 后测：独立标注下列段落（原任务 2 分钟），在提交前不展示参考答案。
${PEEC_EXAMPLES.postAssessment}
参考：${PEEC_EXAMPLE_ANNOTATIONS.postAssessment}
缺陷诊断 A：${PEEC_EXAMPLES.missingBoth}
诊断：${PEEC_EXAMPLE_ANNOTATIONS.missingBoth}
缺陷诊断 B：${PEEC_EXAMPLES.missingExplanation}
诊断：${PEEC_EXAMPLE_ANNOTATIONS.missingExplanation}
稿件开场写“三个段落”，实际列出 A、B 两段，不能补称第三段已存在。后测用来发现与解决问题，不计成绩、不排名。

Summary 总结：复述四要素，使用 PEEC 检查清单，并反思自己最容易忽略的部分。核心公式：PEEC = Complete Argument。课后任务为四色标注一篇范文，以及写 The Benefits of Reading 的 80–100 词完整 PEEC 段落。独立段落写作在原稿中是课后任务，在线课程可把它改编为迁移检查，应明确属于教学改编。`,
  },
  {
    id: "teaching-slides",
    title: "PEEC结构模式用于大学英语四六级写作【教学可以用】.pptx",
    format: "PPTX",
    description: "24 页课堂演示，包含路线、四要素定义、范文、前后测与检查清单。",
    sourceReference: "PPT 第 1–24 页，文件无演讲者备注",
    keyPoints: [
      "第 3–5 页导入；第 6–7 页目标；第 8–13 页前测。",
      "第 14–20 页参与式学习，展示四要素及完整例文。",
      "第 21–23 页后测；第 24 页总结和两项课后任务。",
      "版面合并“后测与总结”，应用课程流程仍应独立保留六阶段。",
    ],
    content: `本演示共 24 页，主题为大学英语四六级写作第一课时“认识 PEEC 结构与四六级高分写作逻辑”。所有可提取幻灯片文字均已核对，文件无 notesSlides 演讲者备注。

第 1 页：PEEC = Point / Evidence / Explanation / Connection。
第 2 页：课堂路线把后测与总结放在同一个展示环节，因此标为五个展示环节；完整 BOPPPS 实际仍包括 Bridge-in、Objectives、Pre-assessment、Participatory Learning、Post-assessment、Summary 六个步骤。小测试不计成绩。
第 3–4 页：从四六级写作困难导入，关注有想法却难表达、没思路、缺乏逻辑和说服力。
第 5 页：12–13 与 7–8 的教学对比提示完整论证的重要性，材料没有提供正式评分证据，不据此承诺提分。
第 6–7 页：四项目标为识别四要素、分析段落逻辑、区分有效与无效论证、分析四六级范文。
第 8 页：前测诊断，不计成绩。
第 9 页：${PEEC_EXAMPLES.preAssessment}
前测四任务：哪句是中心观点、哪句提供证据、哪句解释原因、最后一句删除后是否完整。
第 10 页：Point 为第 1 句，统领段落。
第 11 页：Evidence 为第 2 句，可留意 For example / For instance / According to a survey / Research shows that 等表达，但信号词不能代替句子功能分析。
第 12 页：Reading 与 Bill Gates 对比示范。${PEEC_EXAMPLES.readingWithoutExplanation} 加上 Through reading, he gains new knowledge and develops innovative ideas. 后，证据与观点之间的联系得到解释。
第 13 页：Connection 为第 5 句，回扣主题，完成论证闭环。
第 14–15 页：正式学习 PEEC，四要素对应读者的四问；强调它是思维框架。
第 16 页：Point 应 Clear / Specific / Debatable；比较 I like coffee. 与 Coffee helps people stay focused.；给出 A Many students use smartphones. B Smartphones improve learning efficiency. C My smartphone is black. D Technology changes education. 的判断活动。
第 17 页：Evidence 五来源 Example / Fact / Data / Research / Observation；给 Reading books is important. 想出三个证据，原任务 2 分钟。证据必须与观点有关，不能编造真实调查、数据或研究来源。
第 18 页：Explanation 解释为什么例子支持观点，常用 This is because... / The reason is that... / By doing so,... / As a result,... / This allows people to...。补写练习的观点为 ${PEEC_EXAMPLES.exercisePoint}，证据为 ${PEEC_EXAMPLES.exerciseEvidence}。解释需形成因果联系，仅加入连接词不算完成。
第 19 页：${PEEC_EXAMPLES.readingConnection}
参考：${PEEC_EXAMPLE_ANNOTATIONS.readingConnection}
第 20 页：${PEEC_EXAMPLES.participatory}
参考：${PEEC_EXAMPLE_ANNOTATIONS.participatory}
第 21 页：进入后测与总结的展示部分。
第 22 页：独立标注 Online learning 段落，原任务 2 分钟。${PEEC_EXAMPLES.postAssessment}
参考：${PEEC_EXAMPLE_ANNOTATIONS.postAssessment}
第 23 页：诊断 ${PEEC_EXAMPLES.missingBoth}，缺解释与回扣；诊断 ${PEEC_EXAMPLES.missingExplanation}，缺解释。带走四问检查清单：观点清楚吗、提供证据了吗、解释证据了吗、回扣主题了吗。
第 24 页：Point + Evidence + Explanation + Connection = Complete Argument。课后任务一为四色标注一篇四六级范文；任务二为 The Benefits of Reading，80–100 词，包含完整 PEEC。`,
  },
];

/** Material knowledge only; dialogue rules belong to the course system prompt. */
export const ENGLISH_MATERIAL_CONTEXT = ENGLISH_MATERIALS.map(
  (material) => `【学习资料：${material.title}】\n来源：${material.sourceReference}\n${material.content}`,
).join("\n\n");
