import { participantQuestionProgressLabel, questionProgressLabel, type QuestionProgress as Progress } from "@/lib/question-mode";

export function QuestionProgress({ state, audience = "participant" }: { state?: Progress | null; audience?: "participant" | "admin" }) {
  if (!state) return null;
  const description = audience === "admin"
    ? state.phase === "guided" ? "先作答，再根据引导完善想法。" : state.phase === "retest"
      ? "本轮独立作答，不提供提示或点评。" : "所有作答已保存，无须继续发送消息。"
    : state.phase === "completed" ? "所有作答已保存。" : null;
  return <div className="question-progress" role="status" aria-live="polite">
    <strong>{audience === "admin" ? questionProgressLabel(state) : participantQuestionProgressLabel(state)}</strong>
    {description && <span>{description}</span>}
  </div>;
}
