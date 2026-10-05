"use client";
import { BookOpen } from "lucide-react";
import { bloomLevels, bloomLabels, type Question, type QuestionMode } from "@/lib/question-mode";

export function QuestionModeSettings({ value, onChange, onOpenPrompts }: {
  value: QuestionMode; onChange: (value: QuestionMode) => void; onOpenPrompts: () => void;
}) {
  function edit(index: number, patch: Partial<Question>) {
    onChange({ ...value, questions: value.questions.map((q, i) => i === index ? { ...q, ...patch } : q) });
  }
  return <>
    <section className="settings-card compact">
      <div className="switch-row"><div><h2>题目问答模式</h2><p>先逐题引导，再按原顺序独立重答同样三题。</p></div>
        <label className="toggle"><input type="checkbox" aria-label="开启题目问答模式" checked={value.enabled}
          onChange={e => onChange({ ...value, enabled: e.target.checked })}/><span/></label>
      </div>
      <ol className="question-flow"><li>登记后程序自动发送第 1 题，无须学生先发消息。</li>
        <li>第一轮：学生回答 → AI 按基础提示词进行 Bloom 引导 → 达标后程序发送下一题。</li>
        <li>第二轮：原样重发第 1、2、3 题，每题收到一次非空作答即继续，不提示、不纠错、不评分。</li>
        <li>最后一题作答保存后结束；刷新和重试不重新开始。</li></ol>
      <p className="small-note">开启不自动替换已有提示词。请到「AI 提示词 → 预设基础模型提示词」主动应用 Bloom 预设，或保留自己的引导规则。达标判定由模型完成，不等同于经过人工验证的测量量表。</p>
      <button type="button" className="button secondary small" onClick={onOpenPrompts}>前往基础提示词预设</button>
      <p className="small-note">保存并发布后仅对新登记会话生效，四组共用相同题目和目标。已有会话的题目、模式、提示词及进度不变。首次使用须先执行数据库迁移 004_question_mode.sql。</p>
    </section>
    {value.questions.map((question, index) => <section className="settings-card" key={index}>
      <div className="card-heading"><span className="section-icon"><BookOpen size={19}/></span><div><h2>第 {index + 1} 题</h2><p>两轮使用完全相同的标题与题干，参考要点只供第一轮引导判定使用。</p></div></div>
      <label className="field"><span>第 {index + 1} 题标题</span><input maxLength={120} value={question.title} onChange={e => edit(index, { title: e.target.value })}/></label>
      <label className="field"><span>第 {index + 1} 题题干</span><textarea rows={5} maxLength={4000} value={question.prompt} onChange={e => edit(index, { prompt: e.target.value })}/>
        <small>学生会看到这段原文。更换题目时也请核对目标与参考要点，无须修改流程代码。</small></label>
      <label className="field"><span>第 {index + 1} 题目标 Bloom 层级</span><select value={question.target_level} onChange={e => edit(index, { target_level: e.target.value as Question["target_level"] })}>
        {bloomLevels.map(level => <option key={level} value={level}>{bloomLabels[level]} · {level}</option>)}
      </select><small>从学生当前水平自适应引导，已展示的低层能力不机械重复；达到所选目标即可进入下一题。</small></label>
      <label className="field"><span>第 {index + 1} 题教师参考要点 / 达标依据</span><textarea rows={7} maxLength={6000} value={question.reference} onChange={e => edit(index, { reference: e.target.value })}/>
        <small>写明准确知识、可接受答案、关键误区及目标层级证据。不直接发送给学生；模型仍可能被诱导复述，所以不要存放机密。</small></label>
    </section>)}
  </>;
}
