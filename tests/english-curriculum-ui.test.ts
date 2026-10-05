import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EnglishCurriculumEditor, EnglishCurriculumResetDialog } from "@/components/english-curriculum-editor";
import { EnglishDeleteDialog } from "@/components/english-delete-dialog";
import { EnglishProgress } from "@/components/english-progress";
import { defaultEnglishCurriculum, englishCourseOutline, englishStages, initialEnglishProgress } from "@/lib/english-assistant";
import type { EnglishResearchConversation } from "@/lib/english-groups";

const conversation: EnglishResearchConversation = {
  id: "english-target", participant_code: "E-TEST", title: "目标英语会话", student_id: "000123",
  group_code: "deepseek_personality", model_factor: "deepseek", personality: true, assigned_at: "2026-10-04T10:00:00Z",
  created_at: "2026-10-04T10:00:00Z", updated_at: "2026-10-04T11:00:00Z", request_count: 7,
  experiment_id: "shared", experiment_revision: 1, prompt_revision: 2, english_progress: initialEnglishProgress()
};

describe("BOPPPS curriculum administration", () => {
  it("prefills all six stages and the existing course, preserving the draft until an explicit edit or confirmed reset", () => {
    const value = defaultEnglishCurriculum();
    const before = JSON.stringify(value);
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(EnglishCurriculumEditor, { value, disabled: false, onChange }));
    expect(html).toContain("当前课程共 12 / 24 个活动");
    let position = -1;
    for (const stage of englishStages) {
      const next = html.indexOf(stage.label, position + 1);
      expect(next).toBeGreaterThan(position); position = next;
    }
    expect(html).toContain(value.bridge.description);
    expect(html).toContain(value.bridge.activities[0].title);
    expect(html).toContain(value.bridge.activities[0].criterion);
    expect(html).toContain("学生任务");
    expect(html).toContain("达标条件");
    expect(html).toContain("确认恢复默认内容");
    expect(html).toContain("覆盖尚未发布的课程内容编辑");
    expect(html).toContain('role="alertdialog"');
    expect(onChange).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
  });

  it("keeps at least one activity per stage and stops adding at either the stage or total limit", () => {
    const value = defaultEnglishCurriculum();
    const single = renderToStaticMarkup(createElement(EnglishCurriculumEditor, { value, disabled: false, onChange: vi.fn() }));
    expect(single).toMatch(/aria-label="删除导入活动 1"[^>]*disabled/);
    value.bridge.activities = Array.from({ length: 8 }, (_, index) => ({ ...value.bridge.activities[0], title: "活动 " + index }));
    const fullStage = renderToStaticMarkup(createElement(EnglishCurriculumEditor, { value, disabled: false, onChange: vi.fn() }));
    expect(fullStage).toMatch(/<button[^>]*disabled[^>]*>[^]*?新增活动/);
    expect(fullStage).not.toMatch(/aria-label="删除导入活动 1"[^>]*disabled/);
    const fullCourse = defaultEnglishCurriculum();
    for (const stage of englishStages) fullCourse[stage.id].activities = Array.from({ length: 4 }, () => ({ ...fullCourse[stage.id].activities[0] }));
    const total = renderToStaticMarkup(createElement(EnglishCurriculumEditor, { value: fullCourse, disabled: false, onChange: vi.fn() }));
    expect(total).toContain("当前课程共 24 / 24 个活动");
    expect(total).toMatch(/<button[^>]*disabled[^>]*>[^]*?新增活动/);
  });

  it("offers paired word limits only for practice and post-assessment, avoiding a hidden gate for diagnosis", () => {
    const value = defaultEnglishCurriculum();
    value.participatory.activities[0].word_limit = { min: 40, max: 60 };
    const practice = renderToStaticMarkup(createElement(EnglishCurriculumEditor, { value, disabled: false, onChange: vi.fn(), initialStage: "participatory" }));
    expect(practice).toContain("要求英文正文词数范围");
    expect(practice).toContain("最少词数");
    expect(practice).toContain("最多词数");
    expect(practice).toContain('value="40"');
    expect(practice).toContain('value="60"');
    const pretest = renderToStaticMarkup(createElement(EnglishCurriculumEditor, { value, disabled: false, onChange: vi.fn(), initialStage: "pre_assessment" }));
    expect(pretest).not.toContain("要求英文正文词数范围");
    expect(pretest).not.toContain("最少词数");
    expect(pretest).toContain("其他阶段不增加词数关卡");
  });

  it("makes reset a separate confirmation with cancel and a stated draft-only effect", () => {
    const html = renderToStaticMarkup(createElement(EnglishCurriculumResetDialog, {
      dialogRef: { current: null }, disabled: false, onConfirm: vi.fn(), onClose: vi.fn()
    }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("替换当前课程草稿");
    expect(html).toContain("恢复后仍须保存并发布");
    expect(html).toContain("取消");
    expect(html).toContain("确认恢复默认内容");
  });

  it("shows a student's frozen public activity count, description and title without private criteria or future task contents", () => {
    const curriculum = defaultEnglishCurriculum();
    curriculum.participatory.description = "学生的自定义阶段说明";
    curriculum.participatory.activities = Array.from({ length: 6 }, (_, index) => ({ title: "自定义活动 " + (index + 1), prompt: "后续任务正文 PRIVATE-TASK-" + index,
      criterion: "教师判定依据 PRIVATE-CRITERION-" + index }));
    const outline = englishCourseOutline(curriculum);
    const html = renderToStaticMarkup(createElement(EnglishProgress, { state: { ...initialEnglishProgress(), stage: "participatory", step: 5 }, course: outline }));
    expect(html).toContain("当前活动 6 / 6");
    expect(html).toContain("自定义活动 6");
    expect(html).toContain("学生的自定义阶段说明");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/PRIVATE-TASK|PRIVATE-CRITERION|自定义活动 1/);
    expect(html).not.toMatch(/<button|<a\b/);
  });
});

describe("permanent deletion of an English conversation", () => {
  const props: ComponentProps<typeof EnglishDeleteDialog> = {
    dialogRef: { current: null }, conversation, messageCount: 15, loading: false, mode: "demo", confirmation: "", deleting: false, error: "",
    onConfirmation: vi.fn(), onConfirm: vi.fn(), onClose: vi.fn(), onRetryDetails: vi.fn()
  };
  function markup(overrides: Partial<typeof props> = {}) {
    return renderToStaticMarkup(createElement(EnglishDeleteDialog, { ...props, ...overrides }));
  }

  it("identifies the student and English group and explains permanent messages, progress, enrollment and count changes", () => {
    const html = markup();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("000123");
    expect(html).toContain("DeepSeek · 有人格");
    expect(html).toContain("15 条英语消息");
    expect(html).toContain("7 次请求");
    expect(html).toContain("学习进度与阶段记录");
    expect(html).toContain("释放本次英语学号登记");
    expect(html).toContain("英语分组人数会减少");
    expect(html).toContain("正在生成回复的英语会话不能删除");
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });

  it("requires the exact target student ID and disables mutation during confirmation loading or deletion", () => {
    expect(markup({ confirmation: "000123" })).not.toMatch(/type="submit"[^>]*disabled/);
    for (const confirmation of ["123", "000123 ", "删除", "other-id"]) expect(markup({ confirmation })).toMatch(/type="submit"[^>]*disabled/);
    expect(markup({ confirmation: "000123", deleting: true })).toMatch(/type="submit"[^>]*disabled/);
    expect(markup({ confirmation: "000123", messageCount: null, loading: true })).toMatch(/type="submit"[^>]*disabled/);
    expect(markup({ confirmation: "000123", deleting: true })).toContain("正在删除…");
  });

  it("keeps failure and confirmation visible for retry and offers a separate retry for missing target details", () => {
    const failed = markup({ confirmation: "000123", error: "该英语会话正在生成回复，请稍后重试" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('value="000123"');
    expect(failed).toContain("正在生成回复，请稍后重试");
    expect(failed).not.toMatch(/type="submit"[^>]*disabled/);
    const missing = markup({ messageCount: null, error: "网络中断" });
    expect(missing).toContain("重试读取消息数量");
    expect(missing).toMatch(/type="submit"[^>]*disabled/);
  });
});
