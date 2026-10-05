import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationDeleteDialog } from "@/components/conversation-delete-dialog";

const props: ComponentProps<typeof ConversationDeleteDialog> = {
  dialogRef: { current: null }, mode: "live", confirmation: "", deleting: false, error: "",
  conversation: { id: "conversation", student_id: "00123", participant_code: "P-TEST", title: "test conversation", created_at: "", updated_at: "",
    request_count: 0, group_code: "deepseek_control", model_factor: "deepseek", personality: false, experiment_id: "experiment", experiment_revision: 1, assigned_at: "" },
  onConfirmation: vi.fn(), onConfirm: vi.fn(), onClose: vi.fn()
};
function markup(overrides: Partial<typeof props> = {}) {
  return renderToStaticMarkup(createElement(ConversationDeleteDialog, { ...props, ...overrides }));
}
describe("permanent deletion confirmation interface", () => {
  it("identifies the target and explicitly warns about permanent content and enrollment deletion", () => {
    const html = markup();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("00123"); expect(html).toContain("P-TEST");
    expect(html).toContain("全部消息、请求记录和学号登记");
    expect(html).toContain("分组人数会减少");
    expect(html).toContain("不会删除登录账号");
    expect(html).toContain("正在生成回复的会话不能删除");
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });
  it("enables deletion only after an exact typed confirmation, and disables it during the request", () => {
    expect(markup({ confirmation: "删除" })).not.toMatch(/type="submit"[^>]*disabled/);
    expect(markup({ confirmation: "删" })).toMatch(/type="submit"[^>]*disabled/);
    expect(markup({ confirmation: "删除", deleting: true })).toMatch(/type="submit"[^>]*disabled/);
    expect(markup({ confirmation: "删除", deleting: true })).toContain("正在删除…");
  });
  it("keeps errors inside the dialog and explains the simulation boundary", () => {
    expect(markup({ error: "生成中，请稍后重试" })).toContain('role="alert"');
    expect(markup({ error: "生成中，请稍后重试" })).toContain("生成中，请稍后重试");
    expect(markup({ mode: "demo" })).toContain("不操作正式数据库");
  });
  it("escapes stored participant content rather than treating it as HTML", () => {
    const html = markup({ conversation: { ...props.conversation!, title: "<script>bad()</script>" } });
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  });
});
