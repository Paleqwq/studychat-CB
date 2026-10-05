"use client";

import { advanceEnglishProgress, englishCourseOutline, englishProgressSchema, englishPublicSettings, englishTurnContent, firstEnglishMessage, initialEnglishProgress, parseEnglishProgress, type EnglishCurriculum } from "./english-assistant";
import type { ChatMessage, EnglishLearningControlResult, SessionPayload } from "./types";
import { studentIdSchema } from "./validation";
import { defaultEnglishSettings, demoEnglishConfig, type EnglishAdminConfiguration } from "./english-settings";
import { emptyEnglishCounts, englishGroups, type EnglishConversationDetail, type EnglishGroupCounts, type EnglishResearchConversation } from "./english-groups";
import { participantConversation } from "./participant";
import { connectionSettings } from "./experiment";
import { demoConfig } from "./demo";
import { describeConversationConnection } from "./conversation-connection";
import { ENGLISH_PAUSE_MESSAGE, ENGLISH_RESUME_MESSAGE, isEnglishLearningPauseRequest } from "./english-learning-pause";

const SESSION_KEY = "studychat.demo.english-session.v1";
const ATTEMPTS_PREFIX = "studychat.demo.english-attempts.";
const RECORDS_KEY = "studychat.demo.english-records.v1";
const DELETED_KEY = "studychat.demo.english-deleted.v1";
const SESSION_UNAVAILABLE = "此英语学习会话已删除或无法恢复，请刷新页面重新登记。";
const SESSION_STATE_CONFLICT = "英语学习进度已更新，请刷新页面继续。";

export function isDemoEnglishSessionUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_UNAVAILABLE;
}

export function isDemoEnglishSessionStateConflict(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_STATE_CONFLICT;
}

function deletedSessionIds(): string[] {
  const raw = localStorage.getItem(DELETED_KEY);
  if (!raw) return [];
  const ids: unknown = JSON.parse(raw);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new Error("英语演示删除状态无法读取，请联系管理员。");
  return ids as string[];
}

function isDeletedSession(id: string): boolean {
  return deletedSessionIds().includes(id);
}

function readRecords(): EnglishConversationDetail[] {
  const raw = localStorage.getItem(RECORDS_KEY);
  if (!raw) return [];
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("英语助教演示档案无法读取，请联系管理员。");
  const deleted = new Set(deletedSessionIds());
  return (records as EnglishConversationDetail[]).filter(record => !deleted.has(record.conversation.id));
}

function assertDemoEnglishControlRateLimit(snapshot: EnglishConversationDetail) {
  const cutoff = Date.now() - 60000;
  // Saved control replies are the demo's audit: both button and natural-pause
  // paths use these fixed messages. Failed/pending replies consume no control.
  const recentTurns = new Set(snapshot.messages.filter(message => message.role === "assistant" && message.status === "complete" &&
    (message.content === ENGLISH_PAUSE_MESSAGE || message.content === ENGLISH_RESUME_MESSAGE) && Date.parse(message.created_at) > cutoff)
    .map(message => message.turn_id));
  if (recentTurns.size >= 8) throw new Error("暂停或继续操作过于频繁，请稍后再试。");
}

function publicSession(session: SessionPayload, enabled = session.enabled, curriculum?: EnglishCurriculum | null): SessionPayload {
  if (!session.english_progress) throw new Error("英语助教会话缺少学习进度。");
  return {
    student_id: session.student_id,
    conversation: participantConversation(session.conversation),
    messages: session.messages,
    settings: englishPublicSettings(session.settings.disclosure),
    enabled,
    english_progress: parseEnglishProgress(session.english_progress, curriculum),
    english_course: englishCourseOutline(curriculum),
    english_paused: Boolean(session.english_paused),
  };
}

function sessionFromRecord(record: EnglishConversationDetail, enabled: boolean): SessionPayload {
  return publicSession({
    student_id: record.conversation.student_id,
    conversation: record.conversation,
    messages: record.messages,
    settings: englishPublicSettings(record.config.settings.disclosure),
    english_progress: record.english_progress,
    english_paused: Boolean(record.conversation.english_paused),
    enabled,
  }, enabled, record.config.curriculum);
}

function snapshotSettings(config: EnglishAdminConfiguration, personality: boolean) {
  return {
    ...englishPublicSettings(config.settings.disclosure),
    ...connectionSettings(config.settings),
    system_prompt: config.base_prompt + (personality ? "\n\n" + config.personality_prompt : ""),
  };
}

function legacyRecord(session: SessionPayload): EnglishConversationDetail {
  const progress = englishProgressSchema.parse(session.english_progress);
  return {
    conversation: { ...participantConversation(session.conversation), student_id: session.student_id ?? "",
      group_code: null, model_factor: null, personality: null, assigned_at: null,
      experiment_id: null, experiment_revision: null, prompt_revision: null, english_progress: progress,
      english_paused: Boolean(session.english_paused) },
    messages: session.messages,
    // Earlier demos did not retain their model or prompt. Do not invent a historical assignment.
    config: { id: null, settings: { ...defaultEnglishSettings(), disclosure: session.settings.disclosure },
      base_prompt: null, personality_prompt: null, prompt_revision: null, source_revision: null, created_at: null },
    english_progress: progress,
  };
}

export function demoEnglishSession(studentId?: string): SessionPayload | null {
  const config = demoEnglishConfig();
  const sid = studentId === undefined ? undefined : studentIdSchema.parse(studentId);
  const raw = localStorage.getItem(SESSION_KEY);
  if (raw) {
    const stored = JSON.parse(raw) as SessionPayload;
    if (isDeletedSession(stored.conversation.id)) {
      localStorage.removeItem(SESSION_KEY);
      return sid ? demoEnglishSession(sid) : null;
    }
    if (sid && stored.student_id !== sid) throw new Error("本浏览器的英语助教已绑定其他学号，不能更换学号或重新登记。");
    if (!stored.english_progress) throw new Error("英语学习进度无法恢复，请联系管理员。");
    const snapshot = readRecords().find(record => record.conversation.id === stored.conversation.id);
    const authoritative = snapshot ? sessionFromRecord(snapshot, config.enabled) : stored;
    const activeLease = authoritative.conversation.locked_until && Date.parse(authoritative.conversation.locked_until) > Date.now();
    const restored = publicSession({
      ...authoritative,
      messages: authoritative.messages.map(message => message.status === "pending" && !activeLease ? { ...message, status: "failed", error_code: "interrupted" } : message)
    }, config.enabled, snapshot?.config.curriculum);
    saveDemoEnglishSession(restored);
    return restored;
  }
  if (!sid) return null;
  const records = readRecords();
  const previous = records.find(record => record.conversation.student_id === sid);
  if (previous) {
    const restored = sessionFromRecord(previous, config.enabled);
    const activeLease = restored.conversation.locked_until && Date.parse(restored.conversation.locked_until) > Date.now();
    restored.messages = restored.messages.map(message => message.status === "pending" && !activeLease ?
      { ...message, status: "failed", error_code: "interrupted" } : message);
    saveDemoEnglishSession(restored);
    return restored;
  }
  if (!config.enabled) throw new Error("英语助教课程已暂停，请联系管理员。");
  const counts = demoEnglishCounts();
  const minimum = Math.min(counts.deepseek_personality, counts.deepseek_control);
  const candidates = englishGroups.filter(group => counts[group.code] === minimum);
  // UI simulation only. Live balancing and enrollment are atomic database operations.
  const group = candidates[crypto.getRandomValues(new Uint32Array(1))[0] % candidates.length];
  const personality = group.personality;
  const now = new Date().toISOString();
  const progress = initialEnglishProgress();
  const source = demoConfig();
  const snapshotId = crypto.randomUUID();
  const participantSequence = records.reduce((maximum, record) => {
    const previousCode = /^PEEC-DEMO-(\d+)$/.exec(record.conversation.participant_code);
    return Math.max(maximum, Number(previousCode?.[1] ?? 0));
  }, 0) + 1;
  const conversation: EnglishResearchConversation = {
    id: crypto.randomUUID(), participant_code: "PEEC-DEMO-" + String(participantSequence).padStart(3, "0"),
    title: "英语助教", request_count: 0, created_at: now, updated_at: now,
    config_id: snapshotId, student_id: sid, group_code: group.code, model_factor: group.model,
    personality, assigned_at: now, experiment_id: source.id,
    experiment_revision: config.shared_experiment_revision, prompt_revision: config.revision,
    english_progress: progress,
    english_paused: false,
  };
  const result: SessionPayload = {
    student_id: sid,
    conversation: participantConversation(conversation),
    settings: englishPublicSettings(config.settings.disclosure),
    enabled: config.enabled,
    english_progress: progress,
    english_paused: false,
    english_course: englishCourseOutline(config.curriculum),
    messages: [{ id: crypto.randomUUID(), role: "assistant", content: firstEnglishMessage(config.curriculum),
      turn_id: crypto.randomUUID(), status: "complete", created_at: now }]
  };
  const snapshot: EnglishConversationDetail = {
    conversation,
    messages: result.messages,
    config: { id: snapshotId, settings: snapshotSettings(config, personality), base_prompt: config.base_prompt,
      personality_prompt: personality ? config.personality_prompt : null, prompt_revision: config.revision,
      source_revision: config.shared_experiment_revision, created_at: now, curriculum: config.curriculum },
    english_progress: progress,
  };
  localStorage.setItem(RECORDS_KEY, JSON.stringify([...records, snapshot]));
  saveDemoEnglishSession(result);
  return result;
}

export function saveDemoEnglishSession(session: SessionPayload) {
  if (isDeletedSession(session.conversation.id)) throw new Error(SESSION_UNAVAILABLE);
  const records = readRecords();
  const index = records.findIndex(record => record.conversation.id === session.conversation.id);
  const englishSession = publicSession(session, session.enabled, index < 0 ? null : records[index].config.curriculum);
  const existing = index < 0 ? legacyRecord(englishSession) : records[index];
  if (index >= 0) {
    if (typeof session.english_paused !== "boolean") englishSession.english_paused = Boolean(existing.conversation.english_paused);
    const difference = englishSession.english_progress!.version - existing.english_progress.version;
    if (difference < 0 || difference > 1) throw new Error(SESSION_STATE_CONFLICT);
    const wasPaused = Boolean(existing.conversation.english_paused);
    const activityChanged = existing.english_progress.stage !== englishSession.english_progress!.stage ||
      existing.english_progress.step !== englishSession.english_progress!.step ||
      existing.english_progress.completed !== englishSession.english_progress!.completed;
    // A teaching reply and a control action can both produce version + 1. The
    // late teaching reply must not advance a task after the control already committed.
    if (difference === 0 && activityChanged) throw new Error(SESSION_STATE_CONFLICT);
    if (difference === 0) englishSession.english_paused = wasPaused;
    if (difference === 1 && activityChanged && (wasPaused || wasPaused !== englishSession.english_paused)) throw new Error(SESSION_STATE_CONFLICT);
  }
  const synchronized: EnglishConversationDetail = {
    ...existing,
    conversation: { ...existing.conversation, ...englishSession.conversation, english_progress: englishSession.english_progress!,
      english_paused: englishSession.english_paused },
    messages: englishSession.messages,
    english_progress: englishSession.english_progress!,
  };
  if (index < 0) records.push(synchronized);
  else records[index] = synchronized;
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  localStorage.setItem(SESSION_KEY, JSON.stringify(englishSession));
}

export function setDemoEnglishLearningPause(session: SessionPayload, paused: boolean, content: string, turnId: string): EnglishLearningControlResult {
  if (isDeletedSession(session.conversation.id)) throw new Error(SESSION_UNAVAILABLE);
  const snapshot = readRecords().find(record => record.conversation.id === session.conversation.id);
  if (!snapshot) throw new Error(SESSION_UNAVAILABLE);
  const message = paused ? ENGLISH_PAUSE_MESSAGE : ENGLISH_RESUME_MESSAGE;
  const previousUser = snapshot.messages.find(item => item.turn_id === turnId && item.role === "user");
  const previousAssistant = snapshot.messages.find(item => item.turn_id === turnId && item.role === "assistant");
  if (previousUser || previousAssistant) {
    if (!previousUser || previousUser.content !== content || !previousAssistant || previousAssistant.status !== "complete" || previousAssistant.content !== message) {
      throw new Error("重试内容与原消息不同，请刷新后重试。");
    }
    return { user: previousUser, assistant: previousAssistant, english_progress: snapshot.english_progress,
      english_paused: Boolean(snapshot.conversation.english_paused) };
  }
  if (snapshot.conversation.locked_until && Date.parse(snapshot.conversation.locked_until) > Date.now()) {
    throw new Error("此英语会话仍在生成回复，请稍后再暂停或继续。");
  }
  if (!session.english_progress || session.english_progress.version !== snapshot.english_progress.version) throw new Error(SESSION_STATE_CONFLICT);
  if (snapshot.english_progress.completed) throw new Error("BOPPPS 学习已完成。");
  if (!content.trim() || content.length > 8000 || !turnId || typeof paused !== "boolean") throw new Error("暂停或继续请求不符合要求。");
  assertDemoEnglishControlRateLimit(snapshot);
  const next = { ...snapshot.english_progress, version: snapshot.english_progress.version + 1 };
  const now = new Date().toISOString();
  const user: ChatMessage = { id: crypto.randomUUID(), role: "user", content, turn_id: turnId, status: "complete", created_at: now };
  const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: message, turn_id: turnId, status: "complete", created_at: now };
  const restored = sessionFromRecord(snapshot, demoEnglishConfig().enabled);
  restored.messages = [...restored.messages, user, assistant];
  restored.english_progress = next; restored.english_paused = paused;
  restored.conversation.updated_at = now; restored.conversation.locked_until = null;
  saveDemoEnglishSession(restored);
  return { user, assistant, english_progress: next, english_paused: paused };
}

export function demoEnglishRecords(): EnglishResearchConversation[] {
  // Import pre-grouping singleton demos as legacy records and recover interrupted replies.
  demoEnglishSession();
  return readRecords().map(record => record.conversation)
    .sort((first, second) => second.created_at.localeCompare(first.created_at));
}

export function demoEnglishRecord(id?: string): EnglishConversationDetail | null {
  const currentSession = demoEnglishSession();
  const conversationId = id ?? currentSession?.conversation.id;
  if (!conversationId) return null;
  const record = readRecords().find(item => item.conversation.id === conversationId);
  if (!record) return null;
  if (record.config.id === null && record.conversation.model_factor === null) {
    const { connection: _connection, ...legacy } = record;
    return legacy;
  }
  const current = demoConfig();
  return { ...record, connection: describeConversationConnection(record.config.settings, record.conversation.model_factor,
    { revision: current.revision, created_at: current.created_at, settings: current }) };
}

export function demoEnglishCounts(): EnglishGroupCounts {
  const counts = emptyEnglishCounts();
  for (const { conversation } of readRecords()) {
    if (conversation.group_code === "deepseek_personality" || conversation.group_code === "deepseek_control") {
      counts[conversation.group_code]++;
    }
  }
  return counts;
}

export function deleteDemoEnglishConversation(conversationId: string): void {
  const records = readRecords();
  const record = records.find(item => item.conversation.id === conversationId);
  if (!record) throw new Error("未找到此英语学习会话，请刷新列表。");
  const raw = localStorage.getItem(SESSION_KEY);
  const current = raw ? JSON.parse(raw) as SessionPayload : null;
  const lockedUntil = current?.conversation.id === conversationId ?
    current.conversation.locked_until ?? record.conversation.locked_until : record.conversation.locked_until;
  if (lockedUntil && Date.parse(lockedUntil) > Date.now()) throw new Error("此英语会话仍在生成回复，暂不能删除，请稍后重试。");
  // Retain only the deleted ID so an older tab or a late stream cannot recreate its history.
  localStorage.setItem(DELETED_KEY, JSON.stringify([...new Set([...deletedSessionIds(), conversationId])]));
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records.filter(item => item.conversation.id !== conversationId)));
  localStorage.removeItem(ATTEMPTS_PREFIX + conversationId);
  if (current?.conversation.id === conversationId) localStorage.removeItem(SESSION_KEY);
}

export function demoEnglishReply(session: SessionPayload) {
  if (isDeletedSession(session.conversation.id)) throw new Error(SESSION_UNAVAILABLE);
  const snapshot = readRecords().find(record => record.conversation.id === session.conversation.id);
  if (!snapshot) throw new Error(SESSION_UNAVAILABLE);
  const before = session.english_progress;
  if (!before) throw new Error("英语学习进度无法恢复，请重新连接。");
  const latestUser = session.messages.findLast(message => message.role === "user");
  if (!latestUser) throw new Error("请先完成当前学习活动。");
  if (isEnglishLearningPauseRequest(latestUser.content)) {
    const previousAssistant = snapshot.messages.find(message => message.turn_id === latestUser.turn_id && message.role === "assistant" && message.status === "complete");
    if (previousAssistant) {
      const previousUser = snapshot.messages.find(message => message.turn_id === latestUser.turn_id && message.role === "user");
      if (previousAssistant.content !== ENGLISH_PAUSE_MESSAGE || previousUser?.content !== latestUser.content) {
        throw new Error("重试内容与原消息不同，请刷新后重试。");
      }
      return { content: previousAssistant.content, english_progress: snapshot.english_progress,
        english_paused: Boolean(snapshot.conversation.english_paused) };
    }
    if (before.version !== snapshot.english_progress.version) throw new Error(SESSION_STATE_CONFLICT);
    if (before.completed || snapshot.english_progress.completed) throw new Error("BOPPPS 学习已完成。");
    assertDemoEnglishControlRateLimit(snapshot);
    return { content: ENGLISH_PAUSE_MESSAGE, english_progress: { ...before, version: before.version + 1 }, english_paused: true };
  }
  if (before.completed || snapshot.english_progress.completed) throw new Error("BOPPPS 学习已完成。");
  if (snapshot.conversation.english_paused || session.english_paused) throw new Error("英语学习已暂停，请点击“继续学习”后再作答。");
  const key = ATTEMPTS_PREFIX + session.conversation.id;
  const attempts = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string[]>;
  const activityKey = before.stage + ":" + before.step;
  const turns = attempts[activityKey] ?? [];
  if (!turns.includes(latestUser.turn_id)) turns.push(latestUser.turn_id);
  attempts[activityKey] = turns;
  localStorage.setItem(key, JSON.stringify(attempts));
  // Two distinct submissions demonstrate the gate. Retrying the same transport
  // failure keeps the same outcome; this simulation does not assess ability.
  const requiresRevision = before.stage === "participatory" || before.stage === "post_assessment";
  const achieved = !requiresRevision || turns.indexOf(latestUser.turn_id) > 0;
  const curriculum = snapshot.config.curriculum;
  const next = advanceEnglishProgress(before, achieved, curriculum);
  const feedback = achieved
    ? "【演示流程，非真实 AI 评估】作答已收到，现在演示进入下一项学习活动。"
    : "【演示流程，非真实 AI 评估】第一次提交会停留在当前活动。请补充或修改你的回答，再次提交以演示后续流程。";
  return { content: englishTurnContent(before, next, feedback, curriculum), english_progress: next, english_paused: false };
}
