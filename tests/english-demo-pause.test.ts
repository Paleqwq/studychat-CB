import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSession } from "@/lib/demo";
import { deleteDemoEnglishConversation, demoEnglishCounts, demoEnglishRecord, demoEnglishRecords, demoEnglishReply,
  demoEnglishSession, isDemoEnglishSessionStateConflict, isDemoEnglishSessionUnavailable,
  saveDemoEnglishSession, setDemoEnglishLearningPause } from "@/lib/english-demo";
import { demoEnglishConfig, saveDemoEnglishConfig } from "@/lib/english-settings";
import { ENGLISH_PAUSE_MESSAGE, ENGLISH_RESUME_MESSAGE } from "@/lib/english-learning-pause";
import type { SessionPayload } from "@/lib/types";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function answer(session: SessionPayload, content: string, pending = false) {
  const turn = crypto.randomUUID();
  const now = new Date().toISOString();
  session.messages.push({ id: crypto.randomUUID(), role: "user", content, turn_id: turn, status: "complete", created_at: now });
  if (pending) session.messages.push({ id: crypto.randomUUID(), role: "assistant", content: "", turn_id: turn, status: "pending", created_at: now });
  return turn;
}

describe("independent English demonstration learning pause", () => {
  it("pauses and resumes the current activity while freezing the course, group, model and Bloom state", () => {
    const bloom = demoSession("BLOOM_PAUSE_KEEP")!;
    saveDemoEnglishConfig(demoEnglishConfig());
    const retainedKeys = new Map(storage);
    const session = demoEnglishSession("PAUSE001")!;
    const snapshot = demoEnglishRecord()!;
    const counts = demoEnglishCounts();
    expect(session.english_paused).toBe(false);
    const paused = setDemoEnglishLearningPause(session, true, "先休息一下", crypto.randomUUID());
    expect(paused).toMatchObject({ english_paused: true, english_progress: { ...session.english_progress!, version: 1 } });
    expect(paused.user.status).toBe("complete"); expect(paused.assistant).toMatchObject({ status: "complete", content: ENGLISH_PAUSE_MESSAGE });
    const restored = demoEnglishSession()!;
    expect(restored.english_paused).toBe(true); expect(restored.messages).toHaveLength(3);
    expect(demoEnglishRecord()!.conversation.english_paused).toBe(true);
    const resumed = setDemoEnglishLearningPause(restored, false, "继续学习", crypto.randomUUID());
    expect(resumed).toMatchObject({ english_paused: false, english_progress: { ...session.english_progress!, version: 2 } });
    expect(resumed.assistant.content).toBe(ENGLISH_RESUME_MESSAGE);
    const after = demoEnglishRecord()!;
    expect(after.config).toEqual(snapshot.config);
    for (const field of ["group_code", "model_factor", "personality", "experiment_id", "prompt_revision", "config_id"] as const) {
      expect(after.conversation[field]).toBe(snapshot.conversation[field]);
    }
    expect(demoEnglishCounts()).toEqual(counts);
    for (const [key, value] of retainedKeys) expect(storage.get(key), key).toBe(value);
    expect(demoSession()!.conversation.id).toBe(bloom.conversation.id);
  });

  it("retries the same control turn without duplicate messages or another version change", () => {
    const session = demoEnglishSession("PAUSE002")!;
    const turn = crypto.randomUUID();
    const first = setDemoEnglishLearningPause(session, true, "暂停学习", turn);
    const original = new Map(storage);
    expect(setDemoEnglishLearningPause(session, true, "暂停学习", turn)).toEqual(first);
    expect(storage).toEqual(original);
    expect(() => setDemoEnglishLearningPause(session, false, "暂停学习", turn)).toThrow("重试内容");
    expect(() => setDemoEnglishLearningPause(session, true, "不同内容", turn)).toThrow("重试内容");
    expect(demoEnglishSession()!.messages).toHaveLength(3);
  });

  it("rejects stale tab writes and preserves pause state during repeated writes at the current version", () => {
    const stale = demoEnglishSession("PAUSE003")!;
    setDemoEnglishLearningPause(stale, true, "暂停学习", crypto.randomUUID());
    const paused = demoEnglishSession()!;
    const retained = new Map(storage);
    let conflict: unknown;
    try { saveDemoEnglishSession(stale); } catch (error) { conflict = error; }
    expect(isDemoEnglishSessionStateConflict(conflict)).toBe(true); expect(storage).toEqual(retained);
    expect(() => setDemoEnglishLearningPause(stale, false, "继续学习", crypto.randomUUID())).toThrow("进度已更新");
    saveDemoEnglishSession({ ...paused, english_paused: false });
    expect(demoEnglishSession()!.english_paused).toBe(true);
    const missingFlag = { ...paused, english_paused: undefined };
    saveDemoEnglishSession(missingFlag);
    expect(demoEnglishSession()!.english_paused).toBe(true);
    expect(() => saveDemoEnglishSession({ ...paused, english_paused: false,
      english_progress: { ...paused.english_progress!, stage: "objectives" } })).toThrow("进度已更新");
    expect(demoEnglishSession()!.english_progress!.stage).toBe("bridge");
    expect(() => saveDemoEnglishSession({ ...paused, english_progress: { ...paused.english_progress!, version: paused.english_progress!.version + 2 } }))
      .toThrow("进度已更新");
  });

  it("recognizes a natural stop request without advancing the task or altering demo assessment attempts", () => {
    const session = demoEnglishSession("PAUSE004")!;
    session.english_progress = { stage: "participatory", step: 1, version: 1, completed: false };
    saveDemoEnglishSession(session);
    const turn = answer(session, "我不想学习了，先休息一下", true);
    saveDemoEnglishSession(session);
    const attemptsKey = "studychat.demo.english-attempts." + session.conversation.id;
    storage.set(attemptsKey, JSON.stringify({ retained: ["previous-demo-attempt"] }));
    const retainedAttempts = storage.get(attemptsKey);
    const reply = demoEnglishReply(session);
    expect(reply).toEqual({ content: ENGLISH_PAUSE_MESSAGE, english_paused: true,
      english_progress: { ...session.english_progress!, version: 2 } });
    expect(storage.get(attemptsKey)).toBe(retainedAttempts);
    expect(session.messages.at(-1)!.status).toBe("pending");
    expect(JSON.parse(storage.get("studychat.demo.english-session.v1")!).messages.at(-1).status).toBe("pending");
    session.english_progress = reply.english_progress; session.english_paused = reply.english_paused;
    session.messages[session.messages.length - 1] = { ...session.messages.at(-1)!, turn_id: turn, content: reply.content, status: "complete" };
    saveDemoEnglishSession(session);
    const paused = demoEnglishSession()!;
    expect(paused.english_paused).toBe(true); expect(paused.english_progress).toEqual(reply.english_progress);
    answer(paused, "这是当前写作回答");
    expect(() => demoEnglishReply(paused)).toThrow("学习已暂停");
    expect(storage.get(attemptsKey)).toBe(retainedAttempts);
    const control = setDemoEnglishLearningPause(demoEnglishSession()!, false, "继续学习", crypto.randomUUID());
    expect(control.english_progress).toEqual({ ...reply.english_progress, version: 3 });
    const resumed = demoEnglishSession()!; answer(resumed, "这里是新的独立作答");
    expect(demoEnglishReply(resumed).english_paused).toBe(false);
  });

  it("does not pause a student for a quoted stop statement inside an ordinary task answer", () => {
    const session = demoEnglishSession("PAUSE005")!;
    answer(session, "请分析句子“我不想学习了”中说话人的观点。");
    expect(demoEnglishReply(session).english_paused).toBe(false);
  });

  it("keeps an active stream pending during administrator refresh and refuses pause controls until its lease clears", () => {
    const session = demoEnglishSession("PAUSE006")!;
    answer(session, "我的普通回答", true);
    session.conversation.locked_until = new Date(Date.now() + 60000).toISOString();
    saveDemoEnglishSession(session);
    expect(demoEnglishRecord()!.messages.at(-1)!.status).toBe("pending");
    expect(demoEnglishRecords()).toHaveLength(1);
    expect(demoEnglishSession()!.messages.at(-1)!.status).toBe("pending");
    const retained = new Map(storage);
    expect(() => setDemoEnglishLearningPause(session, true, "暂停学习", crypto.randomUUID())).toThrow("仍在生成回复");
    expect(storage).toEqual(retained);
    session.messages[session.messages.length - 1].status = "failed";
    session.conversation.locked_until = null; saveDemoEnglishSession(session);
    expect(setDemoEnglishLearningPause(session, true, "暂停学习", crypto.randomUUID()).english_paused).toBe(true);
  });

  it("retains a pause when restoring a registration and rejects controls for a deleted conversation", () => {
    const session = demoEnglishSession("PAUSE007")!;
    setDemoEnglishLearningPause(session, true, "暂停学习", crypto.randomUUID());
    storage.delete("studychat.demo.english-session.v1");
    const restored = demoEnglishSession("PAUSE007")!;
    expect(restored.english_paused).toBe(true); expect(restored.conversation.id).toBe(session.conversation.id);
    deleteDemoEnglishConversation(restored.conversation.id);
    const retained = new Map(storage);
    let unavailable: unknown;
    try { setDemoEnglishLearningPause(restored, false, "继续学习", crypto.randomUUID()); } catch (error) { unavailable = error; }
    expect(isDemoEnglishSessionUnavailable(unavailable)).toBe(true); expect(storage).toEqual(retained);
  });

  it("rejects new controls for a completed course but replays earlier controls using the latest state", () => {
    const initial = demoEnglishSession("PAUSE_COMPLETED")!;
    const turn = crypto.randomUUID();
    const first = setDemoEnglishLearningPause(initial, true, "暂停学习", turn);
    setDemoEnglishLearningPause(demoEnglishSession()!, false, "继续学习", crypto.randomUUID());
    const completed = demoEnglishSession()!;
    completed.english_progress = { stage: "summary", step: 0, completed: true, version: 3 };
    saveDemoEnglishSession(completed);
    const retained = new Map(storage);
    for (const paused of [true, false]) {
      expect(() => setDemoEnglishLearningPause(completed, paused, paused ? "暂停学习" : "继续学习", crypto.randomUUID()))
        .toThrow("学习已完成");
    }
    expect(setDemoEnglishLearningPause(initial, true, "暂停学习", turn)).toEqual({ ...first,
      english_progress: completed.english_progress, english_paused: false });
    expect(storage).toEqual(retained);
  });

  it("limits fresh controls to eight per session per minute while allowing replay and preserving teaching attempts", () => {
    const initial = demoEnglishSession("PAUSE_RATE")!;
    const firstTurn = crypto.randomUUID();
    const attemptsKey = "studychat.demo.english-attempts." + initial.conversation.id;
    storage.set(attemptsKey, JSON.stringify({ retained: ["previous-demo-attempt"] }));
    const retainedAttempts = storage.get(attemptsKey);
    const first = setDemoEnglishLearningPause(initial, true, "暂停学习", firstTurn);
    for (let index = 1; index < 8; index++) {
      const paused = index % 2 === 0;
      setDemoEnglishLearningPause(demoEnglishSession()!, paused, paused ? "暂停学习" : "继续学习", crypto.randomUUID());
    }
    const current = demoEnglishSession()!;
    const retained = new Map(storage);
    expect(() => setDemoEnglishLearningPause(current, true, "暂停学习", crypto.randomUUID())).toThrow("操作过于频繁");
    expect(setDemoEnglishLearningPause(initial, true, "暂停学习", firstTurn)).toEqual({ ...first,
      english_progress: current.english_progress, english_paused: false });
    expect(storage).toEqual(retained);
    expect(current.english_progress!.version).toBe(8); expect(current.messages).toHaveLength(17);
    expect(storage.get(attemptsKey)).toBe(retainedAttempts); expect(current.conversation.request_count).toBe(0);
    storage.delete("studychat.demo.english-session.v1");
    const other = demoEnglishSession("PAUSE_OTHER_RATE")!;
    expect(setDemoEnglishLearningPause(other, true, "暂停学习", crypto.randomUUID()).english_progress.version).toBe(1);
    vi.advanceTimersByTime(60000);
    expect(setDemoEnglishLearningPause(current, true, "暂停学习", crypto.randomUUID()).english_progress.version).toBe(9);
    expect(storage.get(attemptsKey)).toBe(retainedAttempts);
  });

  it("counts saved natural pauses toward the same control limit and replays them without another charge", () => {
    const initial = demoEnglishSession("PAUSE_NATURAL_RATE")!;
    const attemptsKey = "studychat.demo.english-attempts." + initial.conversation.id;
    storage.set(attemptsKey, JSON.stringify({ retained: ["previous-demo-attempt"] }));
    const retainedAttempts = storage.get(attemptsKey);
    for (let index = 0; index < 6; index++) {
      const paused = index % 2 === 0;
      setDemoEnglishLearningPause(demoEnglishSession()!, paused, paused ? "暂停学习" : "继续学习", crypto.randomUUID());
    }
    const natural = demoEnglishSession()!;
    answer(natural, "我不想学习了，先休息一下", true); saveDemoEnglishSession(natural);
    const reply = demoEnglishReply(natural);
    natural.english_progress = reply.english_progress; natural.english_paused = reply.english_paused;
    natural.messages[natural.messages.length - 1] = { ...natural.messages.at(-1)!, content: reply.content, status: "complete" };
    saveDemoEnglishSession(natural);
    setDemoEnglishLearningPause(demoEnglishSession()!, false, "继续学习", crypto.randomUUID());
    const current = demoEnglishSession()!;
    const retained = new Map(storage);
    expect(demoEnglishReply(natural)).toEqual({ content: ENGLISH_PAUSE_MESSAGE,
      english_progress: current.english_progress, english_paused: false });
    expect(storage).toEqual(retained);
    answer(current, "我需要休息一下", true);
    expect(() => demoEnglishReply(current)).toThrow("操作过于频繁");
    expect(storage).toEqual(retained); expect(storage.get(attemptsKey)).toBe(retainedAttempts);
    expect(() => setDemoEnglishLearningPause(demoEnglishSession()!, true, "暂停学习", crypto.randomUUID())).toThrow("操作过于频繁");
  });

  it("does not count old, pending, failed or ordinary teaching messages as fresh saved controls", () => {
    const session = demoEnglishSession("PAUSE_RATE_SAVED")!;
    for (let index = 0; index < 8; index++) {
      for (const status of ["pending", "failed", "complete"] as const) {
        session.messages.push({ id: crypto.randomUUID(), turn_id: crypto.randomUUID(), role: "assistant", status,
          content: status === "complete" ? "已收到当前学习回答" : ENGLISH_PAUSE_MESSAGE, created_at: new Date().toISOString() });
      }
      session.messages.push({ id: crypto.randomUUID(), turn_id: crypto.randomUUID(), role: "assistant", status: "complete",
        content: ENGLISH_PAUSE_MESSAGE, created_at: new Date(Date.now() - 60000).toISOString() });
    }
    saveDemoEnglishSession(session);
    expect(setDemoEnglishLearningPause(session, true, "暂停学习", crypto.randomUUID()).english_progress.version).toBe(1);
  });
});
