import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExperiment } from "@/lib/experiment";
import { defaultQuestionMode } from "@/lib/question-mode";
import { HttpError } from "@/lib/server/http";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), current: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/server/http", async original => ({ ...await original<typeof import("@/lib/server/http")>(), requireAdmin: mocks.admin }));
vi.mock("@/lib/server/settings", async original => ({ ...await original<typeof import("@/lib/server/settings")>(), currentExperiment: mocks.current }));
vi.mock("@/lib/server/provider", () => ({ validateEndpoint: async (value: string) => value }));
import { GET, PUT as publishSettings } from "@/app/api/admin/settings/route";
import { PUT } from "@/app/api/admin/content-draft/route";

const { connections: _connections, ...content } = { ...defaultExperiment(), personality_prompt: "迁入人格",
  base_prompt: "源站教学提示词", question_mode: { ...defaultQuestionMode(), enabled: true } };
let row: any;
function request(body?: unknown) {
  return new Request("https://study.example/api/admin/content-draft", { method: body ? "PUT" : "GET",
    headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
function input() { return { content, enabled: true, expected_draft_revision: 3 }; }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  row = { content_draft: content, draft_revision: 3, draft_enabled: true };
  mocks.admin.mockResolvedValue({ id: "real-admin" });
  mocks.current.mockResolvedValue({ config: null, enabled: false });
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.from.mockImplementation(() => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data: row, error: null }) };
    return q;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("administrative content drafts without model credentials", () => {
  it("shows draft content while publishing and draft revisions remain separate and model fields keep defaults", async () => {
    const result = await (await GET(request())).json();
    expect(result).toMatchObject({ ...content, id: "", revision: 0, draft_revision: 3, has_content_draft: true, enabled: true });
    expect(result.connections).toEqual(defaultExperiment().connections);
    expect(result.has_api_keys).toEqual({ deepseek: false, chatgpt: false });
  });
  it("ignores stale drafts when a model configuration has already been published", async () => {
    const published = { id: "e", revision: 7, settings: { ...defaultExperiment(), base_prompt: "已发布正式内容" },
      encrypted_keys: { deepseek: "cipher-d", chatgpt: "cipher-c" }, created_at: "" };
    mocks.current.mockResolvedValue({ config: published, enabled: false });
    const result = await (await GET(request())).json();
    expect(result.base_prompt).toBe("已发布正式内容");
    expect(result.revision).toBe(7);
    expect(result.draft_revision).toBeUndefined();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/cipher-d|cipher-c|encrypted_keys/);
  });
  it("keeps legacy installations' original publishing flow available before the new migration", async () => {
    mocks.from.mockImplementation(() => {
      const q = { select: () => q, eq: () => q, single: async () => ({ data: null, error: { code: "42703", message: "missing draft column" } }) };
      return q;
    });
    const result = await (await GET(request())).json();
    expect(result.revision).toBe(0);
    expect(result.draft_revision).toBeUndefined();
    expect(result.has_content_draft).toBeUndefined();
  });
  it("saves only whitelisted teaching content with authenticated administrator and a draft compare-and-swap", async () => {
    expect((await PUT(request(input()))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("save_content_draft", {
      p_content: content, p_actor: "real-admin", p_expected_draft_revision: 3, p_enabled: true
    });
  });
  it.each([{ connections: {} }, { api_keys: {} }, { model: "fake" }, { revision: 0 }])(
    "rejects injected model or revision fields %j", async forbidden => {
      expect((await PUT(request({ ...input(), content: { ...content, ...forbidden } }))).status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
  it("rejects the published expected_revision in place of expected_draft_revision", async () => {
    expect((await PUT(request({ content, enabled: true, expected_revision: 3 }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires administrator access before reading or changing content", async () => {
    mocks.admin.mockRejectedValue(new HttpError(403, "无权访问"));
    expect((await GET(request())).status).toBe(403);
    expect((await PUT(request(input()))).status).toBe(403);
    expect(mocks.current).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["CONFLICT", "CONTENT_DRAFT_UNAVAILABLE"])("reports %s without pretending the content was saved", async message => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    expect((await PUT(request(input()))).status).toBe(409);
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it("checks the separate draft revision when first publishing real models without persisting draft metadata", async () => {
    const settings = { ...defaultExperiment(), ...content };
    settings.connections.deepseek.model = "real-deepseek";
    settings.connections.chatgpt.model = "real-chatgpt";
    mocks.rpc.mockImplementation(async (name, args) => name === "question_mode_available"
      ? { data: true, error: null }
      : { data: { id: "e", revision: 1, settings: args.p_settings, encrypted_keys: args.p_keys, created_at: "" }, error: null });
    const result = await publishSettings(request({ ...settings, enabled: true, expected_revision: 0,
      expected_draft_revision: 3, api_keys: { deepseek: "secret-d", chatgpt: "secret-c" } }));
    expect(result.status).toBe(200);
    const [name, args] = mocks.rpc.mock.calls.at(-1)!;
    expect(name).toBe("publish_experiment_with_content_draft");
    expect(args.p_expected_revision).toBe(0);
    expect(args.p_expected_draft_revision).toBe(3);
    expect(args.p_settings).not.toHaveProperty("expected_draft_revision");
    expect(args.p_settings).not.toHaveProperty("expected_revision");
    expect(args.p_settings.connections).toEqual(settings.connections);
    const body = await result.json();
    expect(body.draft_revision).toBeUndefined();
    expect(body.has_content_draft).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/secret-d|secret-c|encrypted_keys/);
  });
  it("rejects first publication from an old screen that omits the saved draft revision", async () => {
    const settings = { ...defaultExperiment(), ...content, question_mode: undefined };
    settings.connections.deepseek.model = "real-deepseek";
    settings.connections.chatgpt.model = "real-chatgpt";
    const result = await publishSettings(request({ ...settings, enabled: true, expected_revision: 0,
      api_keys: { deepseek: "secret-d", chatgpt: "secret-c" } }));
    expect(result.status).toBe(409);
    expect((await result.json()).error).toContain("重新加载");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
