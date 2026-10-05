"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { BookOpen, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { defaultEnglishCurriculum, englishStages, type EnglishActivity, type EnglishCurriculum, type EnglishStage } from "@/lib/english-assistant";

export function EnglishCurriculumResetDialog({ dialogRef, disabled, onConfirm, onClose }: {
  dialogRef: RefObject<HTMLDialogElement | null>; disabled: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return <dialog ref={dialogRef} className="delete-dialog english-admin-curriculum-reset" role="alertdialog"
    aria-labelledby="english-curriculum-reset-title" aria-describedby="english-curriculum-reset-warning"
    onClose={onClose} onCancel={event => { event.preventDefault(); onClose(); }}>
    <section className="delete-content"><header><h2 id="english-curriculum-reset-title">恢复默认 BOPPPS 内容</h2>
      <button type="button" className="icon-button" aria-label="取消恢复默认内容" disabled={disabled} onClick={onClose}><X size={20}/></button></header>
      <p id="english-curriculum-reset-warning" className="delete-warning">将替换当前课程草稿中六个阶段的说明和活动，覆盖尚未发布的课程内容编辑。</p>
      <p className="small-note">恢复后仍须保存并发布，新的英语登记才会使用默认课程。</p>
      <div className="delete-actions"><button type="button" className="button secondary" disabled={disabled} onClick={onClose}>取消</button>
        <button type="button" className="button primary" disabled={disabled} onClick={onConfirm}><RotateCcw size={16}/>确认恢复默认内容</button></div>
    </section>
  </dialog>;
}

export function EnglishCurriculumEditor({ value, disabled, onChange, initialStage = "bridge" }: {
  value: EnglishCurriculum; disabled: boolean; onChange: (curriculum: EnglishCurriculum) => void; initialStage?: EnglishStage;
}) {
  const [selected, setSelected] = useState<EnglishStage>(initialStage);
  const [resetting, setResetting] = useState(false);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const active = value[selected];
  const stage = englishStages.find(item => item.id === selected)!;
  const total = englishStages.reduce((sum, item) => sum + value[item.id].activities.length, 0);
  const canSetWordLimit = selected === "participatory" || selected === "post_assessment";
  useEffect(() => {
    if (resetting && !resetDialog.current?.open) resetDialog.current?.showModal();
    else if (!resetting) resetDialog.current?.close();
  }, [resetting]);

  function changeActivity(index: number, change: Partial<EnglishActivity>) {
    onChange({ ...value, [selected]: { ...active, activities: active.activities.map((activity, position) => position === index ? { ...activity, ...change } : activity) } });
  }
  function addActivity() {
    if (disabled || active.activities.length >= 8 || total >= 24) return;
    onChange({ ...value, [selected]: { ...active, activities: [...active.activities, { title: "新学习活动", prompt: "", criterion: "", word_limit: null }] } });
  }
  function removeActivity(index: number) {
    if (disabled || active.activities.length <= 1) return;
    onChange({ ...value, [selected]: { ...active, activities: active.activities.filter((_, position) => position !== index) } });
  }

  return <div className="english-admin-curriculum">
    <div className="info-note"><BookOpen size={17}/><span>六个阶段的顺序保持固定。每阶段可设置 1–8 个活动，课程最多 24 个活动。发布后的内容只用于新登记；学生继续已登记的课程快照。</span></div>
    <div className="english-admin-curriculum-toolbar"><span>当前课程共 {total} / 24 个活动</span>
      <button type="button" className="button secondary small" disabled={disabled} onClick={() => setResetting(true)}><RotateCcw size={14}/>恢复默认内容</button></div>
    <nav className="english-admin-stage-selector" aria-label="选择编辑 BOPPPS 阶段">
      {englishStages.map((item, index) => <button type="button" key={item.id} className={selected === item.id ? "active" : ""}
        aria-pressed={selected === item.id} disabled={disabled} onClick={() => setSelected(item.id)}>
        <span>{index + 1} · {item.label}</span><small>{value[item.id].activities.length} 个活动</small>
      </button>)}
    </nav>
    <section className="settings-card"><div className="card-heading"><span className="section-icon"><BookOpen size={19}/></span>
      <div><h2>{stage.label} · 阶段内容</h2><p>{stage.english} · 学生按活动排列顺序完成本阶段。</p></div></div>
      <label className="field"><span>阶段说明</span><textarea rows={2} maxLength={300} value={active.description} disabled={disabled}
        onChange={event => onChange({ ...value, [selected]: { ...active, description: event.target.value } })}/><small>1–300 字，学生的学习进度栏会显示此说明。</small></label>
      <div className="english-admin-activity-list">{active.activities.map((activity, index) => <article className="english-admin-activity-editor" key={selected + ":" + index}>
        <header><h3>活动 {index + 1} / {active.activities.length}</h3><button type="button" className="button text small"
          aria-label={"删除" + stage.label + "活动 " + (index + 1)} disabled={disabled || active.activities.length <= 1} onClick={() => removeActivity(index)}><Trash2 size={14}/>删除活动</button></header>
        <label className="field"><span>活动标题</span><input value={activity.title} maxLength={120} disabled={disabled} onChange={event => changeActivity(index, { title: event.target.value })}/><small>1–120 字，显示在学生当前活动和聊天任务中。</small></label>
        <label className="field"><span>学生任务</span><textarea rows={5} maxLength={4000} value={activity.prompt} disabled={disabled}
          onChange={event => changeActivity(index, { prompt: event.target.value })}/><small>1–4000 字。请提供学生可独立阅读的任务、示例或问题。</small></label>
        <label className="field"><span>达标条件</span><textarea rows={4} maxLength={2000} value={activity.criterion} disabled={disabled}
          onChange={event => changeActivity(index, { criterion: event.target.value })}/><small>1–2000 字，仅用于助教判定和管理员查看。前测仍用于诊断，不要求学生先答对。</small></label>
        {canSetWordLimit && <><label className="english-admin-word-toggle"><input type="checkbox" checked={Boolean(activity.word_limit)} disabled={disabled}
          onChange={event => changeActivity(index, { word_limit: event.target.checked ? { min: 80, max: 100 } : null })}/><span>要求英文正文词数范围</span></label>
        {activity.word_limit && <div className="two-fields">
          <label className="field"><span>最少词数</span><input type="number" min={1} step={1} value={activity.word_limit.min || ""} disabled={disabled}
            onChange={event => changeActivity(index, { word_limit: { ...activity.word_limit!, min: Number(event.target.value) } })}/></label>
          <label className="field"><span>最多词数</span><input type="number" min={1} step={1} value={activity.word_limit.max || ""} disabled={disabled}
            onChange={event => changeActivity(index, { word_limit: { ...activity.word_limit!, max: Number(event.target.value) } })}/></label>
        </div>}</>}
      </article>)}</div>
      <button type="button" className="button secondary" disabled={disabled || active.activities.length >= 8 || total >= 24} onClick={addActivity}><Plus size={16}/>新增活动</button>
      <p className="small-note">每个阶段至少保留一个活动。参与式学习与后测可设置词数范围，上下限须为正整数且下限不大于上限；其他阶段不增加词数关卡。</p>
    </section>
    <EnglishCurriculumResetDialog dialogRef={resetDialog} disabled={disabled} onClose={() => setResetting(false)} onConfirm={() => {
      onChange(defaultEnglishCurriculum()); setSelected("bridge"); setResetting(false);
    }}/>
  </div>;
}
