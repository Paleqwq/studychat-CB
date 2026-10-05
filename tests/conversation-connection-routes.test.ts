import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), current: vi.fn(), from: vi.fn(), rpc: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/http", async original => ({ ...await original<typeof import("@/lib/server/http")>(),
  requireUser: mocks.user, requireAdmin: mocks.admin }));
vi.mock("@/lib/server/settings", () => ({ currentExperiment: mocks.current }));
vi.mock("@/lib/server/provider", () => ({ generateReply: mocks.generate }));
import { POST as chat } from "@/app/api/chat/route";
import { GET as detail } from "@/app/api/admin/conversations/route";
import { defaultSettings } from "@/lib/types";
import { defaultExperiment, groups } from "@/lib/experiment";
import { encryptSecret } from "@/lib/server/crypto";
import { HttpError } from "@/lib/server/http";

const id = "a4d46d08-ab3a-4a66-8d01-dce2fce2734c";
const turnId = "b4d46d08-ab3a-4a66-8d01-dce2fce2734c";
const original = { ...defaultSettings, model: "frozen-model", system_prompt: "frozen-personality-and-task",
  max_tokens: 1024, temperature: 0.3, api_base_url: "https://old.example/v1" };
let rows: Record<string, { data: any; error: any }>;
function publication(revision = 7) {
  const settings = defaultExperiment(); settings.base_prompt = "new-task"; settings.personality_prompt = "new-personality";
  settings.connections.chatgpt = { ...settings.connections.chatgpt, protocol: "openai-responses", api_url_mode: "endpoint",
    api_base_url: "https://new.example/native/responses/", model: "new-model-not-for-old-sessions", max_tokens: 8192, temperature: 1 };
  settings.connections.deepseek = { ...settings.connections.deepseek, api_base_url: "https://deepseek.example/v1", model: "new-deepseek" };
  return { id: "new-experiment", revision, created_at: "2026-10-02T09:00:00Z", settings,
    encrypted_keys: { deepseek: encryptSecret("new-deepseek-key-" + revision), chatgpt: encryptSecret("new-chatgpt-key-" + revision) } };
}
function chatRequest(extra: object = {}, turn_id = turnId) {
  return new Request("https://study.example/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: id, turn_id, content: "test message", ...extra }) });
}
function detailRequest() { return new Request("https://study.example/api/admin/conversations?id=" + id); }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("STUDY_ACCESS_CODE", "");
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  mocks.user.mockResolvedValue({ id: "owner" }); mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.current.mockResolvedValue({ config: publication(), enabled: true });
  mocks.generate.mockImplementation(async function* () { yield "test reply"; });
  mocks.rpc.mockImplementation(async name => ({ error: null, data: name === "begin_turn" ? {
    state: "accepted", lock_token: "lease", user: { id: "message-u", role: "user", content: "test message" },
    assistant: { id: "message-a", role: "assistant", content: "", status: "pending" }
  } : { id: "message-a", role: "assistant", content: "test reply", status: "complete" } }));
  rows = {
    conversations: { data: { id, config_id: "original-config" }, error: null },
    config_versions: { data: { revision: 1, settings: structuredClone(original), api_key_ciphertext: encryptSecret("original-key") }, error: null },
    participant_enrollments: { data: { group_code: "chatgpt_control" }, error: null },
    messages: { data: [{ role: "user", content: "test message" }], error: null },
    admin_conversation_records: { data: { id, config_id: "original-config", model_factor: "chatgpt",
      group_code: "chatgpt_control", experiment_revision: 1, student_id: "TEST001" }, error: null }
  };
  mocks.from.mockImplementation(table => {
    // Emulate column selection so admin responses never receive ciphertext columns.
    let columns = "*";
    const query: any = { then: (resolve: (value: unknown) => unknown) => {
      const result = rows[table];
      const data = result.data && !Array.isArray(result.data) && columns !== "*" ? Object.fromEntries(
        columns.split(",").map(column => [column, result.data[column]])
      ) : result.data;
      return Promise.resolve({ ...result, data }).then(resolve);
    } };
    query.select = (value: string) => { columns = value; return query; };
    for (const method of ["eq", "order", "single", "maybeSingle"]) query[method] = vi.fn(() => query);
    return query;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("old conversations use current transport but frozen experiment settings", () => {
  it.each(groups)("uses the server-assigned $code factor's current key, never the other factor", async group => {
    rows.participant_enrollments.data = { group_code: group.code };
    const frozen = structuredClone(rows.config_versions.data);
    const response = await chat(chatRequest()); const text = await response.text();
    expect(response.status).toBe(200); expect(text).toContain("test reply");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const selected = mocks.generate.mock.calls[0][0];
    expect(selected).toMatchObject({ model: "frozen-model", system_prompt: "frozen-personality-and-task",
      temperature: 0.3, max_tokens: 1024, api_key: "new-" + group.model + "-key-7" });
    expect(selected.api_base_url).toBe(publication().settings.connections[group.model].api_base_url);
    if (group.model === "chatgpt") expect(selected).toMatchObject({ protocol: "openai-responses", api_url_mode: "endpoint" });
    expect(rows.config_versions.data).toEqual(frozen);
    expect(text).not.toMatch(/new-chatgpt-key|new-deepseek-key|original-key|frozen-model|group_code|model_factor|ciphertext/);
    expect(mocks.rpc.mock.calls[0]).toEqual(["begin_turn", {
      p_conversation: id, p_owner: "owner", p_turn: turnId, p_content: "test message"
    }]);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["begin_turn", "save_reply"]);
  });
  it("uses a rotated key on the next request for the same conversation, without re-enrollment", async () => {
    await (await chat(chatRequest())).text();
    mocks.current.mockResolvedValue({ config: publication(8), enabled: true });
    await (await chat(chatRequest({}, "c4d46d08-ab3a-4a66-8d01-dce2fce2734c"))).text();
    expect(mocks.generate.mock.calls.map(call => call[0].api_key)).toEqual(["new-chatgpt-key-7", "new-chatgpt-key-8"]);
    expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls.some(call => /register|publish|delete/.test(call[0]))).toBe(false);
  });
  it("no longer depends on a stale or undecryptable original key for a grouped conversation", async () => {
    rows.config_versions.data.api_key_ciphertext = "obsolete-undecryptable-key";
    const response = await chat(chatRequest());
    expect(response.status).toBe(200); await response.text();
    expect(mocks.generate.mock.calls[0][0].api_key).toBe("new-chatgpt-key-7");
  });
  it("keeps a running stream on its captured publication when an admin publishes another version", async () => {
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    mocks.generate.mockImplementation(async function* () { yield "first"; await pending; yield "second"; });
    const response = await chat(chatRequest()); const reader = response.body!.getReader();
    await reader.read(); // accepted
    await reader.read(); // first delta: provider has started with v7
    mocks.current.mockResolvedValue({ config: publication(8), enabled: true });
    resume();
    while (!(await reader.read()).done) {}
    expect(mocks.generate.mock.calls[0][0].api_key).toBe("new-chatgpt-key-7");
    expect(mocks.current).toHaveBeenCalledTimes(1);
  });
  it("restores a completed idempotent turn without contacting the provider again", async () => {
    mocks.rpc.mockResolvedValue({ error: null, data: { state: "complete", user: { content: "test message" },
      assistant: { status: "complete", content: "already saved" } } });
    const response = await chat(chatRequest()); expect(await response.text()).toContain("already saved");
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("keeps ungrouped historical records on their original transport and key", async () => {
    rows.participant_enrollments.data = null;
    const response = await chat(chatRequest()); await response.text();
    expect(mocks.generate.mock.calls[0][0]).toEqual({ ...original, api_key: "original-key" });
    expect(mocks.current).not.toHaveBeenCalled();
  });
});

describe("current connection failures and authorization stay fail-closed", () => {
  it("rejects an unavailable publication before accepting a durable turn", async () => {
    mocks.current.mockResolvedValue({ config: null, enabled: false });
    const response = await chat(chatRequest()); expect(response.status).toBe(503);
    expect(await response.text()).toContain("重新发布");
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not fall back to the original key or another model when the latest factor key is absent", async () => {
    const broken = publication(); broken.encrypted_keys.chatgpt = "";
    mocks.current.mockResolvedValue({ config: broken, enabled: true });
    expect((await chat(chatRequest())).status).toBe(503);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not fall back or accept a turn when a newly published credential cannot be decrypted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = publication(); broken.encrypted_keys.chatgpt = "private-undecryptable-ciphertext";
    mocks.current.mockResolvedValue({ config: broken, enabled: true });
    const response = await chat(chatRequest()); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-undecryptable");
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not silently treat a failed or unrecognized enrollment lookup as an ungrouped record", async () => {
    rows.participant_enrollments.error = { message: "private lookup failure" };
    expect((await chat(chatRequest())).status).toBe(503);
    rows.participant_enrollments.error = null; rows.participant_enrollments.data = { group_code: "unknown" };
    expect((await chat(chatRequest())).status).toBe(503);
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated or foreign-owner requests before reading current model credentials", async () => {
    mocks.user.mockRejectedValueOnce(new HttpError(401, "请登录"));
    expect((await chat(chatRequest())).status).toBe(401); expect(mocks.from).not.toHaveBeenCalled();
    rows.conversations.data = null;
    expect((await chat(chatRequest())).status).toBe(403);
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("still refuses client-selected protocol, factor, model or credentials", async () => {
    for (const forged of [{ protocol: "anthropic" }, { model_factor: "deepseek" }, { model: "another" }, { api_key: "forged" }]) {
      expect((await chat(chatRequest(forged))).status).toBe(400);
    }
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled();
  });
  it("does not fall back or leak a datastore error when current configuration cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.current.mockRejectedValue(new Error("private-provider-key-in-database-error"));
    const response = await chat(chatRequest()); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-provider-key");
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
});

describe("admin detail/export distinguishes original and current connection", () => {
  it("retains the original snapshot and exports a public current connection, never any credential", async () => {
    const response = await detail(detailRequest()); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.config).toEqual({ revision: 1, settings: original });
    expect(data.conversation).toMatchObject({ group_code: "chatgpt_control", experiment_revision: 1 });
    expect(data.connection).toMatchObject({ source: "latest", experiment_revision: 7,
      endpoint: "https://new.example/native/responses/", settings: { protocol: "openai-responses" } });
    expect(JSON.stringify(data)).not.toMatch(/api_key|ciphertext|encrypted_keys|new-chatgpt-key|new-deepseek-key/);
  });
  it("can read a historical record even when a new connection has not been published", async () => {
    mocks.current.mockResolvedValue({ config: null, enabled: false });
    const response = await detail(detailRequest()); expect(response.status).toBe(200);
    expect((await response.json()).connection.source).toBe("unavailable");
  });
  it("describes the original connection for an ungrouped history without guessing from its model name", async () => {
    rows.admin_conversation_records.data.model_factor = null;
    const response = await detail(detailRequest()); expect(response.status).toBe(200);
    expect((await response.json()).connection).toMatchObject({ source: "original", endpoint: "https://old.example/v1/chat/completions" });
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it("requires administrator authorization before reading or exporting connection metadata", async () => {
    mocks.admin.mockRejectedValue(new HttpError(403, "无权限"));
    expect((await detail(detailRequest())).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled();
  });
});
