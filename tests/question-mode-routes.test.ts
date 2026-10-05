import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { defaultQuestionMode, initialQuestionProgress, nextQuestionProgress, firstQuestionMessage, questionText } from "@/lib/question-mode";
import { defaultSettings } from "@/lib/types";
const mocks = vi.hoisted(() => ({ user: vi.fn(), current: vi.fn(), from: vi.fn(), rpc: vi.fn(), connection: vi.fn(), generate: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/http", async original => ({ ...await original<typeof import("@/lib/server/http")>(), requireUser: mocks.user }));
vi.mock("@/lib/server/settings", () => ({ currentExperiment: mocks.current }));
vi.mock("@/lib/server/conversation-connection", () => ({ currentConversationConnection: mocks.connection }));
vi.mock("@/lib/server/provider", () => ({ generateReply: mocks.generate }));
vi.mock("@/lib/server/crypto", () => ({ decryptSecret: mocks.decrypt }));
import { POST as chat } from "@/app/api/chat/route";
import { GET as session } from "@/app/api/session/route";

const id = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const settings = { ...defaultSettings, model: "frozen-model", system_prompt: "saved-base\n\nsaved-personality", question_mode: { ...defaultQuestionMode(), enabled: true } };
let progress = initialQuestionProgress();
let records: Record<string, { data: any; error: any }>;
let completed = false;
function req(extra: object = {}, signal?: AbortSignal) { return new Request("https://study.example/api/chat", { method: "POST", signal, headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ conversation_id: id, turn_id: turnId, content: "学生证据", question_version: progress.version, ...extra }) }); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("STUDY_ACCESS_CODE", ""); progress = initialQuestionProgress(); completed = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.user.mockResolvedValue({ id: "owner" }); mocks.current.mockResolvedValue({ config: null, enabled: true });
  mocks.decrypt.mockReturnValue("transport-key");
  mocks.connection.mockResolvedValue({ info: { source: "latest" }, settings: { ...settings, api_base_url: "https://new.example/v1" }, api_key_ciphertext: "new-key" });
  mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: true, observed_level: "create", evidence: "学生证据", reply: "你的方案有依据。" }); });
  records = {
    conversations: { data: { id, config_id: "frozen-config" }, error: null },
    config_versions: { data: { settings, api_key_ciphertext: "old-key" }, error: null },
    participant_enrollments: { data: { group_code: "chatgpt_control", student_id: "00123" }, error: null },
    messages: { data: [{ role: "user", content: "学生证据" }], error: null },
    study_state: { data: { enabled: true }, error: null }
  };
  mocks.from.mockImplementation(table => {
    const query: any = { then: (resolve: any) => Promise.resolve(records[table]).then(resolve) };
    for (const method of ["select", "eq", "order", "single", "maybeSingle"]) query[method] = () => query;
    return query;
  });
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === "restore_conversation") return { data: { id, config_id: "frozen-config", owner_id: "owner", title: "尚未开始对话" }, error: null };
    if (name === "ensure_question_session") return { data: progress, error: null };
    if (name === "begin_question_turn") return { data: { state: completed ? "complete" : "acquired", lock_token: "lease", question_progress: progress,
      user: { id: "user", role: "user", content: "学生证据", turn_id: turnId },
      assistant: { id: "assistant", role: "assistant", content: completed ? "已保存的回复" : "", status: completed ? "complete" : "pending", turn_id: turnId } }, error: null };
    if (name === "save_question_reply") {
      progress = nextQuestionProgress(progress, args.p_assessment?.achieved ?? true);
      return { error: null, data: { question_progress: progress, message: { id: "assistant", role: "assistant", content: args.p_content, status: "complete", turn_id: turnId } } };
    }
    return { error: null, data: {} };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("question mode HTTP execution", () => {
  it("initializes the opening during restore and returns only public progress, not future questions or reference answers", async () => {
    mocks.rpc.mockImplementation(async name => {
      if (name === "restore_conversation") return { data: { id, config_id: "frozen-config", title: "尚未开始对话" }, error: null };
      if (name === "ensure_question_session") {
        records.messages.data = [{ role: "assistant", content: firstQuestionMessage(settings.question_mode), status: "complete" }];
        return { data: progress, error: null };
      }
    });
    const response = await session(new Request("https://study.example/api/session"));
    expect(response.status).toBe(200); const result = await response.json();
    expect(result.question_progress).toEqual(progress);
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(settings.question_mode.questions[1].prompt);
    expect(JSON.stringify(result)).not.toMatch(/target_level|reference|system_prompt|group_code|old-key/);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("judges the current question using the frozen base/personality and current connection, then commits before sending the next question", async () => {
    const response = await chat(req()); const body = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.connection).toHaveBeenCalledWith(settings, "chatgpt");
    const providerSettings = mocks.generate.mock.calls[0][0];
    expect(providerSettings.system_prompt.startsWith(settings.system_prompt)).toBe(true);
    expect(providerSettings.system_prompt).toContain(settings.question_mode.questions[0].reference);
    expect(providerSettings.system_prompt).not.toContain(settings.question_mode.questions[1].reference);
    expect(body).toContain(settings.question_mode.questions[1].title);
    expect(body).toContain("作答已收到。");
    expect(body).not.toContain("你的方案有依据。");
    expect(body).not.toMatch(/observed_level|transport-key|new-key|saved-personality/);
    expect(mocks.rpc.mock.calls.map(c => c[0])).toEqual(["ensure_question_session", "begin_question_turn", "save_question_reply"]);
    expect(progress).toMatchObject({ phase: "guided", question_index: 1 });
  });
  it("does not expose a model's successful assessment or extra question in the acknowledgement", async () => {
    mocks.generate.mockImplementation(async function* () {
      yield JSON.stringify({ achieved: true, observed_level: "create", evidence: "学生证据", reply: "你很优秀，已达到创造层！你下一步想怎样做？" });
    });
    const body = await (await chat(req())).text();
    const save = mocks.rpc.mock.calls.find(c => c[0] === "save_question_reply")!;
    expect(save[1].p_assessment).toMatchObject({ achieved: true, observed_level: "create", evidence: "学生证据", reply: "作答已收到。" });
    expect(save[1].p_content).toBe("作答已收到。\n\n" + questionText(settings.question_mode, 1));
    expect(body).not.toMatch(/很优秀|达到创造层|下一步想怎样做/);
    expect(progress).toMatchObject({ question_index: 1 });
  });
  it("restores legacy question notices neutrally without rewriting stored assistant messages or student answers", async () => {
    const oldOpening = "第一轮 · 引导学习\n\n### 第 1 题 / 3：旧标题\n\n旧题干\n\n请先说说你的想法，我们会从你的回答开始。";
    records.messages.data = [{ role: "assistant", content: oldOpening }, { role: "user", content: oldOpening }];
    const original = structuredClone(records.messages.data);
    records.config_versions.data = { settings: { ...settings, title: "研究对话", assistant_name: "研究助手",
      disclosure: "学号用于关联本项研究的对话记录。对话将被保存并用于研究；请勿在聊天中输入姓名、联系方式或其他敏感个人信息。" } };
    const response = await session(new Request("https://study.example/api/session"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.messages[0].content).toBe("第一轮\n\n### 第 1 题 / 3：旧标题\n\n旧题干");
    expect(result.messages[1].content).toBe(oldOpening);
    expect(JSON.stringify(result.settings)).not.toMatch(/研究|实验|引导/);
    expect(records.messages.data).toEqual(original);
    expect(records.config_versions.data.settings.title).toBe("研究对话");
    expect(mocks.rpc.mock.calls.map(c => c[0])).toEqual(["restore_conversation", "ensure_question_session"]);
  });
  it("stays on the same question while guidance is incomplete", async () => {
    mocks.generate.mockImplementation(async function* () { yield JSON.stringify({ achieved: false, observed_level: "understand", evidence: "", reply: "请给出一个比较依据？" }); });
    const body = await (await chat(req())).text();
    expect(body).toContain("请给出一个比较依据"); expect(body).not.toContain(settings.question_mode.questions[1].title);
    expect(progress).toMatchObject({ question_index: 0, guidance_turns: 1, version: 1 });
  });
  it("persists and streams real paragraph breaks from a double-escaped model reply", async () => {
    const reply = "一名同学睡着后仍有脑电活动。\\n\\n这个现象能说明什么？";
    mocks.generate.mockImplementation(async function* () {
      yield JSON.stringify({ achieved: false, observed_level: "understand", evidence: "", reply });
    });
    const body = await (await chat(req())).text();
    const content = "一名同学睡着后仍有脑电活动。\n\n这个现象能说明什么？";
    const save = mocks.rpc.mock.calls.find(c => c[0] === "save_question_reply")!;
    expect(save[1].p_content).toBe(content);
    expect(save[1].p_assessment.reply).toBe(content);
    const events = body.split("\n\n").filter(Boolean).map(line => JSON.parse(line.slice("data: ".length)));
    expect(events.find(event => event.type === "delta").text).toBe(content);
    expect(events.find(event => event.type === "done").message.content).toBe(content);
    expect(progress).toMatchObject({ question_index: 0, guidance_turns: 1 });
  });
  it.each([0, 1, 2])("retest question %i saves any answer without calling the model, connection lookup or decryption", async index => {
    progress = { phase: "retest", question_index: index, guidance_turns: 0, version: 8 + index };
    const body = await (await chat(req({ content: "我不知道" }))).text();
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
    const save = mocks.rpc.mock.calls.find(c => c[0] === "save_question_reply")!;
    expect(save[1].p_assessment).toBeNull();
    expect(body).not.toContain("你的方案有依据");
    expect(progress.phase).toBe(index === 2 ? "completed" : "retest");
  });
  it("recovers a committed retry without another provider call, save or transition", async () => {
    completed = true; progress = { phase: "completed", question_index: 2, guidance_turns: 0, version: 10 };
    const body = await (await chat(req({ question_version: 9 }))).text();
    expect(body).toContain("已保存的回复"); expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(c => c[0] === "save_question_reply")).toBe(false);
  });
  it.each([
    "plain text", '{"achieved":true',
    JSON.stringify({ achieved: true, observed_level: "create", evidence: "伪造", reply: "错误回复标记" }),
    JSON.stringify({ achieved: true, observed_level: "create", evidence: "", reply: "错误回复标记" }),
    JSON.stringify({ achieved: true, observed_level: "understand", evidence: "学生证据", reply: "错误回复标记" })
  ])("repairs invalid assessment once before a single validated save: %s", async raw => {
    const originalMessages = structuredClone(records.messages.data);
    mocks.generate.mockImplementationOnce(async function* () { yield raw; });
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    for (const call of mocks.generate.mock.calls) expect(call[1]).toEqual(originalMessages);
    expect(mocks.generate.mock.calls[1][0].system_prompt).not.toBe(mocks.generate.mock.calls[0][0].system_prompt);
    expect(mocks.generate.mock.calls[1][2]).toBe(mocks.generate.mock.calls[0][2]);
    expect(mocks.rpc.mock.calls.filter(call => call[0] === "begin_question_turn")).toHaveLength(1);
    expect(mocks.rpc.mock.calls.filter(call => call[0] === "save_question_reply")).toHaveLength(1);
    expect(mocks.rpc.mock.calls.some(call => call[0] === "save_reply")).toBe(false);
    expect(body).toContain('"type":"done"'); expect(body).not.toContain('"type":"error"');
    expect(body).not.toContain(raw); expect(body).not.toContain("错误回复标记");
    expect(progress).toMatchObject({ question_index: 1, version: 1 });
    const diagnostic = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(diagnostic).not.toMatch(/学生证据|错误回复标记|transport-key|伪造/);
  });
  it("can correct an inconsistent success to valid continued guidance without raising the level", async () => {
    mocks.generate.mockImplementationOnce(async function* () {
      yield JSON.stringify({ achieved: true, observed_level: "understand", evidence: "学生证据", reply: "错误的达标通知" });
    }).mockImplementationOnce(async function* () {
      yield JSON.stringify({ achieved: false, observed_level: "understand", evidence: "学生证据", reply: "哪一项观察支持这个解释？" });
    });
    const body = await (await chat(req())).text();
    const save = mocks.rpc.mock.calls.find(call => call[0] === "save_question_reply")!;
    expect(save[1].p_assessment).toMatchObject({ achieved: false, observed_level: "understand" });
    expect(body).toContain("哪一项观察支持这个解释？"); expect(body).not.toContain("错误的达标通知");
    expect(progress).toMatchObject({ question_index: 0, guidance_turns: 1, version: 1 });
  });
  it.each(["plain text", '{"achieved":true', JSON.stringify({ achieved: true, observed_level: "create", evidence: "伪造", reply: "错误回复标记" })])("continues neutrally on the same question after two invalid assessments: %s", async raw => {
    mocks.generate.mockImplementation(async function* () { yield raw; });
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(body).toContain('"type":"done"'); expect(body).not.toContain('"type":"error"');
    expect(body).not.toContain(raw); expect(body).not.toContain("错误回复标记");
    const saves = mocks.rpc.mock.calls.filter(call => call[0] === "save_question_reply");
    expect(saves).toHaveLength(1);
    expect(saves[0][1].p_assessment).toEqual({ achieved: false, observed_level: "unassessed", evidence: "",
      reply: "把刚才的想法联系起来，你能用一两句话说明你的解释和依据吗？" });
    expect(saves[0][1].p_content).toBe(saves[0][1].p_assessment.reply);
    expect(progress).toMatchObject({ question_index: 0, guidance_turns: 1, version: 1 });
    expect(mocks.rpc.mock.calls.some(call => call[0] === "save_reply")).toBe(false);
  });
  it("keeps cumulative current-question context but never accepts an earlier answer as the latest evidence", async () => {
    progress = { phase: "guided", question_index: 1, guidance_turns: 2, version: 4 };
    records.messages.data = [
      { role: "assistant", content: firstQuestionMessage(settings.question_mode) },
      { role: "user", content: "前题证据" },
      { role: "assistant", content: questionText(settings.question_mode, 1) },
      { role: "user", content: "本题先前的解释" },
      { role: "assistant", content: "这一点与哪个观察有关？" },
      { role: "user", content: "学生证据" }
    ];
    mocks.generate.mockImplementationOnce(async function* () {
      yield JSON.stringify({ achieved: true, observed_level: "create", evidence: "本题先前的解释", reply: "错误的达标通知" });
    });
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    for (const call of mocks.generate.mock.calls) expect(call[1]).toEqual(records.messages.data.slice(3));
    const save = mocks.rpc.mock.calls.find(call => call[0] === "save_question_reply")!;
    expect(save[1].p_assessment).toMatchObject({ achieved: true, observed_level: "create", evidence: "学生证据" });
    expect(body).not.toContain("错误的达标通知");
    expect(progress).toMatchObject({ question_index: 2, version: 5 });
  });
  it.each([1, 2])("does not mask a provider failure on attempt %i with fallback guidance", async failedAttempt => {
    let attempt = 0;
    mocks.generate.mockImplementation(async function* () {
      if (++attempt === failedAttempt) throw new Error("AI 服务暂不可用（HTTP 503）");
      yield "invalid assessment";
    });
    const body = await (await chat(req())).text();
    expect(mocks.generate).toHaveBeenCalledTimes(failedAttempt);
    expect(body).toContain('"type":"error"'); expect(body).not.toContain('"type":"done"');
    expect(mocks.rpc.mock.calls.some(call => call[0] === "save_question_reply")).toBe(false);
    expect(progress).toEqual(initialQuestionProgress());
  });
  it("does not save a repair or fallback after a client abort even if the provider ignores cancellation", async () => {
    const controller = new AbortController();
    mocks.generate.mockImplementationOnce(async function* () { yield "invalid assessment"; })
      .mockImplementationOnce(async function* () { controller.abort(); yield "another invalid assessment"; });
    const body = await (await chat(req({}, controller.signal))).text();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1][2]).toBe(mocks.generate.mock.calls[0][2]);
    expect(mocks.generate.mock.calls[1][2].aborted).toBe(true);
    expect(body).toContain('"type":"error"'); expect(body).not.toContain('"type":"done"');
    expect(mocks.rpc.mock.calls.some(call => call[0] === "save_question_reply")).toBe(false);
    expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_status: "failed", p_error: "interrupted" });
    expect(progress).toEqual(initialQuestionProgress());
  });
  it("shares the original request timeout with the repair attempt", async () => {
    vi.useFakeTimers();
    mocks.generate.mockImplementationOnce(async function* () {
      await new Promise(resolve => setTimeout(resolve, 90000));
      yield "invalid assessment";
    }).mockImplementationOnce(async function* (_config, _messages, signal: AbortSignal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("connection aborted");
    });
    const response = await chat(req());
    const bodyPromise = response.text();
    await vi.advanceTimersByTimeAsync(90000);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    const body = await bodyPromise;
    expect(body).toContain('"type":"error"'); expect(body).not.toContain('"type":"done"');
    expect(mocks.rpc.mock.calls.some(call => call[0] === "save_question_reply")).toBe(false);
    expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_status: "failed", p_error: "interrupted" });
    expect(progress).toEqual(initialQuestionProgress());
  });
  it("does not show a next question when its transactional save fails", async () => {
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "save_question_reply"
      ? { data: null, error: { message: "WRITE_FAILED" } } : original(name, args));
    const body = await (await chat(req())).text();
    expect(body).not.toContain(settings.question_mode.questions[1].title);
    expect(body).not.toContain('"type":"done"'); expect(progress).toEqual(initialQuestionProgress());
  });
  it("refuses forged control fields, missing progress and unauthorized conversations before generation", async () => {
    expect((await chat(req({ phase: "retest" }))).status).toBe(400);
    expect((await chat(req({ question_version: undefined }))).status).toBe(400);
    records.conversations.data = null;
    expect((await chat(req())).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
