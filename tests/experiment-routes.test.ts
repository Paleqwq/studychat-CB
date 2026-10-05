import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), current: vi.fn(), rpc: vi.fn(), from: vi.fn(), endpoint: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/server/http", async original => ({ ...await original<typeof import("@/lib/server/http")>(), requireUser: mocks.user, requireAdmin: mocks.admin }));
vi.mock("@/lib/server/settings", async original => ({ ...await original<typeof import("@/lib/server/settings")>(), currentExperiment: mocks.current }));
vi.mock("@/lib/server/provider", () => ({ validateEndpoint: mocks.endpoint }));
import { GET as getSession, POST as register } from "@/app/api/session/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/admin/settings/route";
import { GET as getRecords } from "@/app/api/admin/conversations/route";
import { defaultExperiment, effectiveSettings, groups } from "@/lib/experiment";
import { HttpError } from "@/lib/server/http";
import { decryptSecret } from "@/lib/server/crypto";

const settings = { ...defaultExperiment(), personality_prompt: "test personality" };
settings.connections.deepseek.model = "test-deepseek";
settings.connections.chatgpt.model = "test-chatgpt";
const c = { id: "conversation", participant_code: "P-001", title: "test", created_at: "", updated_at: "", request_count: 0,
  config_id: "private-config", owner_id: "private-owner", lock_token: "private-lease", group_code: "private-group" };
function request(path: string, method = "GET", body?: unknown) {
  return new Request("https://study.example" + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
function editInput() { return { ...structuredClone(settings), api_keys: { deepseek: "secret-d", chatgpt: "secret-c" }, enabled: true, expected_revision: 0 }; }

beforeEach(() => {
  vi.stubEnv("STUDY_ACCESS_CODE", "");
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "participant" });
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.current.mockResolvedValue({ config: null, enabled: false });
  mocks.endpoint.mockImplementation(async (value: string) => value);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.from.mockImplementation((table: string) => {
    const result = { error: null, data: table === "messages" ? [] : table === "config_versions" ? { settings: effectiveSettings(settings, groups[0]) } :
      table === "participant_enrollments" ? { student_id: "00123" } : { enabled: true } };
    const query: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    for (const method of ["select", "eq", "order", "single", "maybeSingle"]) query[method] = () => query;
    return query;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("experimental HTTP boundaries", () => {
  it("GET only restores; new participants must explicitly register a student ID", async () => {
    const response = await getSession(request("/api/session"));
    expect(response.status).toBe(200);
    expect((await response.json()).registration_required).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("restore_conversation", { p_owner: "participant" });
  });
  it("registers using server identity and normalized ID, never client-selected group", async () => {
    mocks.rpc.mockResolvedValue({ data: c, error: null });
    const response = await register(request("/api/session", "POST", { student_id: " 00abc " }));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("register_participant", { p_owner: "participant", p_student_id: "00ABC" });
    const data = await response.json();
    expect(data.student_id).toBe("00123");
    expect(JSON.stringify(data)).not.toMatch(/private-|config_id|group_code|system_prompt|personality_prompt|api_key|model_factor/);
  });
  it("rejects forged factor/owner fields before enrollment", async () => {
    const response = await register(request("/api/session", "POST", { student_id: "00123", group_code: "chatgpt_control", owner_id: "other" }));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not expose another identity's records when a student ID is taken", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "STUDENT_UNAVAILABLE" } });
    const response = await register(request("/api/session", "POST", { student_id: "00123" }));
    expect(response.status).toBe(409);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("blocks unauthenticated session and all admin read/write routes before reading data", async () => {
    mocks.user.mockRejectedValue(new HttpError(401, "请登录"));
    expect((await getSession(request("/api/session"))).status).toBe(401);
    mocks.admin.mockRejectedValue(new HttpError(403, "无权限"));
    expect((await getSettings(request("/api/admin/settings"))).status).toBe(403);
    expect((await getRecords(request("/api/admin/conversations"))).status).toBe(403);
    expect((await putSettings(request("/api/admin/settings", "PUT", editInput()))).status).toBe(403);
    expect(mocks.current).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("encrypts two independent keys and publishes all four groups in one RPC", async () => {
    mocks.rpc.mockImplementation(async (_name, args) => ({ data: { id: "e", revision: 1, created_at: "",
      settings: args.p_settings, encrypted_keys: args.p_keys }, error: null }));
    const response = await putSettings(request("/api/admin/settings", "PUT", editInput()));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = mocks.rpc.mock.calls[0];
    expect(name).toBe("publish_experiment");
    expect(decryptSecret(args.p_keys.deepseek)).toBe("secret-d");
    expect(decryptSecret(args.p_keys.chatgpt)).toBe("secret-c");
    expect(args.p_settings).not.toHaveProperty("api_keys");
    expect(args.p_actor).toBe("admin");
    const data = await response.json();
    expect(data.has_api_keys).toEqual({ deepseek: true, chatgpt: true });
    expect(JSON.stringify(data)).not.toMatch(/secret-d|secret-c|encrypted_keys/);
  });
  it("requires both keys initially and fresh credentials when either origin changes", async () => {
    const initial = editInput(); initial.api_keys.chatgpt = "";
    expect((await putSettings(request("/api/admin/settings", "PUT", initial))).status).toBe(400);
    mocks.current.mockResolvedValue({ config: { settings, encrypted_keys: { deepseek: "old-d", chatgpt: "old-c" }, revision: 1 }, enabled: true });
    const changed = editInput(); changed.expected_revision = 1; changed.api_keys.deepseek = "";
    changed.connections.deepseek.api_base_url = "https://another.example/v1";
    expect((await putSettings(request("/api/admin/settings", "PUT", changed))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("publishes different protocols and URL modes without mixing the two model endpoints", async () => {
    const input = editInput();
    input.connections.deepseek.api_base_url = "https://deepseek-gateway.example/openai/v1";
    input.connections.deepseek.api_url_mode = "base";
    input.connections.chatgpt.protocol = "anthropic";
    input.connections.chatgpt.api_base_url = "https://chatgpt-gateway.example/claude/messages/";
    input.connections.chatgpt.api_url_mode = "endpoint";
    mocks.rpc.mockImplementation(async (_name, args) => ({ data: { id: "e", revision: 1, created_at: "",
      settings: args.p_settings, encrypted_keys: args.p_keys }, error: null }));
    const response = await putSettings(request("/api/admin/settings", "PUT", input));
    expect(response.status).toBe(200);
    expect(mocks.endpoint).toHaveBeenNthCalledWith(1, input.connections.deepseek.api_base_url, "openai-chat", "base");
    expect(mocks.endpoint).toHaveBeenNthCalledWith(2, input.connections.chatgpt.api_base_url, "anthropic", "endpoint");
    expect(mocks.rpc.mock.calls[0][1].p_settings.connections).toEqual(input.connections);
    const output = await response.json();
    expect(output.connections).toEqual(input.connections);
    expect(JSON.stringify(output)).not.toMatch(/secret-d|secret-c|encrypted_keys/);
  });
  it("blocks publishing a known endpoint for the wrong protocol before touching credentials", async () => {
    const input = editInput();
    input.connections.deepseek.api_base_url = "https://gateway.example/v1/messages";
    const response = await putSettings(request("/api/admin/settings", "PUT", input));
    expect(response.status).toBe(400);
    expect(mocks.current).not.toHaveBeenCalled();
    expect(mocks.endpoint).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("surfaces a revision conflict without silently overwriting published settings", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "CONFLICT" } });
    expect((await putSettings(request("/api/admin/settings", "PUT", editInput()))).status).toBe(409);
  });
});
