import { Check } from "lucide-react";
import { defaultEnglishCurriculum, englishCourseOutline, englishStages, type EnglishCourseOutline, type EnglishProgress as Progress } from "@/lib/english-assistant";

export function EnglishProgress({ state, course }: { state?: Progress | null; course?: EnglishCourseOutline | null }) {
  if (!state) return null;
  const current = englishStages.findIndex(stage => stage.id === state.stage);
  const outline = course ?? englishCourseOutline(defaultEnglishCurriculum());
  const currentStage = outline[state.stage];
  const activity = currentStage.activities[state.step];
  return <section className="english-progress" aria-label="BOPPPS 学习进度">
    <div className="english-progress-heading">
      <strong>BOPPPS 学习流程</strong>
      <span>{state.completed ? "学习已完成" : `第 ${current + 1} / ${englishStages.length} 阶段`}</span>
    </div>
    <ol className="english-stage-list">
      {englishStages.map((stage, index) => {
        const done = state.completed || index < current;
        return <li key={stage.id} className={done ? "done" : index === current ? "current" : ""}
          aria-current={!state.completed && index === current ? "step" : undefined}>
          <span className="english-stage-number">{done ? <Check size={12} aria-hidden="true"/> : index + 1}</span>
          <span className="english-stage-label">{stage.label}</span>
          <span className="sr-only">{done ? "已完成" : index === current ? "当前阶段" : "待进行"} · {stage.english}</span>
        </li>;
      })}
    </ol>
    <div className="english-current-activity" role="status" aria-live="polite">
      {state.completed ? <p><strong>六阶段学习已完成</strong>，作答和学习记录已保存，可随时回看。</p> : <>
        <strong><span>当前活动 {state.step + 1} / {currentStage.activities.length}</span>{activity?.title ?? "当前学习活动"}</strong>
        <p>{currentStage.description} · 完整任务见上方消息。</p>
      </>}
    </div>
  </section>;
}
