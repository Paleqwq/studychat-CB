import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), membership: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ auth: { getUser: mocks.getUser }, from: mocks.from, rpc: mocks.rpc }) }));
import { DELETE } from "@/app/api/admin/english-assistant-conversations/route";

const conversationId = "00000000-0000-4000-8000-000000000101";
const adminId = "00000000-0000-4000-8000-000000000001";
const input = { conversation_id: conversationId, confirmation: "DELETE" };
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request("https://study.example/api/admin/english-assistant-conversations", { method: "DELETE",
    headers: { Authorization: "Bearer test-only-token", "Content-Type": "application/json", Origin: "https://study.example", ...headers },
    body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-public");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-server");
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "test-encryption");
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: adminId, is_anonymous: false } }, error: null });
  mocks.membership.mockResolvedValue({ data: { user_id: adminId }, error: null });
  mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: mocks.membership }) }) });
  mocks.rpc.mockResolvedValue({ data: conversationId, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("administrator English deletion HTTP boundary", () => {
  it("deletes exactly one English UUID using the verified administrator and an atomic English RPC", async () => {
    const response = await DELETE(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, conversation_id: conversationId });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_delete_english_conversation", {
      p_conversation: conversationId, p_actor: adminId,
    });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("admin_users");
    expect(mocks.rpc.mock.calls.some(call => /^(?:admin_delete_conversation|publish|register)/.test(call[0]))).toBe(false);
  });

  it.each([
    {}, { ...input, conversation_id: "bad-id" }, { conversation_id: conversationId },
    { ...input, confirmation: "" }, { ...input, confirmation: "删除" }, { ...input, p_actor: "forged-admin" },
    { ...input, owner_id: "different-owner" }, { ...input, group_code: "deepseek_control" },
    { ...input, conversation_id: [conversationId] },
  ])("rejects invalid, unconfirmed, bulk or forged deletion bodies %#", async body => {
    expect((await DELETE(request(body))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests and missing authentication before database access", async () => {
    expect((await DELETE(request(input, { Origin: "https://other.example" }))).status).toBe(403);
    expect((await DELETE(request(input, { Authorization: "" }))).status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects anonymous students and authenticated non-administrators", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "student", is_anonymous: true } }, error: null });
    expect((await DELETE(request())).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "non-admin", is_anonymous: false } }, error: null });
    mocks.membership.mockResolvedValue({ data: null, error: null });
    expect((await DELETE(request())).status).toBe(403); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires a valid small JSON body", async () => {
    expect((await DELETE(request({ ...input, oversized: "x".repeat(3000) }))).status).toBe(413);
    expect((await DELETE(request(input, { "Content-Type": "text/plain" }))).status).toBe(415);
    const malformed = new Request("https://study.example/api/admin/english-assistant-conversations", { method: "DELETE",
      headers: { Authorization: "Bearer test-only-token", "Content-Type": "application/json" }, body: "{" });
    expect((await DELETE(malformed)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["CONVERSATION_NOT_FOUND", 404, "未找到此会话"],
    ["CONVERSATION_BUSY", 409, "仍在生成回复"],
    ["FORBIDDEN", 403, "无权访问"],
  ] as const)("maps %s safely, including a Bloom-only ID rejected by the English RPC", async (message, status, expected) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    const response = await DELETE(request()); expect(response.status).toBe(status);
    expect((await response.json()).error).toContain(expected);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_delete_english_conversation", { p_conversation: conversationId, p_actor: adminId });
  });

  it.each(["PGRST202", "42883", "42703", "PGRST204", "42P01"])("names migration 007 when deletion is unavailable: %s", async code => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_DATABASE_DETAIL" } });
    const response = await DELETE(request()); expect(response.status).toBe(503);
    const text = await response.text(); expect(text).toContain("007_english_curriculum_and_delete.sql"); expect(text).not.toContain("PRIVATE_DATABASE_DETAIL");
  });

  it.each([null, "00000000-0000-4000-8000-000000000102", true])("does not confirm an unexpected deletion result: %s", async result => {
    mocks.rpc.mockResolvedValue({ data: result, error: null });
    const response = await DELETE(request()); expect(response.status).toBe(503);
    expect(await response.text()).toContain("无法确认英语会话删除结果");
  });

  it("hides unknown datastore details rather than claiming success", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE_KEY_AND_STUDENT_CONTENT" } });
    const response = await DELETE(request()); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_KEY_AND_STUDENT_CONTENT");
  });
});
