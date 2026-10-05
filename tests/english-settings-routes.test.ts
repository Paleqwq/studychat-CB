import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExperiment } from "@/lib/experiment";
import { defaultEnglishSettings, defaultEnglishBasePrompt, englishSettingsSchema } from "@/lib/english-settings";
import { HttpError } from "@/lib/server/http";
import { defaultEnglishCurriculum, englishStages } from "@/lib/english-assistant";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), requireAdmin: vi.fn(), currentExperiment: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/settings", () => ({ currentExperiment: mocks.currentExperiment }));
vi.mock("@/lib/server/http", async original => ({
  ...await original<typeof import("@/lib/server/http")>(), requireAdmin: mocks.requireAdmin
}));
import { currentEnglishConfiguration } from "@/lib/server/english-settings";
import { GET, PUT } from "@/app/api/admin/english-assistant-settings/route";

let state: any;
function input() {
  return { disclosure: state.disclosure, base_prompt: "ENGLISH_NEW_BASE", personality_prompt: "ENGLISH_NEW_PERSONA",
    enabled: false, expected_revision: state.revision, curriculum: state.curriculum ?? defaultEnglishCurriculum() };
}
function request(body: unknown) {
  return new Request("http://localhost/api/admin/english-assistant-settings", { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  state = { active_config_id: "legacy-config", enabled: true, revision: 0,
    disclosure: defaultEnglishSettings().disclosure, base_prompt: defaultEnglishBasePrompt, personality_prompt: null };
  mocks.from.mockImplementation((table: string) => {
    if (table !== "english_assistant_state") throw new Error("Unexpected table: " + table);
    const query = { select: () => query, eq: () => query, single: async () => ({ data: state, error: null }) };
    return query;
  });
  const base = defaultExperiment();
  mocks.currentExperiment.mockResolvedValue({ enabled: false, config: {
    id: "shared-experiment", revision: 3, created_at: "2026-10-04T10:00:00Z",
    settings: { ...base, base_prompt: "BLOOM_BASE", personality_prompt: "SHARED_PERSONA",
      disclosure: "BLOOM_DISCLOSURE", question_mode: { enabled: true },
      connections: { deepseek: { ...base.connections.deepseek, model: "existing-deepseek-model", temperature: 0.4, max_tokens: 4096 },
        chatgpt: { ...base.connections.chatgpt, model: "irrelevant-chatgpt" } } },
    encrypted_keys: { deepseek: "private-shared-key", chatgpt: "unrelated-key" }
  } });
  mocks.requireAdmin.mockResolvedValue({ id: "admin-id" });
  mocks.rpc.mockImplementation(async (_name, params) => {
    state = { ...state, revision: state.revision + 1, enabled: params.p_enabled,
      disclosure: params.p_disclosure, base_prompt: params.p_base_prompt, personality_prompt: params.p_personality_prompt,
      curriculum: params.p_curriculum };
    return { data: state, error: null };
  });
});

describe("English teaching configuration with shared DeepSeek", () => {
  it("reads the shared DeepSeek connection while English availability and teaching settings stay independent", async () => {
    const result = await currentEnglishConfiguration();
    expect(result.enabled).toBe(true); // Bloom may be paused.
    expect(result.config?.settings).toMatchObject({ model: "existing-deepseek-model", temperature: 0.4,
      max_tokens: 4096, disclosure: state.disclosure, assistant_name: "英语助教" });
    expect(result.config?.settings.question_mode).toBeUndefined();
    expect(result.config?.settings.system_prompt).not.toContain("BLOOM_BASE");
    expect(result.config?.personality_prompt).toBe("SHARED_PERSONA");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual(["english_assistant_state"]);
  });
  it("has no ChatGPT requirement and never falls back to another model", async () => {
    const source = await mocks.currentExperiment();
    delete source.config.settings.connections.chatgpt;
    delete source.config.encrypted_keys.chatgpt;
    mocks.currentExperiment.mockResolvedValue(source);
    expect((await currentEnglishConfiguration()).config?.settings.model).toBe("existing-deepseek-model");
    delete source.config.encrypted_keys.deepseek;
    expect((await currentEnglishConfiguration()).config).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns model status and editable English prompts only to administrators, without credentials or Bloom prompts", async () => {
    const response = await GET(new Request("http://localhost/api/admin/english-assistant-settings"));
    expect(response.status).toBe(200); const data = await response.json();
    expect(data).toMatchObject({ revision: 0, base_prompt: defaultEnglishBasePrompt, personality_prompt: "SHARED_PERSONA",
      shared_experiment_revision: 3, has_api_key: true });
    expect(JSON.stringify(data)).not.toMatch(/private-shared-key|unrelated-key|irrelevant-chatgpt|BLOOM_BASE|BLOOM_DISCLOSURE|question_mode/);
  });
  it("publishes only English teaching prompts and availability without changing original model settings", async () => {
    const response = await PUT(request(input()));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("publish_english_course", {
      p_actor: "admin-id", p_expected_revision: 0, p_enabled: false, p_disclosure: state.disclosure,
      p_base_prompt: "ENGLISH_NEW_BASE", p_personality_prompt: "ENGLISH_NEW_PERSONA", p_curriculum: defaultEnglishCurriculum()
    });
    const data = await response.json();
    expect(data).toMatchObject({ revision: 1, enabled: false, base_prompt: "ENGLISH_NEW_BASE", personality_prompt: "ENGLISH_NEW_PERSONA" });
    expect(data.settings.model).toBe("existing-deepseek-model");
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toMatch(/cipher|connections|publish_experiment/);
  });
  it("rejects model changes, forced group selection and attempts to alter program flow", async () => {
    for (const extras of [{ model: "other" }, { api_key: "key" }, { connections: {} }, { group_code: "deepseek_personality" },
      { question_mode: { enabled: true } }, { system_prompt: "bypass" }]) {
      expect(englishSettingsSchema.safeParse({ ...input(), ...extras }).success).toBe(false);
      expect((await PUT(request({ ...input(), ...extras }))).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("validates nonempty bounded prompts and preserves administrator authorization", async () => {
    for (const extras of [{ base_prompt: " " }, { personality_prompt: "" }, { base_prompt: "x".repeat(10001) },
      { disclosure: "x".repeat(2001) }, { expected_revision: -1 }]) {
      expect((await PUT(request({ ...input(), ...extras }))).status).toBe(400);
    }
    mocks.requireAdmin.mockRejectedValueOnce(new HttpError(403, "仅管理员可访问。"));
    expect((await GET(new Request("http://localhost/api/admin/english-assistant-settings"))).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("surfaces publication conflicts and missing English migrations", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "CONFLICT" } });
    expect((await PUT(request(input()))).status).toBe(409);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "private database detail" } });
    const missing = await PUT(request(input()));
    expect(missing.status).toBe(503);
    expect(await missing.text()).toContain("007_english_curriculum_and_delete.sql");
  });
  it("publishes custom course content atomically with prompts and never resets it when a request omits curriculum", async () => {
    const curriculum = defaultEnglishCurriculum();
    curriculum.bridge = { description: "自定义说明", activities: [{ title: "新导入", prompt: "谈论写作经历", criterion: "参加交流" }] };
    const response = await PUT(request({ ...input(), curriculum }));
    expect(response.status).toBe(200);
    expect((await response.json()).curriculum).toEqual(curriculum);
    expect(mocks.rpc.mock.calls.at(-1)?.[1].p_curriculum).toEqual(curriculum);
    const { curriculum: _course, ...missingCourse } = input();
    expect((await PUT(request(missingCourse))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/admin/english-assistant-settings"))).status).toBe(200);
    expect(state.curriculum).toEqual(curriculum);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("accepts the maximum configured Chinese course size and rejects invalid activity content before publishing", async () => {
    const curriculum = defaultEnglishCurriculum();
    for (const stage of englishStages) curriculum[stage.id] = { description: "课".repeat(300),
      activities: Array.from({ length: 4 }, () => ({ title: "题".repeat(120), prompt: "文".repeat(4000), criterion: "达".repeat(2000) })) };
    const body = { ...input(), curriculum, base_prompt: "教".repeat(10000), personality_prompt: "助".repeat(10000), disclosure: "说".repeat(2000) };
    expect((await PUT(request(body))).status).toBe(200);
    curriculum.bridge.activities[0].prompt = " ";
    expect((await PUT(request({ ...input(), curriculum }))).status).toBe(400);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
