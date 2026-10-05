import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEnglishSettings } from "@/lib/english-settings";
import { defaultEnglishCurriculum, initialEnglishProgress } from "@/lib/english-assistant";
import { HttpError } from "@/lib/server/http";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), requireAdmin: vi.fn(), connection: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/http", async original => ({
  ...await original<typeof import("@/lib/server/http")>(), requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/server/conversation-connection", () => ({ currentConversationConnection: mocks.connection }));
import { GET } from "@/app/api/admin/english-assistant-conversations/route";

const id = "11111111-1111-4111-8111-111111111111";
const controlId = "22222222-2222-4222-8222-222222222222";
const legacyId = "33333333-3333-4333-8333-333333333333";
const bloomId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555";
const view = "admin_english_conversation_records";
const progress = { ...initialEnglishProgress(), stage: "participatory" as const, version: 5 };
const settings = { ...defaultEnglishSettings(), model: "frozen-deepseek-model", system_prompt: "FROZEN_ENGLISH_BASE",
  api_base_url: "https://old-deepseek.example/v1", max_tokens: 1800, temperature: 0.3 };
type Row = Record<string, unknown>;
type DbFailure = { message: string; code?: string };
let tables: Record<string, Row[]>;
let failures: Record<string, DbFailure>;
let countRows: Row[];
const queryCalls: { table: string; method: string; args: unknown[] }[] = [];

function request(query = "") {
  return new Request("https://study.example/api/admin/english-assistant-conversations" + (query ? "?" + query : ""));
}
function conversation(conversationId = id, extras: Row = {}): Row {
  return {
    id: conversationId, config_id: snapshotId, student_id: "000123", participant_code: "EA-123",
    title: "英语助教 · PEEC", created_at: "2026-10-04T08:00:00Z", updated_at: "2026-10-04T09:00:00Z",
    request_count: 4, group_code: "deepseek_personality", model_factor: "deepseek", personality: true,
    assigned_at: "2026-10-04T08:00:00Z", experiment_id: "shared-source", experiment_revision: 7,
    prompt_revision: 2, english_progress: progress, ...extras,
  };
}

beforeEach(() => {
  vi.clearAllMocks(); queryCalls.length = 0; failures = {};
  mocks.requireAdmin.mockResolvedValue({ id: "admin-id" });
  tables = {
    [view]: [conversation(), conversation(controlId, { student_id: "ENG_CONTROL", group_code: "deepseek_control", personality: false }),
      conversation(legacyId, { student_id: "OLD_001", group_code: null, model_factor: null, personality: null,
        assigned_at: null, experiment_id: null, experiment_revision: null, prompt_revision: null })],
    english_assistant_messages: [{ id: "english-msg", session_id: id, role: "user", content: "我可以解释两个 E 的区别。",
      status: "complete", turn_id: "english-turn", created_at: "2026-10-04T09:00:00Z", error_code: null, sequence: 2,
      owner_id: "private-owner", lock_token: "private-message-lease" }],
    english_assistant_configs: [{ id: snapshotId, settings, base_prompt: "FROZEN_ENGLISH_BASE",
      personality_prompt: "FROZEN_ENGLISH_PERSONALITY", prompt_revision: 2, source_revision: 7,
      created_at: "2026-10-04T08:00:00Z", api_key_ciphertext: "PRIVATE_SNAPSHOT_CIPHER", source_experiment_id: "shared-source",
      actor: "private-publisher" }],
    english_assistant_turns: [{ session_id: id, turn_id: "english-turn", before_state: initialEnglishProgress(), after_state: progress,
      assessment: { achieved: true, evidence: "解释两个 E", feedback: "当前活动已完成。" }, created_at: "2026-10-04T09:00:00Z",
      owner_id: "private-owner", lock_token: "PRIVATE_TURN_LEASE" }],
    // Foreign-course fixtures must never be queried by the English administrator endpoint.
    conversations: [{ id: bloomId, config_id: "bloom-config", owner_id: "private-bloom-owner" }],
    messages: [{ conversation_id: bloomId, content: "PRIVATE_BLOOM_MESSAGE" }],
    config_versions: [{ id: "bloom-config", settings: { system_prompt: "PRIVATE_BLOOM_PROMPT" }, api_key_ciphertext: "PRIVATE_BLOOM_CIPHER" }],
    question_turns: [{ conversation_id: bloomId, assessment: { feedback: "PRIVATE_BLOOM_ASSESSMENT" } }],
  };
  countRows = [{ group_code: "deepseek_personality", enrolled: "2" }, { group_code: "deepseek_control", enrolled: 3 },
    { group_code: "chatgpt_personality", enrolled: 900 }, { group_code: "chatgpt_control", enrolled: 800 },
    { group_code: null, enrolled: 4 }, { group_code: "unknown", enrolled: 600 }];
  mocks.rpc.mockImplementation(async name => {
    if (name !== "english_group_counts") throw new Error("Unexpected non-English RPC: " + name);
    return { data: countRows, error: failures.english_group_counts ?? null };
  });
  mocks.connection.mockResolvedValue({
    settings: { ...settings, api_base_url: "https://current-deepseek.example/v1", model: "SHOULD_NOT_EXPORT_CURRENT_MODEL" },
    api_key_ciphertext: "PRIVATE_CURRENT_CIPHER", encrypted_keys: { chatgpt: "PRIVATE_UNRELATED_CHATGPT_CIPHER" },
    info: { source: "latest", experiment_revision: 8, published_at: "2026-10-04T09:30:00Z",
      endpoint: "https://current-deepseek.example/v1/chat/completions",
      settings: { protocol: "openai-chat", api_base_url: "https://current-deepseek.example/v1", api_url_mode: "base",
        anthropic_auth: "x-api-key", anthropic_workspace: "", token_parameter: "max_tokens" } },
  });
  mocks.from.mockImplementation((table: string) => {
    if (!tables[table]) throw new Error("Unexpected table: " + table);
    let columns = "*";
    let countRequested = false;
    let singular = false;
    let range: [number, number] | undefined;
    const filters: [string, unknown][] = [];
    const orders: { field: string; ascending: boolean }[] = [];
    const query: any = { then: (resolve: (value: unknown) => unknown) => {
      let selected = tables[table].filter(row => filters.every(([field, value]) => row[field] === value));
      const count = selected.length;
      selected = selected.sort((first, second) => {
        for (const { field, ascending } of orders) {
          const difference = String(first[field]).localeCompare(String(second[field]));
          if (difference) return ascending ? difference : -difference;
        }
        return 0;
      });
      if (range) selected = selected.slice(range[0], range[1] + 1);
      if (columns !== "*") selected = selected.map(row => Object.fromEntries(columns.split(",").map(column => [column, row[column]])));
      return Promise.resolve({ data: singular ? selected[0] ?? null : selected, error: failures[table] ?? null,
        count: countRequested ? count : null }).then(resolve);
    } };
    query.select = (value: string, options?: { count?: string }) => {
      queryCalls.push({ table, method: "select", args: options ? [value, options] : [value] });
      columns = value; countRequested = options?.count === "exact"; return query;
    };
    for (const method of ["eq", "is"]) query[method] = (field: string, value: unknown) => {
      queryCalls.push({ table, method, args: [field, value] }); filters.push([field, value]); return query;
    };
    query.order = (field: string, options?: { ascending?: boolean }) => {
      queryCalls.push({ table, method: "order", args: options ? [field, options] : [field] });
      orders.push({ field, ascending: options?.ascending !== false }); return query;
    };
    query.range = (start: number, end: number) => {
      queryCalls.push({ table, method: "range", args: [start, end] }); range = [start, end]; return query;
    };
    for (const method of ["single", "maybeSingle"]) query[method] = () => {
      queryCalls.push({ table, method, args: [] }); singular = true; return query;
    };
    return query;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("English administrator conversation list", () => {
  it.each([401, 403])("requires administrator authorization before any data access: %s", async status => {
    mocks.requireAdmin.mockRejectedValueOnce(new HttpError(status, "无管理员权限。"));
    const req = request(); const response = await GET(req);
    expect(response.status).toBe(status);
    expect(mocks.requireAdmin).toHaveBeenCalledWith(req);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
  });

  it("reads only the English safe view and independent counts with exactly two accepted group keys", async () => {
    const response = await GET(request()); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ total: 3, offset: 0, counts: { deepseek_personality: 2, deepseek_control: 3 } });
    expect(data.conversations).toHaveLength(3);
    expect(Object.keys(data.counts).sort()).toEqual(["deepseek_control", "deepseek_personality"]);
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual([view]);
    expect(mocks.rpc.mock.calls).toEqual([["english_group_counts"]]);
    expect(queryCalls).toContainEqual({ table: view, method: "select", args: ["*", { count: "exact" }] });
    expect(queryCalls).toContainEqual({ table: view, method: "range", args: [0, 49] });
    expect(JSON.stringify(data)).not.toMatch(/owner_id|ciphertext|lock_token|PRIVATE_BLOOM|question_progress/);
    expect(mocks.connection).not.toHaveBeenCalled();
  });

  it.each([
    ["deepseek_personality", "000123", "eq", "deepseek_personality"],
    ["deepseek_control", "eng_control", "eq", "deepseek_control"],
    ["legacy", "old_001", "is", null],
  ])("filters normalized full student IDs and the independent %s group", async (group, student, method, value) => {
    const response = await GET(request(new URLSearchParams({ group: group!, student_id: student! }).toString()));
    expect(response.status).toBe(200); const data = await response.json();
    expect(data.total).toBe(1); expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].student_id).toBe(student!.toUpperCase());
    expect(data.counts).toEqual({ deepseek_personality: 2, deepseek_control: 3 });
    expect(queryCalls).toContainEqual({ table: view, method: "eq", args: ["student_id", student!.toUpperCase()] });
    expect(queryCalls).toContainEqual({ table: view, method, args: ["group_code", value] });
  });

  it("paginates in fixed 50-row pages while preserving the filtered total and stable order", async () => {
    tables[view] = Array.from({ length: 61 }, (_, index) => conversation(crypto.randomUUID(), {
      student_id: "ENG" + index, created_at: new Date(Date.UTC(2026, 9, 4, 8, index)).toISOString(),
    }));
    const response = await GET(request("offset=50")); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.total).toBe(61); expect(data.offset).toBe(50); expect(data.conversations).toHaveLength(11);
    expect(data.conversations.map((row: Row) => row.student_id)).toEqual(Array.from({ length: 11 }, (_, index) => "ENG" + (10 - index)));
    expect(queryCalls).toContainEqual({ table: view, method: "range", args: [50, 99] });
    expect(queryCalls).toContainEqual({ table: view, method: "order", args: ["created_at", { ascending: false }] });
    expect(queryCalls).toContainEqual({ table: view, method: "order", args: ["id"] });
  });

  it.each(["chatgpt_personality", "chatgpt_control", "unknown"])("rejects unavailable group %s", async group => {
    expect((await GET(request("group=" + group))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
    expect(queryCalls.some(call => call.method === "range")).toBe(false);
  });

  it.each(["-1", "1.5", "1000001", "abc", "Infinity"])("rejects invalid offsets before querying: %s", async offset => {
    expect((await GET(request("offset=" + offset))).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid student IDs before executing a query", async () => {
    expect((await GET(request("student_id=" + encodeURIComponent("abc/123")))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(queryCalls.some(call => call.method === "range")).toBe(false);
  });

  it("returns an empty page and zero defaults for absent groups", async () => {
    tables[view] = []; countRows = [];
    const response = await GET(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [], total: 0, offset: 0,
      counts: { deepseek_personality: 0, deepseek_control: 0 } });
  });
});

describe("English administrator detail and export", () => {
  it("returns the registered curriculum snapshot to administrators and preserves legacy null", async () => {
    const course = defaultEnglishCurriculum();
    course.bridge.activities[0].criterion = "PRIVATE_REGISTERED_CRITERION";
    tables.english_assistant_configs[0].curriculum = course;
    const response = await GET(request("id=" + id)); expect(response.status).toBe(200);
    expect((await response.json()).config.curriculum).toEqual(course);
    const selection = queryCalls.find(call => call.table === "english_assistant_configs" && call.method === "select")!;
    expect(String(selection.args[0]).split(",")).toContain("curriculum");
    tables.english_assistant_configs[0].curriculum = null;
    const legacy = await GET(request("id=" + legacyId)); expect(legacy.status).toBe(200);
    expect((await legacy.json()).config.curriculum).toBeNull();
  });

  it("reads messages, frozen configuration and progress audits exclusively from English tables", async () => {
    const response = await GET(request("id=" + id)); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.conversation.id).toBe(id); expect(data.english_progress).toEqual(progress);
    expect(data.messages).toEqual([{ id: "english-msg", role: "user", content: "我可以解释两个 E 的区别。", status: "complete",
      turn_id: "english-turn", created_at: "2026-10-04T09:00:00Z", error_code: null }]);
    expect(data.config).toEqual({ id: snapshotId, settings, base_prompt: "FROZEN_ENGLISH_BASE", personality_prompt: "FROZEN_ENGLISH_PERSONALITY",
      prompt_revision: 2, source_revision: 7, created_at: "2026-10-04T08:00:00Z" });
    expect(data.english_turns).toHaveLength(1); expect(data.english_turns[0]).toMatchObject({ turn_id: "english-turn", after_state: progress });
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual([view, "english_assistant_messages", "english_assistant_configs", "english_assistant_turns"]);
    expect(queryCalls).toContainEqual({ table: "english_assistant_messages", method: "eq", args: ["session_id", id] });
    expect(queryCalls).toContainEqual({ table: "english_assistant_configs", method: "eq", args: ["id", snapshotId] });
    expect(queryCalls).toContainEqual({ table: "english_assistant_turns", method: "eq", args: ["session_id", id] });
    expect(JSON.stringify(data)).not.toMatch(/api_key|ciphertext|encrypted_keys|owner_id|lock_token|lease|private-publisher|PRIVATE_BLOOM|PRIVATE_/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requests only the assigned DeepSeek connection and exports its description rather than credentials", async () => {
    const response = await GET(request("id=" + id)); expect(response.status).toBe(200);
    const data = await response.json();
    expect(mocks.connection).toHaveBeenCalledExactlyOnceWith(settings, "deepseek");
    expect(data.connection).toEqual((await mocks.connection.mock.results[0].value).info);
    expect(data.config.settings.model).toBe("frozen-deepseek-model");
    expect(JSON.stringify(data)).not.toMatch(/SHOULD_NOT_EXPORT_CURRENT_MODEL|PRIVATE_CURRENT_CIPHER|PRIVATE_UNRELATED_CHATGPT_CIPHER/);
  });

  it("passes null for legacy connection lookup without guessing a group from its model", async () => {
    mocks.connection.mockResolvedValue({ settings, api_key_ciphertext: "PRIVATE_ORIGINAL_CIPHER",
      info: { source: "original", experiment_revision: null, published_at: null, settings: null, endpoint: null } });
    const response = await GET(request("id=" + legacyId)); expect(response.status).toBe(200);
    expect(mocks.connection).toHaveBeenCalledExactlyOnceWith(settings, null);
    expect((await response.json()).connection.source).toBe("original");
  });

  it("returns 404 for Bloom-only IDs without reading any English or Bloom snapshot content", async () => {
    const response = await GET(request("id=" + bloomId)); expect(response.status).toBe(404);
    expect(await response.text()).toContain("未找到此英语学习会话");
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual([view]);
    expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["bad-id", "11111111-1111-1111-1111-111111111111"])("rejects malformed detail identifiers before table reads: %s", async badId => {
    expect((await GET(request("id=" + badId))).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
  });

  it("requires administrator authorization for detail exports", async () => {
    mocks.requireAdmin.mockRejectedValue(new HttpError(403, "无权限"));
    expect((await GET(request("id=" + id))).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
  });

  it("fails clearly when a private snapshot has been lost without exporting credentials", async () => {
    tables.english_assistant_configs = [];
    const response = await GET(request("id=" + id)); expect(response.status).toBe(503);
    expect(await response.text()).toContain("配置快照无法读取");
    expect(mocks.connection).not.toHaveBeenCalled();
  });

  it.each([view, "english_assistant_messages", "english_assistant_configs", "english_assistant_turns"])
    ("reports missing English migrations from %s without leaking datastore details", async table => {
      failures[table] = { code: "42P01", message: "PRIVATE_DATABASE_ERROR" };
      const response = await GET(request("id=" + id)); expect(response.status).toBe(503);
      const body = await response.text(); expect(body).toContain("007_english_curriculum_and_delete.sql"); expect(body).not.toContain("PRIVATE_DATABASE_ERROR");
      expect(mocks.connection).not.toHaveBeenCalled();
    });

  it("fails a counts lookup without returning a partial or borrowed Bloom count", async () => {
    failures.english_group_counts = { code: "PGRST202", message: "PRIVATE_RPC_ERROR" };
    const response = await GET(request()); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_RPC_ERROR");
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["english_group_counts"]);
  });
});
