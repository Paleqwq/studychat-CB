"use client";
import { publicSettings, type SessionPayload } from "./types";
import { defaultExperiment, effectiveSettings, groups, emptyCounts, type AdminExperiment, type ResearchConversation } from "./experiment";
import { experimentSchema, studentIdSchema } from "./validation";
import { participantConversation } from "./participant";
import { describeConversationConnection } from "./conversation-connection";
import { firstQuestionMessage, initialQuestionProgress, nextQuestionProgress, questionReply, type QuestionMode } from "./question-mode";

const CONFIG_KEY = "studychat.demo.config.v2";
const SESSION_KEY = "studychat.demo.session.v2";
const SNAPSHOT_PREFIX = "studychat.demo.experiment-snapshot.";
export function demoConfig(): AdminExperiment {
  const base = defaultExperiment();
  const fallback: AdminExperiment = { ...base, id: "demo-experiment", revision: 1,
    personality_prompt: "【演示示例，正式研究请自行定义】保持耐心、友善的交流风格，一次只提出一个问题。",
    connections: { deepseek: { ...base.connections.deepseek, model: "demo-deepseek" }, chatgpt: { ...base.connections.chatgpt, model: "demo-chatgpt" } },
    has_api_keys: { deepseek: false, chatgpt: false }, enabled: true, created_at: new Date().toISOString() };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...fallback, ...JSON.parse(raw), has_api_keys: { deepseek: false, chatgpt: false } };
    saveDemoConfig(fallback);
  } catch {}
  return fallback;
}
export function saveDemoConfig(config: AdminExperiment) {
  // Explicitly select fields; never persist supplied credentials, even in the demo.
  const { title, assistant_name, welcome_message, disclosure, base_prompt, personality_prompt, connections, question_mode } = config;
  const { api_keys: _keys, expected_revision: _revision, ...safe } = experimentSchema.parse({
    title, assistant_name, welcome_message, disclosure, base_prompt, personality_prompt, connections,
    ...(question_mode ? { question_mode } : {}),
    enabled: config.enabled, expected_revision: config.revision, api_keys: { deepseek: "", chatgpt: "" }
  });
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...safe, id: config.id, revision: config.revision,
    created_at: config.created_at, has_api_keys: { deepseek: false, chatgpt: false } }));
}
export function demoSession(studentId?: string): SessionPayload | null {
  const config = demoConfig();
  const sid = studentId === undefined ? undefined : studentIdSchema.parse(studentId);
  const raw = localStorage.getItem(SESSION_KEY);
  if (raw) {
    const data: SessionPayload = JSON.parse(raw);
    if (sid && sid !== data.student_id) throw new Error("本浏览器已绑定其他学号，不能更换学号或重新登记。");
    data.messages = data.messages.map(m => m.status === "pending" ? { ...m, status: "failed", error_code: "interrupted" } : m);
    return { ...data, enabled: config.enabled };
  }
  if (!sid) return null;
  if (!config.enabled) throw new Error("本次对话已暂停，请联系管理员。");
  // UI-only simulation. Real allocation runs exclusively in the PostgreSQL transaction.
  const group = groups[crypto.getRandomValues(new Uint32Array(1))[0] % 4];
  const now = new Date().toISOString();
  const conversation: ResearchConversation = { id: crypto.randomUUID(), participant_code: "P-DEMO-001",
    title: "尚未开始对话", created_at: now, updated_at: now, config_id: "demo-config-" + config.revision,
    request_count: 0, student_id: sid, group_code: group.code, model_factor: group.model,
    personality: group.personality, experiment_id: config.id, experiment_revision: config.revision, assigned_at: now };
  const result: SessionPayload = { student_id: sid, settings: publicSettings(config), enabled: config.enabled,
    messages: [], conversation: participantConversation(conversation) };
  if (config.question_mode?.enabled) {
    result.question_progress = initialQuestionProgress();
    result.conversation.title = "题目问答 · " + config.question_mode.questions[0].title;
    result.messages.push({ id: crypto.randomUUID(), role: "assistant", content: firstQuestionMessage(config.question_mode),
      turn_id: crypto.randomUUID(), status: "complete", created_at: now });
  }
  localStorage.setItem(SNAPSHOT_PREFIX + conversation.id, JSON.stringify({ conversation,
    config: { revision: config.revision, settings: effectiveSettings(config, group) } }));
  saveDemoSession(result);
  return result;
}
export function saveDemoSession(session: SessionPayload) { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
export function demoRecord() {
  const session = demoSession();
  if (!session) return null;
  const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_PREFIX + session.conversation.id)!);
  const conversation = { ...snapshot.conversation, ...session.conversation } as ResearchConversation;
  const current = demoConfig();
  return { conversation,
    messages: session.messages, config: snapshot.config,
    question_progress: session.question_progress,
    connection: describeConversationConnection(snapshot.config.settings, conversation.model_factor,
      { revision: current.revision, created_at: current.created_at, settings: current }) };
}
export function demoQuestionReply(session: SessionPayload) {
  if (!session.question_progress) return null;
  const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_PREFIX + session.conversation.id)!);
  const mode = snapshot.config.settings.question_mode as QuestionMode;
  const before = session.question_progress;
  // Deliberately deterministic UI simulation, not a claim to judge student ability.
  const achieved = before.guidance_turns > 0;
  const next = nextQuestionProgress(before, achieved);
  const feedback = achieved ? "【演示流程，非真实 AI 评估】本题作答已收到。" :
    "【演示回复，非真实 AI】请补充一个支持你判断的依据，并解释它与题目的关系。";
  return { content: questionReply(mode, before, next, feedback), question_progress: next };
}
export function demoCounts() {
  const counts = emptyCounts();
  const record = demoRecord();
  if (record?.conversation.group_code) counts[record.conversation.group_code] = 1;
  return counts;
}
export function deleteDemoConversation(conversationId: string) {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw || (JSON.parse(raw) as SessionPayload).conversation.id !== conversationId) {
    throw new Error("未找到此演示会话，请刷新列表。");
  }
  localStorage.removeItem(SNAPSHOT_PREFIX + conversationId);
  localStorage.removeItem(SESSION_KEY);
}
export function demoReply(content: string): string {
  return "谢谢你分享这些。我们可以从你最在意的部分开始，慢慢梳理。\n\n你提到的「" +
    content.slice(0, 50) + (content.length > 50 ? "…" : "") +
    "」，对你来说，最值得进一步讨论的是哪一点？\n\n*这是本地演示回复，用于检查页面交互；尚未调用真实 AI。*";
}
