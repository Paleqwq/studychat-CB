import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoConfig, demoCounts, demoRecord, demoSession, saveDemoConfig, saveDemoSession } from "@/lib/demo";
import { deleteDemoEnglishConversation, demoEnglishCounts, demoEnglishRecord, demoEnglishRecords, demoEnglishReply, demoEnglishSession, isDemoEnglishSessionUnavailable, saveDemoEnglishSession } from "@/lib/english-demo";
import { demoEnglishConfig, saveDemoEnglishConfig } from "@/lib/english-settings";
import { defaultEnglishCurriculum, englishCourseOutline, englishPublicSettings, englishStages, initialEnglishProgress } from "@/lib/english-assistant";
import { defaultQuestionMode } from "@/lib/question-mode";
import type { SessionPayload } from "@/lib/types";

const SESSION_KEY = "studychat.demo.english-session.v1";
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function nextEnrollment(studentId: string) {
  storage.delete(SESSION_KEY);
  return demoEnglishSession(studentId)!;
}

describe("independent English DeepSeek groups in the demo", () => {
  it("balances exactly two groups using all independent English registrations", () => {
    expect(demoEnglishCounts()).toEqual({ deepseek_personality: 0, deepseek_control: 0 });
    for (let index = 1; index <= 9; index++) {
      nextEnrollment("ENG" + String(index).padStart(3, "0"));
      const counts = demoEnglishCounts();
      expect(counts.deepseek_personality + counts.deepseek_control).toBe(index);
      expect(Math.abs(counts.deepseek_personality - counts.deepseek_control)).toBeLessThanOrEqual(1);
    }
    const records = demoEnglishRecords();
    expect(records).toHaveLength(9);
    expect(new Set(records.map(record => record.model_factor))).toEqual(new Set(["deepseek"]));
    expect(new Set(records.map(record => record.group_code))).toEqual(new Set(["deepseek_personality", "deepseek_control"]));
    expect(new Set(records.map(record => record.participant_code)).size).toBe(9);
    for (const record of records) {
      expect(record.personality).toBe(record.group_code === "deepseek_personality");
      expect(record.assigned_at).toBe(record.created_at);
      expect(record.english_progress).toEqual(initialEnglishProgress());
    }
  });

  it("leaves Bloom configuration, counts, registration and question history untouched", () => {
    const shared = demoConfig();
    shared.base_prompt = "BLOOM_PRIVATE_BASE";
    shared.personality_prompt = "BLOOM_PRIVATE_PERSONALITY";
    shared.question_mode = { ...defaultQuestionMode(), enabled: true };
    saveDemoConfig(shared);
    const bloom = demoSession("SAME001")!;
    bloom.messages.push({ id: "bloom-answer", role: "user", content: "原 Bloom 回答", turn_id: "bloom-turn",
      status: "complete", created_at: "2026-10-04T10:00:00Z" });
    saveDemoSession(bloom);
    shared.enabled = false;
    saveDemoConfig(shared);
    const independentEnglish = demoEnglishConfig();
    independentEnglish.personality_prompt = "INDEPENDENT_ENGLISH_PERSONALITY";
    saveDemoEnglishConfig(independentEnglish);
    const originalRecord = demoRecord();
    const originalCounts = demoCounts();
    const bloomStorage = new Map([...storage].filter(([key]) =>
      key === "studychat.demo.config.v2" || key === "studychat.demo.session.v2" || key.startsWith("studychat.demo.experiment-snapshot.")));

    const english = demoEnglishSession("SAME001")!;
    nextEnrollment("ENG002");
    expect(english.enabled).toBe(true);
    expect(english.question_progress).toBeUndefined();
    expect(demoEnglishCounts()).toEqual({ deepseek_personality: 1, deepseek_control: 1 });
    expect(demoCounts()).toEqual(originalCounts);
    expect(demoRecord()).toEqual(originalRecord);
    for (const [key, value] of bloomStorage) expect(storage.get(key), key).toBe(value);
    for (const record of demoEnglishRecords()) {
      const detail = demoEnglishRecord(record.id)!;
      expect(detail.config.settings.question_mode).toBeUndefined();
      expect(detail.config.settings.system_prompt).not.toContain("BLOOM_PRIVATE_BASE");
      expect(detail.config.settings.system_prompt).not.toContain("BLOOM_PRIVATE_PERSONALITY");
    }
  });

  it("freezes English prompt and generation snapshots while new registrations inherit shared DeepSeek updates", () => {
    const shared = demoConfig();
    shared.connections.deepseek = { ...shared.connections.deepseek, model: "deepseek-original", temperature: 0.3, max_tokens: 1300 };
    saveDemoConfig(shared);
    const englishConfig = demoEnglishConfig();
    englishConfig.base_prompt = "ENGLISH_ORIGINAL_BASE";
    englishConfig.personality_prompt = "ENGLISH_ORIGINAL_PERSONALITY";
    saveDemoEnglishConfig(englishConfig);
    const publishedEnglish = demoEnglishConfig();
    const original = demoEnglishSession("ENG101")!;
    const initial = demoEnglishRecord(original.conversation.id)!;
    expect(initial.config.settings).toMatchObject({ model: "deepseek-original", temperature: 0.3, max_tokens: 1300 });
    expect(initial.config.base_prompt).toBe("ENGLISH_ORIGINAL_BASE");
    expect(initial.config.prompt_revision).toBe(publishedEnglish.revision);
    expect(initial.config.source_revision).toBe(shared.revision);
    expect(initial.conversation.experiment_id).toBe(shared.id);
    expect(initial.config.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(initial.conversation.config_id).toBe(initial.config.id);
    expect(initial.config.created_at).toBe(initial.conversation.created_at);

    shared.revision++;
    shared.connections.deepseek = { ...shared.connections.deepseek, model: "deepseek-next", temperature: 0.8, max_tokens: 4200,
      api_base_url: "https://new.example.test/v1" };
    saveDemoConfig(shared);
    const nextConfig = demoEnglishConfig();
    nextConfig.revision++;
    nextConfig.base_prompt = "ENGLISH_NEXT_BASE";
    nextConfig.personality_prompt = "ENGLISH_NEXT_PERSONALITY";
    saveDemoEnglishConfig(nextConfig);
    const next = nextEnrollment("ENG102");
    const latest = demoEnglishRecord(next.conversation.id)!;
    const frozen = demoEnglishRecord(original.conversation.id)!;
    expect(frozen.config).toEqual(initial.config);
    expect(frozen.conversation.experiment_id).toBe(initial.conversation.experiment_id);
    expect(frozen.conversation.config_id).toBe(initial.conversation.config_id);
    expect(frozen.conversation.group_code).toBe(initial.conversation.group_code);
    expect(frozen.connection).toMatchObject({ source: "latest", experiment_revision: shared.revision,
      settings: { api_base_url: "https://new.example.test/v1" } });
    expect(latest.config.settings).toMatchObject({ model: "deepseek-next", temperature: 0.8, max_tokens: 4200 });
    expect(latest.config.base_prompt).toBe("ENGLISH_NEXT_BASE");
    expect(latest.config.source_revision).toBe(shared.revision);
    expect(latest.config.prompt_revision).toBe(demoEnglishConfig().revision);
    expect(latest.conversation.experiment_id).toBe(shared.id);
    expect(latest.conversation.config_id).toBe(latest.config.id);
    expect(latest.config.id).not.toBe(initial.config.id);
    expect(latest.config.created_at).toBe(latest.conversation.created_at);
  });

  it("uses separate English base and personality prompts without exposing conditions to students", () => {
    const config = demoEnglishConfig();
    config.base_prompt = "PRIVATE_ENGLISH_BASE";
    config.personality_prompt = "PRIVATE_ENGLISH_PERSONALITY";
    saveDemoEnglishConfig(config);
    const one = demoEnglishSession("ENG201")!;
    const two = nextEnrollment("ENG202");
    const details = [demoEnglishRecord(one.conversation.id)!, demoEnglishRecord(two.conversation.id)!];
    const personality = details.find(detail => detail.conversation.personality)!;
    const control = details.find(detail => !detail.conversation.personality)!;
    expect(personality.config.settings.system_prompt).toBe("PRIVATE_ENGLISH_BASE\n\nPRIVATE_ENGLISH_PERSONALITY");
    expect(personality.config.personality_prompt).toBe("PRIVATE_ENGLISH_PERSONALITY");
    expect(control.config.settings.system_prompt).toBe("PRIVATE_ENGLISH_BASE");
    expect(control.config.personality_prompt).toBeNull();
    expect(JSON.stringify(control)).not.toContain("PRIVATE_ENGLISH_PERSONALITY");
    expect(one.settings).toEqual(two.settings);
    expect(one.messages).toHaveLength(1);
    expect(one.messages[0].content).toBe(two.messages[0].content);
    for (const session of [one, two, demoEnglishSession()!]) {
      const serialized = JSON.stringify(session);
      expect(serialized).not.toMatch(/group_code|model_factor|personality|system_prompt|api_key|base_prompt|prompt_revision|experiment_revision/);
      expect(serialized).not.toContain("PRIVATE_ENGLISH");
      expect(Object.keys(session.settings).sort()).toEqual(["assistant_name", "disclosure", "title", "welcome_message"]);
    }
    const publicStore = JSON.parse(storage.get(SESSION_KEY)!);
    expect(publicStore.conversation).not.toHaveProperty("config_id");
    expect(publicStore).not.toHaveProperty("question_progress");
  });

  it("synchronizes all completed messages and progress into private records and restores the same enrollment", () => {
    const session = demoEnglishSession("000501")!;
    const original = demoEnglishRecord()!;
    session.messages.push({ id: "english-answer", role: "user", content: "我最需要练习解释证据", turn_id: "eng-turn",
      status: "complete", created_at: "2026-10-04T11:00:00Z" });
    session.english_progress = { ...initialEnglishProgress(), stage: "objectives", version: 1 };
    session.conversation.updated_at = "2026-10-04T11:00:00Z";
    session.conversation.request_count = 1;
    saveDemoEnglishSession(session);
    const synchronized = demoEnglishRecord(session.conversation.id)!;
    expect(synchronized.messages).toEqual(session.messages);
    expect(synchronized.english_progress).toEqual(session.english_progress);
    expect(synchronized.conversation).toMatchObject({ request_count: 1, updated_at: "2026-10-04T11:00:00Z",
      english_progress: session.english_progress });
    expect(synchronized.config).toEqual(original.config);
    const counts = demoEnglishCounts();
    const restored = nextEnrollment("000501");
    expect(restored).toEqual(session);
    expect(demoEnglishCounts()).toEqual(counts);
    expect(demoEnglishRecords()).toHaveLength(1);
    expect(demoEnglishRecord("not-present")).toBeNull();
  });

  it("retains earlier singleton sessions as unassigned legacy history rather than inventing a group", () => {
    const legacy: SessionPayload = {
      student_id: "LEGACY001",
      conversation: { id: "legacy-english", participant_code: "PEEC-DEMO-001", title: "英语助教", request_count: 2,
        created_at: "2026-09-20T08:00:00Z", updated_at: "2026-09-20T09:00:00Z" },
      messages: [{ id: "legacy-msg", role: "assistant", content: "旧学习回复", turn_id: "legacy-turn",
        status: "complete", created_at: "2026-09-20T09:00:00Z" }],
      settings: englishPublicSettings("旧英语课程告知"), enabled: true,
      english_progress: { ...initialEnglishProgress(), stage: "participatory", version: 7 },
    };
    storage.set(SESSION_KEY, JSON.stringify(legacy));
    expect(demoEnglishSession()).toEqual({ ...legacy, english_course: englishCourseOutline(), english_paused: false });
    const record = demoEnglishRecord()!;
    expect(record.conversation).toMatchObject({ group_code: null, model_factor: null, personality: null,
      assigned_at: null, experiment_id: null, experiment_revision: null, prompt_revision: null });
    expect(record.config).toMatchObject({ id: null, base_prompt: null, personality_prompt: null,
      prompt_revision: null, source_revision: null, created_at: null });
    expect(record.config.settings.model).toBe("");
    expect(record).not.toHaveProperty("connection");
    expect(record.messages).toEqual(legacy.messages);
    expect(record.english_progress).toEqual(legacy.english_progress);
    expect(demoEnglishCounts()).toEqual({ deepseek_personality: 0, deepseek_control: 0 });
    expect(demoEnglishRecords()).toHaveLength(1);
    const registered = nextEnrollment("ENG301");
    expect(demoEnglishRecord(registered.conversation.id)!.conversation.group_code).not.toBeNull();
    expect(demoEnglishRecords()).toHaveLength(2);
  });

  it("sanitizes restored and saved student sessions rather than leaking injected private fields", () => {
    const session = demoEnglishSession("ENG401")!;
    const polluted = { ...session,
      group_code: "deepseek_personality", base_prompt: "hidden-secret", api_key: "fake-secret-key",
      conversation: { ...session.conversation, group_code: "deepseek_personality", model_factor: "deepseek",
        config_id: "private-config", personality: true },
      settings: { ...session.settings, system_prompt: "hidden-secret", api_key: "fake-secret-key", model: "hidden-model" },
      question_progress: { unrelated: "Bloom" },
    } as unknown as SessionPayload;
    saveDemoEnglishSession(polluted);
    const clean = demoEnglishSession()!;
    expect(clean).toEqual(session);
    expect(storage.get(SESSION_KEY)).not.toMatch(/group_code|model_factor|config_id|personality|hidden-secret|fake-secret-key|hidden-model|question_progress/);
  });
});

describe("English demonstration curriculum snapshots", () => {
  it("starts with the custom first activity and restores only the registered course outline", () => {
    const config = demoEnglishConfig();
    const course = defaultEnglishCurriculum();
    course.bridge.description = "自定义导入说明";
    course.bridge.activities = [
      { title: "登记时导入一", prompt: "CUSTOM_BRIDGE_TASK_ONE", criterion: "PRIVATE_BRIDGE_CRITERION_ONE" },
      { title: "登记时导入二", prompt: "CUSTOM_BRIDGE_TASK_TWO", criterion: "PRIVATE_BRIDGE_CRITERION_TWO" },
    ];
    course.objectives.activities[0] = { title: "登记时目标", prompt: "CUSTOM_OBJECTIVES_TASK", criterion: "PRIVATE_OBJECTIVES_CRITERION" };
    config.curriculum = course; saveDemoEnglishConfig(config);
    const session = demoEnglishSession("COURSE001")!;
    expect(session.messages[0].content).toContain("CUSTOM_BRIDGE_TASK_ONE");
    expect(session.messages[0].content).not.toMatch(/PRIVATE_BRIDGE_CRITERION|CUSTOM_BRIDGE_TASK_TWO|CUSTOM_OBJECTIVES_TASK/);
    expect(session.english_course).toEqual(englishCourseOutline(course));
    expect(JSON.stringify(session.english_course)).not.toMatch(/prompt|criterion|word_limit|CUSTOM_.*TASK|PRIVATE_/);
    const frozen = demoEnglishRecord()!;
    expect(frozen.config.curriculum).toEqual(course);

    const nextConfig = demoEnglishConfig();
    nextConfig.revision++;
    nextConfig.curriculum.bridge.activities = [{ title: "下一版导入", prompt: "NEXT_COURSE_FIRST_TASK", criterion: "NEXT_COURSE_CRITERION" }];
    nextConfig.curriculum.objectives.activities[0].prompt = "NEXT_OBJECTIVES_TASK";
    saveDemoEnglishConfig(nextConfig);
    const restored = demoEnglishSession()!;
    expect(restored.english_course).toEqual(englishCourseOutline(course));
    restored.messages.push({ id: "course-answer", role: "user", content: "准备参与", turn_id: "course-turn-one",
      status: "complete", created_at: "" });
    const second = demoEnglishReply(restored);
    expect(second.english_progress).toMatchObject({ stage: "bridge", step: 1, version: 1 });
    expect(second.content).toContain("CUSTOM_BRIDGE_TASK_TWO");
    expect(second.content).not.toContain("NEXT_COURSE");
    restored.english_progress = second.english_progress;
    saveDemoEnglishSession(restored);
    const restoredAgain = demoEnglishSession()!;
    expect(restoredAgain.english_progress).toEqual(second.english_progress);
    restoredAgain.messages.push({ id: "course-answer-two", role: "user", content: "进入学习目标", turn_id: "course-turn-two",
      status: "complete", created_at: "" });
    const objectives = demoEnglishReply(restoredAgain);
    expect(objectives.english_progress).toMatchObject({ stage: "objectives", step: 0, version: 2 });
    expect(objectives.content).toContain("CUSTOM_OBJECTIVES_TASK");
    expect(objectives.content).not.toContain("NEXT_OBJECTIVES_TASK");
    expect(demoEnglishRecord(restored.conversation.id)!.config).toEqual(frozen.config);

    const nextSession = nextEnrollment("COURSE002");
    expect(nextSession.messages[0].content).toContain("NEXT_COURSE_FIRST_TASK");
    expect(nextSession.english_course!.bridge.activities).toEqual([{ title: "下一版导入" }]);
  });

  it("derives the public outline from the private snapshot rather than trusting a caller-supplied plan", () => {
    const session = demoEnglishSession("COURSE003")!;
    const original = session.english_course;
    const forged = { ...session, english_course: { bridge: { description: "PRIVATE_INJECTED_CRITERION", activities: [{
      title: "PRIVATE_INJECTED_TASK", criterion: "PRIVATE_INJECTED_CRITERION", prompt: "PRIVATE_INJECTED_TASK",
    }] } } } as unknown as SessionPayload;
    saveDemoEnglishSession(forged);
    expect(demoEnglishSession()!.english_course).toEqual(original);
    expect(storage.get(SESSION_KEY)).not.toContain("PRIVATE_INJECTED");
  });
});

describe("independent English demo conversation deletion", () => {
  it("prevents a deleted conversation from returning through late stream saves or stale-tab replies", () => {
    const stale = demoEnglishSession("STALE001")!;
    stale.messages.push({ id: "stale-user", role: "user", content: "旧页面作答", turn_id: "stale-turn", status: "complete", created_at: "" });
    const active = nextEnrollment("STALE002");
    deleteDemoEnglishConversation(stale.conversation.id);
    const retained = new Map(storage);
    for (const action of [() => demoEnglishReply(stale), () => saveDemoEnglishSession(stale)]) {
      let unavailable: unknown;
      try { action(); } catch (error) { unavailable = error; }
      expect(isDemoEnglishSessionUnavailable(unavailable)).toBe(true);
      expect(storage).toEqual(retained);
    }
    expect(demoEnglishRecords()).toHaveLength(1);
    expect(demoEnglishRecord(stale.conversation.id)).toBeNull();
    expect(demoEnglishSession()!.conversation.id).toBe(active.conversation.id);
    expect(Object.values(demoEnglishCounts()).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(storage.has("studychat.demo.english-attempts." + stale.conversation.id)).toBe(false);
    const deletedMarker = JSON.parse(storage.get("studychat.demo.english-deleted.v1")!);
    expect(deletedMarker).toEqual([stale.conversation.id]);
    expect(JSON.stringify(deletedMarker)).not.toMatch(/旧页面作答|STALE001|curriculum|group_code/);
  });

  it("discards a stale deleted singleton on restoration and permits a new registration with a fresh ID", () => {
    const deleted = demoEnglishSession("STALE003")!;
    deleteDemoEnglishConversation(deleted.conversation.id);
    storage.set(SESSION_KEY, JSON.stringify(deleted));
    expect(demoEnglishSession()).toBeNull();
    expect(storage.has(SESSION_KEY)).toBe(false);
    expect(demoEnglishCounts()).toEqual({ deepseek_personality: 0, deepseek_control: 0 });
    const fresh = demoEnglishSession("STALE003")!;
    expect(fresh.conversation.id).not.toBe(deleted.conversation.id);
    expect(demoEnglishRecords()).toHaveLength(1);
    expect(demoEnglishRecord(deleted.conversation.id)).toBeNull();
    expect(() => saveDemoEnglishSession(deleted)).toThrow("已删除或无法恢复");
    expect(demoEnglishSession()!.conversation.id).toBe(fresh.conversation.id);
  });

  it("rejects replies without a retained snapshot while allowing a genuine earlier singleton to import as legacy", () => {
    const session = demoEnglishSession("STALE004")!;
    const unknown = { ...session, conversation: { ...session.conversation, id: crypto.randomUUID() } };
    unknown.messages.push({ id: "unknown-user", role: "user", content: "无法关联的作答", turn_id: "unknown-turn", status: "complete", created_at: "" });
    expect(() => demoEnglishReply(unknown)).toThrow("已删除或无法恢复");
    expect(storage.has("studychat.demo.english-attempts." + unknown.conversation.id)).toBe(false);
    // An actual pre-grouping singleton is imported by restore before it can submit a reply.
    storage.delete("studychat.demo.english-records.v1");
    storage.set(SESSION_KEY, JSON.stringify(session));
    const legacy = demoEnglishSession()!;
    expect(demoEnglishRecord()!.conversation.group_code).toBeNull();
    expect(() => demoEnglishReply(legacy)).not.toThrow();
  });

  it("retains all other records when deleting an item from a later 50-record page", () => {
    const config = demoEnglishConfig();
    for (const stage of englishStages) config.curriculum[stage.id].activities = [{ title: "页内活动", prompt: "回答当前问题", criterion: "真实参与" }];
    saveDemoEnglishConfig(config);
    for (let index = 1; index <= 55; index++) nextEnrollment("PAGE" + String(index).padStart(3, "0"));
    const records = demoEnglishRecords();
    const target = records.slice(50, 100)[2];
    const expected = records.filter(record => record.id !== target.id).map(record => record.id);
    const singleton = storage.get(SESSION_KEY);
    deleteDemoEnglishConversation(target.id);
    expect(demoEnglishRecords().map(record => record.id)).toEqual(expected);
    expect(demoEnglishRecords().slice(50, 100)).toHaveLength(4);
    expect(storage.get(SESSION_KEY)).toBe(singleton);
    expect(Object.values(demoEnglishCounts()).reduce((sum, count) => sum + count, 0)).toBe(54);
  });

  it("deletes one archived record, its attempts and count while retaining the active English session and all other stores", () => {
    const bloom = demoSession("BLOOM_DELETE_KEEP")!;
    const teaching = demoEnglishConfig(); saveDemoEnglishConfig(teaching);
    storage.set("studychat.english.identity", "retain-independent-identity");
    const retainedKeys = new Map(storage);
    const first = demoEnglishSession("DELETE001")!;
    const middle = nextEnrollment("DELETE002");
    const active = nextEnrollment("DELETE003");
    for (const session of [middle, active]) {
      session.messages.push({ id: crypto.randomUUID(), role: "user", content: "演示作答", turn_id: crypto.randomUUID(), status: "complete", created_at: "" });
      demoEnglishReply(session);
    }
    const activeStore = storage.get(SESSION_KEY);
    const activeAttempts = storage.get("studychat.demo.english-attempts." + active.conversation.id);
    const group = demoEnglishRecord(middle.conversation.id)!.conversation.group_code!;
    const beforeCounts = demoEnglishCounts();
    deleteDemoEnglishConversation(middle.conversation.id);
    expect(demoEnglishRecords().map(record => record.id)).toEqual(expect.arrayContaining([first.conversation.id, active.conversation.id]));
    expect(demoEnglishRecords()).toHaveLength(2);
    expect(demoEnglishRecord(middle.conversation.id)).toBeNull();
    expect(demoEnglishCounts()[group]).toBe(beforeCounts[group] - 1);
    expect(storage.get(SESSION_KEY)).toBe(activeStore);
    expect(storage.has("studychat.demo.english-attempts." + middle.conversation.id)).toBe(false);
    expect(storage.get("studychat.demo.english-attempts." + active.conversation.id)).toBe(activeAttempts);
    for (const [key, value] of retainedKeys) expect(storage.get(key), key).toBe(value);
    expect(demoSession()!.conversation.id).toBe(bloom.conversation.id);

    deleteDemoEnglishConversation(active.conversation.id);
    expect(storage.has(SESSION_KEY)).toBe(false);
    expect(storage.has("studychat.demo.english-attempts." + active.conversation.id)).toBe(false);
    expect(demoEnglishRecords()).toHaveLength(1);
    expect(demoEnglishRecord(first.conversation.id)).not.toBeNull();
    const enrolledAgain = demoEnglishSession("DELETE002")!;
    expect(enrolledAgain.conversation.id).not.toBe(middle.conversation.id);
    expect(demoEnglishCounts()).toEqual({ deepseek_personality: 1, deepseek_control: 1 });
    expect(new Set(demoEnglishRecords().map(record => record.participant_code)).size).toBe(2);
  });

  it("rejects a Bloom-only or absent UUID without touching any English or general data", () => {
    const bloom = demoSession("BLOOM_ONLY")!;
    demoEnglishSession("DELETE004");
    const original = new Map(storage);
    expect(() => deleteDemoEnglishConversation(bloom.conversation.id)).toThrow("未找到此英语学习会话");
    expect(() => deleteDemoEnglishConversation(crypto.randomUUID())).toThrow("未找到此英语学习会话");
    expect(storage).toEqual(original);
  });

  it("refuses an active lease and allows deletion once it has expired", () => {
    const session = demoEnglishSession("DELETE005")!;
    session.conversation.locked_until = new Date(Date.now() + 60000).toISOString();
    saveDemoEnglishSession(session);
    const original = new Map(storage);
    expect(() => deleteDemoEnglishConversation(session.conversation.id)).toThrow("仍在生成回复");
    expect(storage).toEqual(original);
    session.conversation.locked_until = new Date(Date.now() - 1).toISOString();
    saveDemoEnglishSession(session);
    deleteDemoEnglishConversation(session.conversation.id);
    expect(demoEnglishRecords()).toEqual([]);
    expect(demoEnglishSession()).toBeNull();
    expect(demoEnglishCounts()).toEqual({ deepseek_personality: 0, deepseek_control: 0 });
  });
});
