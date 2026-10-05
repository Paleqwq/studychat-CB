import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), membership: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ auth: { getUser: mocks.getUser }, from: mocks.from, rpc: mocks.rpc }) }));
import { DELETE } from "@/app/api/admin/conversations/route";

const conversationId = "00000000-0000-4000-8000-000000000101";
const adminId = "00000000-0000-4000-8000-000000000001";
const input = { conversation_id: conversationId, confirmation: "DELETE" };
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request("https://study.example/api/admin/conversations", { method: "DELETE",
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

describe("administrator conversation deletion HTTP boundary", () => {
  it("uses the verified administrator and deletes exactly one confirmed UUID through an atomic RPC", async () => {
    const response = await DELETE(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, conversation_id: conversationId });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_delete_conversation", { p_conversation: conversationId, p_actor: adminId });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("admin_users");
  });
  it.each([
    {}, { ...input, conversation_id: "not-a-uuid" }, { conversation_id: conversationId },
    { ...input, confirmation: "" }, { ...input, p_actor: "forged-admin" }, { ...input, owner_id: "another-user" },
    { ...input, conversation_id: [conversationId] }
  ])("rejects invalid, bulk or unconfirmed deletion input %#", async body => {
    expect((await DELETE(request(body))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects cross-site requests and absent bearer authentication before accessing the database", async () => {
    expect((await DELETE(request(input, { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await DELETE(request(input, { Authorization: "" }))).status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("refuses anonymous participants and authenticated non-administrators", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "participant", is_anonymous: true } }, error: null });
    expect((await DELETE(request())).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "non-admin", is_anonymous: false } }, error: null });
    mocks.membership.mockResolvedValue({ data: null, error: null });
    expect((await DELETE(request())).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires a small JSON body", async () => {
    expect((await DELETE(request({ ...input, oversized: "x".repeat(3000) }))).status).toBe(413);
    expect((await DELETE(request(input, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["CONVERSATION_BUSY", 409, "仍在生成回复"],
    ["CONVERSATION_NOT_FOUND", 404, "已被其他管理员删除"],
    ["FORBIDDEN", 403, "无权访问"]
  ] as const)("maps %s to a safe deletion error", async (message, status, expected) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    const response = await DELETE(request());
    expect(response.status).toBe(status);
    expect((await response.json()).error).toContain(expected);
  });
  it.each(["PGRST202", "42883"])("explains the required SQL upgrade when the RPC is missing (%s)", async code => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private-internal-detail" } });
    const response = await DELETE(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("003_admin_delete_conversation.sql");
  });
  it("does not claim success on an unconfirmed result or expose unknown database errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect((await DELETE(request())).status).toBe(503);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "private-credential-and-content" } });
    const response = await DELETE(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-credential-and-content");
  });
});
