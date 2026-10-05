import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { defaultSettings } from "@/lib/types";
import { initialEnglishProgress, advanceEnglishProgress, firstEnglishMessage, englishActivity,
  defaultEnglishCurriculum, englishCourseOutline, type EnglishProgress } from "@/lib/english-assistant";

const mocks = vi.hoisted(() => ({ user: vi.fn(), current: vi.fn(), from: vi.fn(), rpc: vi.fn(), generate: vi.fn(), decrypt: vi.fn(), bloom: vi.fn(), connection: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/http", async original => ({ ...await original<typeof import("@/lib/server/http")>(), requireUser: mocks.user }));
vi.mock("@/lib/server/english-settings", () => ({ currentEnglishConfiguration: mocks.current }));
vi.mock("@/lib/server/settings", () => ({ currentExperiment: mocks.bloom }));
vi.mock("@/lib/server/conversation-connection", () => ({ currentConversationConnection: mocks.connection }));
vi.mock("@/lib/server/provider", () => ({ generateReply: mocks.generate }));
vi.mock("@/lib/server/crypto", () => ({ decryptSecret: mocks.decrypt }));
import { POST as chat } from "@/app/api/english-assistant/chat/route";
import { GET as session, POST as register } from "@/app/api/english-assistant/session/route";
import { POST as normalChat } from "@/app/api/chat/route";
import { POST as learningControl } from "@/app/api/english-assistant/pause/route";
import { ENGLISH_PAUSE_MESSAGE, ENGLISH_RESUME_MESSAGE } from "@/lib/english-learning-pause";

const id = "11111111-1111-4111-8111-111111111111";
const normalId = "33333333-3333-4333-8333-333333333333";
const turnId = "22222222-2222-4222-8222-222222222222";
const settings = { ...defaultSettings, model: "unchanged-model", system_prompt: "replaced-base-prompt",
  api_base_url: "https://english.example/v1", temperature: 0.4 };
let progress: EnglishProgress;
let records: Record<string, { data: any; error: any }>;
let completed: boolean;
let restored: any;
let learningPaused: boolean;
const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
function req(extra: object = {}, signal?: AbortSignal, content = "学生证据") {
  return new Request("https://study.example/api/english-assistant/chat", { method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: id, turn_id: turnId,
      content, english_version: progress.version, ...extra }) });
}
function events(body: string) { return body.split("\n\n").filter(Boolean).map(line => JSON.parse(line.slice("data: ".length))); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("STUDY_ACCESS_CODE", "Bloom-code"); vi.stubEnv("ENGLISH_ASSISTANT_ACCESS_CODE", "");
  progress = initialEnglishProgress(); completed = false; learningPaused = false; queryCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.user.mockResolvedValue({ id: "owner" });
  mocks.current.mockResolvedValue({ config: { id: "english-config", settings, api_key_ciphertext: "english-cipher" },
    enabled: true, course: { disclosure: settings.disclosure, revision: 0, curriculum: defaultEnglishCurriculum() } });
  mocks.decrypt.mockReturnValue("transport-key");
  mocks.bloom.mockImplementation(() => { throw new Error("English must not read Bloom settings"); });
  mocks.connection.mockImplementation(() => { throw new Error("English must not read Bloom connection"); });
  mocks.generate.mockImplementation(async function* () {
    yield JSON.stringify({ achieved: true, evidence: "学生证据", feedback: "当前作答已收到。" });
  });
  restored = { id, config_id: "english-config", owner_id: "owner", student_id: "00123", title: "英语助教 · PEEC写作",
    participant_code: "EA-123", request_count: 0, created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z", lock_token: "private-lease" };
  records = {
    english_assistant_sessions: { data: { id, config_id: "english-config" }, error: null },
    english_assistant_configs: { data: { settings, api_key_ciphertext: "english-cipher" }, error: null },
    english_assistant_messages: { data: [{ role: "user", content: "学生证据" }], error: null },
    conversations: { data: null, error: null }
  };
  mocks.from.mockImplementation(table => {
    const query: any = { then: (resolve: any) => Promise.resolve(records[table]).then(resolve) };
    for (const method of ["select", "eq", "order", "single", "maybeSingle"]) query[method] = (...args: unknown[]) => {
      queryCalls.push({ table, method, args }); return query;
    };
    return query;
  });
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === "restore_english_session" || name === "register_english_session") {
      return { data: restored ? { ...restored, english_progress: progress, english_paused: learningPaused } : null, error: null };
    }
    if (name === "set_english_learning_pause") {
      learningPaused = args.p_paused;
      progress = { ...progress, version: progress.version + 1 };
      return { data: { user: { id, role: "user", content: args.p_content, status: "complete", turn_id: turnId, created_at: "2026-10-04T00:00:00Z", session_id: "private-session-id" },
        assistant: { id: normalId, role: "assistant", content: learningPaused ? ENGLISH_PAUSE_MESSAGE : ENGLISH_RESUME_MESSAGE, status: "complete", turn_id: turnId, created_at: "2026-10-04T00:00:00Z" },
        english_progress: progress, english_paused: learningPaused, lock_token: "private-lease" }, error: null };
    }
    if (name === "begin_english_turn" && learningPaused && !completed) return { data: null, error: { message: "ENGLISH_LEARNING_PAUSED" } };
    if (name === "begin_english_turn") return { data: { state: completed ? "complete" : "acquired", lock_token: "lease",
      english_progress: progress, english_paused: learningPaused, user: { id: "user", role: "user", content: args.p_content, status: "complete", turn_id: turnId },
      assistant: { id: "assistant", role: "assistant", content: completed ? "已保存的英语回复" : "",
        status: completed ? "complete" : "pending", turn_id: turnId } }, error: null };
    if (name === "save_english_reply") {
      if (args.p_status === "complete") progress = advanceEnglishProgress(progress, args.p_assessment.achieved, records.english_assistant_configs.data.curriculum);
      return { error: null, data: { english_progress: progress, message: { id: "assistant", role: "assistant",
        content: args.p_content, status: args.p_status, turn_id: turnId } } };
    }
    throw new Error("Unexpected non-English RPC " + name);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("English assistant HTTP isolation and BOPPPS execution", () => {
  it("restores only English history and public progress without exposing configuration or any Bloom fields", async () => {
    records.english_assistant_messages.data = [{ role: "assistant", content: firstEnglishMessage(), status: "complete" }];
    const response = await session(new Request("https://study.example/api/english-assistant/session"));
    expect(response.status).toBe(200); const result = await response.json();
    expect(result.student_id).toBe("00123"); expect(result.english_progress).toEqual(progress);
    expect(result.settings.assistant_name).toBe("英语助教"); expect(result.messages[0].content).toBe(firstEnglishMessage());
    expect(JSON.stringify(result)).not.toMatch(/config_id|owner_id|question_progress|group_code|api_key|system_prompt|english-cipher|private-lease/);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["restore_english_session"]);
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual(["english_assistant_configs", "english_assistant_messages"]);
    expect(mocks.bloom).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("returns independent registration settings and registers through the English identity binding only", async () => {
    restored = null;
    const missing = await session(new Request("https://study.example/api/english-assistant/session"));
    expect(await missing.json()).toMatchObject({ registration_required: true, enabled: true, settings: { title: "英语助教" } });
    restored = { id, student_id: "ABC_01", config_id: "english-config" };
    const response = await register(new Request("https://study.example/api/english-assistant/session", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ student_id: "abc_01" }) }));
    expect(response.status).toBe(200);
    expect(mocks.rpc.mock.calls.at(-1)).toEqual(["register_english_session", { p_owner: "owner", p_student_id: "ABC_01", p_initial_content: firstEnglishMessage(), p_expected_revision: 0 }]);
    expect(mocks.from.mock.calls.every(call => String(call[0]).startsWith("english_"))).toBe(true);
  });
  it("inherits the independent model parameters and replaces the base prompt with the current BOPPPS activity", async () => {
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const config = mocks.generate.mock.calls[0][0];
    expect(config).toMatchObject({ model: settings.model, protocol: settings.protocol, api_base_url: settings.api_base_url,
      temperature: settings.temperature, max_tokens: settings.max_tokens, token_parameter: settings.token_parameter });
    expect(config.system_prompt).toContain("BOPPPS"); expect(config.system_prompt).toContain(englishActivity(initialEnglishProgress()).criterion);
    expect(config.system_prompt).not.toContain(settings.system_prompt);
    expect(mocks.decrypt).toHaveBeenCalledWith("english-cipher");
    expect(mocks.bloom).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["begin_english_turn", "save_english_reply"]);
    expect(queryCalls).toContainEqual({ table: "english_assistant_sessions", method: "eq", args: ["owner_id", "owner"] });
    expect(body).toContain("本课学习目标"); expect(progress).toMatchObject({ stage: "objectives", version: 1 });
    expect(body).not.toMatch(/transport-key|english-cipher|"achieved"|"evidence"|question_progress/);
  });
  it.each(["deepseek_personality", "deepseek_control"])("uses shared DeepSeek transport and only the assigned English prompt condition: %s", async group => {
    records.english_assistant_sessions.data = { id, config_id: "english-config", model_factor: "deepseek", group_code: group };
    records.english_assistant_configs.data = { settings: { ...settings, question_mode: { enabled: true } },
      api_key_ciphertext: "old-cipher", base_prompt: "ENGLISH_TEACHER_BASE", personality_prompt: "ENGLISH_PERSONA" };
    mocks.connection.mockResolvedValue({ settings: { ...settings, api_base_url: "https://shared-deepseek.example/v1" },
      api_key_ciphertext: "shared-deepseek-cipher", info: { source: "latest" } });
    await (await chat(req())).text();
    expect(mocks.connection).toHaveBeenCalledWith(expect.objectContaining({ model: settings.model }), "deepseek");
    expect(mocks.decrypt).toHaveBeenCalledWith("shared-deepseek-cipher");
    const generated = mocks.generate.mock.calls[0][0];
    expect(generated.api_base_url).toBe("https://shared-deepseek.example/v1");
    expect(generated.question_mode).toBeUndefined();
    expect(generated.system_prompt).toContain("ENGLISH_TEACHER_BASE");
    expect(generated.system_prompt).toContain("不可更改的教学流程");
    if (group === "deepseek_personality") expect(generated.system_prompt).toContain("ENGLISH_PERSONA");
    else expect(generated.system_prompt).not.toContain("ENGLISH_PERSONA");
  });
  it("does not show any next activity until the reply and progress commit together", async () => {
    let resolveSave: ((value: any) => void) | undefined;
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "save_english_reply" && args.p_status === "complete"
      ? await new Promise(resolve => { resolveSave = resolve; }) : original(name, args));
    const response = await chat(req()); const reader = response.body!.getReader(); const decoder = new TextDecoder();
    const first = await reader.read(); expect(decoder.decode(first.value)).toContain('"type":"accepted"');
    let nextArrived = false; const nextChunk = reader.read().then(value => { nextArrived = true; return value; });
    await vi.waitFor(() => expect(resolveSave).toBeDefined());
    expect(nextArrived).toBe(false);
    const savedCall = mocks.rpc.mock.calls.find(call => call[0] === "save_english_reply")![1];
    expect(savedCall.p_content).toContain("本课学习目标");
    progress = advanceEnglishProgress(progress, true);
    resolveSave!({ error: null, data: { message: { role: "assistant", content: savedCall.p_content, status: "complete" }, english_progress: progress } });
    const chunk = await nextChunk; expect(decoder.decode(chunk.value)).toContain('"type":"delta"');
    await reader.cancel();
  });
  it("holds an unfinished practice on the same activity and permits front-test uncertainty without blocking", async () => {
    progress = { stage: "participatory", step: 1, version: 6, completed: false };
    mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: false, evidence: "", feedback: "请再补充一个具体的阅读例子。" }); });
    let body = await (await chat(req())).text();
    expect(body).toContain("请再补充一个具体的阅读例子"); expect(progress).toEqual({ stage: "participatory", step: 1, version: 7, completed: false });
    progress = { stage: "pre_assessment", step: 2, version: 4, completed: false };
    body = await (await chat(req({}, undefined, "不会"))).text();
    expect(progress).toEqual({ stage: "participatory", step: 0, version: 5, completed: false });
    expect(body).toContain("选择清楚、具体的 Point");
  });
  it("refuses a model's attempt to advance practice on a bare confirmation or request to skip", async () => {
    for (const answer of ["懂了", "请跳过当前阶段"]) {
      progress = { stage: "participatory", step: 0, version: 5, completed: false };
      mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: true, evidence: answer, feedback: "错误的跳过反馈" }); });
      const body = await (await chat(req({}, undefined, answer))).text();
      expect(progress).toEqual({ stage: "participatory", step: 0, version: 6, completed: false });
      expect(body).not.toContain("错误的跳过反馈");
    }
  });
  it.each(["not json", '{"achieved":true', JSON.stringify({ achieved: true, evidence: "伪造内容", feedback: "错误输出" })])
  ("repairs malformed or unsupported assessment once and commits only validated output: %s", async raw => {
    mocks.generate.mockImplementationOnce(async function* () { yield raw; });
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1][0].system_prompt).not.toBe(mocks.generate.mock.calls[0][0].system_prompt);
    expect(mocks.generate.mock.calls[1][1]).toEqual(mocks.generate.mock.calls[0][1]);
    expect(mocks.generate.mock.calls[1][2]).toBe(mocks.generate.mock.calls[0][2]);
    expect(mocks.rpc.mock.calls.filter(call => call[0] === "begin_english_turn")).toHaveLength(1);
    expect(mocks.rpc.mock.calls.filter(call => call[0] === "save_english_reply")).toHaveLength(1);
    expect(body).toContain('"type":"done"'); expect(body).not.toContain(raw);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/学生证据|伪造内容|错误输出|transport-key/);
  });
  it("leaves the current activity retryable after two invalid responses or a provider failure", async () => {
    const before = structuredClone(progress);
    mocks.generate.mockImplementation(async function* () { yield "invalid protocol"; });
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(2); expect(progress).toEqual(before);
    expect(body).toContain('"type":"error"'); expect(body).not.toMatch(/"type":"done"|invalid protocol|本课学习目标/);
    expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_status: "failed", p_content: "", p_assessment: null });
    mocks.generate.mockImplementation(async function* () { throw new Error("AI 服务暂不可用（HTTP 503）"); });
    const providerBody = await (await chat(req())).text();
    expect(providerBody).toContain("AI 服务暂不可用"); expect(progress).toEqual(before);
  });
  it("recovers an already committed retry without a provider call, decryption or another save", async () => {
    completed = true; progress = { stage: "summary", step: 0, version: 12, completed: true };
    const body = await (await chat(req({ english_version: 0 }))).text();
    expect(body).toContain("已保存的英语回复"); expect(events(body).at(-1).english_progress).toEqual(progress);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["begin_english_turn"]);
  });
  it("does not commit after client abort even if the model ignores cancellation", async () => {
    const controller = new AbortController(); const before = structuredClone(progress);
    mocks.generate.mockImplementation(async function* () { controller.abort(); yield JSON.stringify({ achieved: true, evidence: "学生证据", feedback: "错误输出" }); });
    const body = await (await chat(req({}, controller.signal))).text();
    expect(body).toContain('"type":"error"'); expect(body).not.toMatch(/错误输出|"type":"done"/);
    expect(progress).toEqual(before); expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_status: "failed", p_error: "interrupted" });
  });
  it("shares the original timeout across its repair attempt", async () => {
    vi.useFakeTimers();
    mocks.generate.mockImplementationOnce(async function* () {
      await new Promise(resolve => setTimeout(resolve, 90000)); yield "invalid protocol";
    }).mockImplementationOnce(async function* (_config, _history, signal: AbortSignal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    });
    const response = await chat(req()); const promise = response.text();
    await vi.advanceTimersByTimeAsync(90000); expect(mocks.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    const body = await promise; expect(body).toContain('"type":"error"'); expect(progress).toEqual(initialEnglishProgress());
    expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_status: "failed", p_error: "interrupted" });
  });
  it("never announces the next stage when the database save fails", async () => {
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "save_english_reply" && args.p_status === "complete"
      ? { data: null, error: { message: "WRITE_FAILED" } } : original(name, args));
    const body = await (await chat(req())).text();
    expect(body).not.toMatch(/本课学习目标|"type":"done"/); expect(body).toContain('"type":"error"');
    expect(progress).toEqual(initialEnglishProgress());
  });
  it("rejects missing versions, forged control fields, foreign English sessions and ordinary session IDs before generation", async () => {
    for (const extra of [{ english_version: undefined }, { stage: "summary" }, { step: 3 }, { question_version: 1 }]) {
      expect((await chat(req(extra))).status).toBe(400);
    }
    records.english_assistant_sessions.data = null;
    expect((await chat(req({ conversation_id: normalId }))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
    const normal = await normalChat(new Request("https://study.example/api/chat", { method: "POST",
      headers: { "Content-Type": "application/json", "x-study-code": "Bloom-code" },
      body: JSON.stringify({ conversation_id: id, turn_id: turnId, content: "student" }) }));
    expect(normal.status).toBe(403); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("uses the separate English access code and reports missing migrations without revealing database details", async () => {
    vi.stubEnv("ENGLISH_ASSISTANT_ACCESS_CODE", "English-code");
    expect((await chat(req())).status).toBe(403);
    const request = req(); request.headers.set("x-study-code", "English-code");
    expect((await chat(request)).status).toBe(200);
    vi.stubEnv("ENGLISH_ASSISTANT_ACCESS_CODE", "");
    records.english_assistant_sessions.error = { code: "42P01", message: "private database detail" };
    const missing = await chat(req()); expect(missing.status).toBe(503);
    expect(await missing.text()).toContain("005_english_assistant.sql");
  });
  it("registers the published first task with its expected revision and returns only the frozen safe outline", async () => {
    const curriculum = defaultEnglishCurriculum();
    curriculum.bridge = { description: "专属课程导入", activities: [{ title: "自定义任务", prompt: "请描述一段写作体验", criterion: "INTERNAL_PASS_CRITERION" }] };
    mocks.current.mockResolvedValue({ enabled: true, course: { disclosure: settings.disclosure, revision: 5, curriculum } });
    records.english_assistant_configs.data.curriculum = curriculum;
    const response = await register(new Request("https://study.example/api/english-assistant/session", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ student_id: "00123" }) }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.rpc.mock.calls[0]).toEqual(["register_english_session", { p_owner: "owner", p_student_id: "00123",
      p_initial_content: firstEnglishMessage(curriculum), p_expected_revision: 5 }]);
    expect(data.english_course).toEqual(englishCourseOutline(curriculum));
    expect(JSON.stringify(data)).not.toMatch(/INTERNAL_PASS_CRITERION|criterion|word_limit|请描述一段写作体验/);
    mocks.rpc.mockResolvedValueOnce({ error: { message: "CONFLICT" }, data: null });
    expect((await register(new Request("https://study.example/api/english-assistant/session", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ student_id: "new_student" }) }))).status).toBe(409);
  });
  it("runs custom activity counts from the snapshot and ignores the latest course for existing sessions", async () => {
    const snapshot = defaultEnglishCurriculum();
    snapshot.bridge.activities.push({ title: "冻结的第二个导入", prompt: "SNAPSHOT_TASK", criterion: "SNAPSHOT_CRITERION" });
    const latest = defaultEnglishCurriculum(); latest.bridge.activities[0].prompt = "LATEST_TASK";
    records.english_assistant_configs.data.curriculum = snapshot;
    mocks.current.mockResolvedValue({ enabled: true, course: { disclosure: settings.disclosure, revision: 9, curriculum: latest } });
    const first = await (await chat(req())).text();
    expect(progress).toMatchObject({ stage: "bridge", step: 1, version: 1 });
    expect(first).toContain("SNAPSHOT_TASK"); expect(first).not.toContain("LATEST_TASK");
    const restore = await (await session(new Request("https://study.example/api/english-assistant/session"))).json();
    expect(restore.english_course.bridge.activities).toHaveLength(2);
    const second = await (await chat(req())).text();
    expect(second).toContain("本课学习目标");
    expect(mocks.generate.mock.calls.at(-1)?.[0].system_prompt).toContain("SNAPSHOT_CRITERION");
    expect(mocks.generate.mock.calls.at(-1)?.[0].system_prompt).toContain("当前活动序号：2/2");
    records.english_assistant_configs.data.curriculum = null; progress = initialEnglishProgress();
    expect((await (await session(new Request("https://study.example/api/english-assistant/session"))).json()).english_course).toEqual(englishCourseOutline());
    expect(await (await chat(req())).text()).toContain("本课学习目标");
  });
  it("holds writing by the snapshot word limit and completes every custom summary activity", async () => {
    const curriculum = defaultEnglishCurriculum();
    curriculum.participatory.activities[0].word_limit = { min: 5, max: 8 };
    curriculum.summary.activities.push({ title: "第二项反思", prompt: "下一次练习计划", criterion: "参加反思" });
    records.english_assistant_configs.data.curriculum = curriculum;
    progress = { stage: "participatory", step: 0, version: 5, completed: false };
    mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: true, evidence: "Reading", feedback: "具体反馈" }); });
    const short = await (await chat(req({}, undefined, "Reading is useful."))).text();
    expect(short).toContain("5–8"); expect(progress.step).toBe(0);
    await (await chat(req({}, undefined, "Reading helps us understand other people."))).text();
    expect(progress.step).toBe(1);
    mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: false, evidence: "", feedback: "你的反思已记录。" }); });
    progress = { stage: "summary", step: 0, version: 12, completed: false };
    const summary = await (await chat(req())).text();
    expect(progress).toMatchObject({ stage: "summary", step: 1, completed: false });
    expect(summary).toContain("下一次练习计划"); expect(summary).not.toContain("学习已完成");
    await (await chat(req())).text();
    expect(progress.completed).toBe(true);
  });
  it.each(["bridge", "pre_assessment", "participatory", "post_assessment", "summary"] as const)
  ("pauses a stop request in %s without invoking or evaluating through the model", async stage => {
    progress = { stage, step: 0, version: 7, completed: false };
    const body = await (await chat(req({}, undefined, "我不想学了"))).text();
    expect(progress).toEqual({ stage, step: 0, version: 8, completed: false });
    expect(events(body).at(-1)).toMatchObject({ type: "done", english_paused: true, english_progress: progress });
    expect(body).toContain(ENGLISH_PAUSE_MESSAGE);
    expect(body).not.toMatch(/private-session-id|private-lease|SNAPSHOT_CRITERION/);
    expect(mocks.rpc.mock.calls).toEqual([["set_english_learning_pause", { p_session: id, p_owner: "owner", p_turn: turnId,
      p_content: "我不想学了", p_version: 7, p_paused: true }]]);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual(["english_assistant_sessions"]);
  });
  it("restores the student's pause and refuses teaching until resume without changing the activity", async () => {
    learningPaused = true;
    expect((await (await session(new Request("https://study.example/api/english-assistant/session"))).json()).english_paused).toBe(true);
    expect((await chat(req())).status).toBe(409);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(progress.version).toBe(0);
    const before = { ...progress };
    const response = await learningControl(new Request("https://study.example/api/english-assistant/pause", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: id, turn_id: turnId,
        content: "继续学习", english_version: before.version, paused: false }) }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ english_paused: false, english_progress: { ...before, version: before.version + 1 } });
    expect(data.assistant.content).toBe(ENGLISH_RESUME_MESSAGE);
    expect(JSON.stringify(data)).not.toMatch(/private-session-id|private-lease|owner_id|config_id/);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("keeps a negative difficulty or quoted stopping phrase in the normal tutoring flow", async () => {
    for (const answer of ["这题太难了", "我不会", "把“不想学了”翻译成英文"]) {
      mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: false, evidence: "", feedback: "请说说你现在的想法。" }); });
      await (await chat(req({}, undefined, answer))).text();
    }
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    expect(mocks.rpc.mock.calls.some(call => call[0] === "set_english_learning_pause")).toBe(false);
    expect(learningPaused).toBe(false);
  });
  it("preserves the latest paused state when replaying a completed teaching turn", async () => {
    learningPaused = true; completed = true;
    const body = await (await chat(req())).text();
    expect(events(body).at(-1).english_paused).toBe(true);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("validates control requests, uses only the authenticated English identity and enforces its access code", async () => {
    function control(extra: object = {}) {
      return new Request("https://study.example/api/english-assistant/pause", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: id, turn_id: turnId, content: "暂停学习", english_version: 0, paused: true, ...extra }) });
    }
    for (const extra of [{ paused: "true" }, { english_version: undefined }, { english_version: -1 }, { turn_id: "forged" },
      { owner_id: "another" }, { question_version: 1 }, { content: " " }, { english_progress: { stage: "summary" } }]) {
      expect((await learningControl(control(extra))).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    vi.stubEnv("ENGLISH_ASSISTANT_ACCESS_CODE", "English-only");
    expect((await learningControl(control())).status).toBe(403);
    const allowed = control(); allowed.headers.set("x-study-code", "English-only");
    expect((await learningControl(allowed)).status).toBe(200);
    expect(mocks.rpc.mock.calls[0][1].p_owner).toBe("owner");
  });
  it("reports control conflicts and the 008 migration without exposing private database errors", async () => {
    function control() { return new Request("https://study.example/api/english-assistant/pause", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: id, turn_id: turnId, content: "暂停学习", english_version: 0, paused: true }) }); }
    for (const [message, status] of [["FORBIDDEN", 403], ["BUSY", 409], ["ENGLISH_STATE_CONFLICT", 409], ["ENGLISH_COMPLETED", 409], ["INVALID_ENGLISH_CONTROL", 400]] as const) {
      mocks.rpc.mockResolvedValueOnce({ data: null, error: { message } });
      expect((await learningControl(control())).status).toBe(status);
    }
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "private-db-schema" } });
    const missing = await learningControl(control());
    expect(missing.status).toBe(503); const text = await missing.text();
    expect(text).toContain("008_english_learning_pause.sql"); expect(text).not.toContain("private-db-schema");
  });
});
