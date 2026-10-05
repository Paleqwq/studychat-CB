import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EnglishAdminNavigation } from "@/components/english-admin-panel";
import { EnglishPromptSettings, EnglishRecordDetail, EnglishRecordsView, EnglishSettingsView } from "@/components/english-admin-views";
import { defaultEnglishSettings, type EnglishAdminConfiguration } from "@/lib/english-settings";
import { defaultEnglishCurriculum, initialEnglishProgress } from "@/lib/english-assistant";
import type { EnglishConversationDetail, EnglishResearchConversation } from "@/lib/english-groups";

const config: EnglishAdminConfiguration = {
  id: "english-config", revision: 3, enabled: true, has_api_key: true, created_at: "2026-10-04T10:00:00Z",
  settings: { ...defaultEnglishSettings(), model: "unchanged-shared-deepseek", disclosure: "英语课程登记须知" },
  base_prompt: "以 PEEC 三份材料开展教学，要求学生解释证据与观点的联系。",
  personality_prompt: "耐心沟通，每次回应围绕一项任务。", shared_experiment_revision: 12, curriculum: defaultEnglishCurriculum()
};
const counts = { deepseek_personality: 5, deepseek_control: 8 };
const first: EnglishResearchConversation = {
  id: "personality-record", participant_code: "E-001", title: "英语助教", student_id: "00123", group_code: "deepseek_personality",
  model_factor: "deepseek", personality: true, assigned_at: "2026-10-04T10:00:00Z", created_at: "2026-10-04T10:00:00Z",
  updated_at: "2026-10-04T11:00:00Z", request_count: 2, experiment_id: "shared-experiment", experiment_revision: 12,
  prompt_revision: 3, english_progress: initialEnglishProgress()
};
const legacy: EnglishResearchConversation = { ...first, id: "legacy-record", participant_code: "E-OLD", student_id: "00999",
  group_code: null, personality: null, model_factor: null, assigned_at: null, experiment_id: null, experiment_revision: null, prompt_revision: null };
const detail: EnglishConversationDetail = {
  conversation: first,
  messages: [
    { id: "user", role: "user", content: "<script>unsafe()</script>我的证据是阅读历史书。", status: "complete", turn_id: "turn", created_at: first.created_at },
    { id: "assistant", role: "assistant", content: "请进一步解释证据为什么支持观点。", status: "complete", turn_id: "turn", created_at: first.created_at }
  ],
  config: { id: config.id, settings: config.settings, base_prompt: config.base_prompt, personality_prompt: config.personality_prompt,
    prompt_revision: config.revision, source_revision: config.shared_experiment_revision, created_at: config.created_at, curriculum: config.curriculum },
  english_progress: { ...initialEnglishProgress(), stage: "participatory", step: 2 },
  english_turns: [{ stage: "participatory", achieved: false, evidence: "需要解释联系" }],
  connection: { source: "latest", experiment_revision: 15, published_at: first.created_at, endpoint: "https://shared.example/chat/completions",
    settings: { protocol: "openai-chat", api_base_url: "https://shared.example", api_url_mode: "base", anthropic_auth: "x-api-key", anthropic_workspace: "", token_parameter: "max_tokens" } }
};

describe("English administrator course and prompt presentation", () => {
  it("shows the original shared DeepSeek model as read-only and provides only English availability and disclosure controls", () => {
    const html = renderToStaticMarkup(createElement(EnglishSettingsView, { config, counts, mode: "live", disabled: false, refreshing: false,
      onEnabled: vi.fn(), onDisclosure: vi.fn(), onRefreshConnection: vi.fn() }));
    expect(html).toContain("unchanged-shared-deepseek");
    expect(html).toContain("共享 DeepSeek 模型");
    expect(html).toContain("已配置共享连接");
    expect(html).toContain('href="/admin"');
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).toContain('type="checkbox"');
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    expect(html).toContain("英语课程登记须知");
    expect(html).toContain("DeepSeek · 有人格");
    expect(html).toContain("DeepSeek · 无人格");
    expect(html).not.toMatch(/ChatGPT|API 密钥|最大输出 Token|Temperature/);
    expect(html).toContain("导入 → 学习目标 → 前测 → 参与式学习 → 后测 → 总结");
  });

  it("provides separate English teaching and personality prompt editors with clear group and snapshot scope", () => {
    const html = renderToStaticMarkup(createElement(EnglishPromptSettings, { config, disabled: false, onBasePrompt: vi.fn(), onPersonalityPrompt: vi.fn() }));
    expect(html.match(/<textarea\b/g)).toHaveLength(2);
    expect(html).toContain(config.base_prompt);
    expect(html).toContain(config.personality_prompt);
    expect(html).toContain("两组共同使用");
    expect(html).toContain("仅 DeepSeek · 有人格组");
    expect(html).toContain("固定阶段顺序");
    expect(html).toContain("只用于新登记");
    expect(html).toContain("发布新版本不会重新分组");
    const saving = renderToStaticMarkup(createElement(EnglishPromptSettings, { config, disabled: true, onBasePrompt: vi.fn(), onPersonalityPrompt: vi.fn() }));
    expect(saving.match(/<textarea\b[^>]*disabled/g)).toHaveLength(2);
  });

  it("keeps course, prompts and independent records together with the current section announced", () => {
    const html = renderToStaticMarkup(createElement(EnglishAdminNavigation, { section: "prompt", onSection: vi.fn() }));
    expect(html.match(/<button\b/g)).toHaveLength(4);
    expect(html).toMatch(/课程设置[^]*提示词配置[^]*BOPPPS 流程配置[^]*英语分组与记录/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('href="/admin"');
    expect(html).toContain('href="/english-assistant"');
    expect(html).not.toMatch(/Bloom|ChatGPT/);
  });
});

describe("independent English records presentation", () => {
  const recordProps: ComponentProps<typeof EnglishRecordsView> = {
    records: [first, legacy], counts, total: 120, offset: 0, loading: false,
    studentFilter: "00123", groupFilter: "legacy", onStudentFilter: vi.fn(), onGroupFilter: vi.fn(), onQuery: vi.fn(), onOpen: vi.fn(), onDelete: vi.fn()
  };

  it("preserves student identifiers and offers the two English groups, legacy and a deletion action tied to each student", () => {
    const html = renderToStaticMarkup(createElement(EnglishRecordsView, recordProps));
    expect(html).toContain("00123");
    expect(html).toContain("00999");
    expect(html).toContain('value="deepseek_personality"');
    expect(html).toContain('value="deepseek_control"');
    expect(html).toContain('value="legacy" selected=""');
    expect(html).toContain("历史未分组");
    expect(html).toContain("提示词 v3");
    expect(html).toContain("共 120 个英语会话");
    expect(html).not.toMatch(/chatgpt_|Bloom/);
    expect(html).toContain('aria-label="删除英语会话 00123"');
    expect(html).toContain('aria-label="删除英语会话 00999"');
    const initialVersion = renderToStaticMarkup(createElement(EnglishRecordsView, {
      ...recordProps, records: [{ ...first, prompt_revision: 0 }]
    }));
    expect(initialVersion).toContain("提示词 v0");
    expect(initialVersion).not.toContain("历史课程配置");
  });

  it("uses 50-record pagination and disables navigation at the boundaries or during loading", () => {
    const firstPage = renderToStaticMarkup(createElement(EnglishRecordsView, recordProps));
    expect(firstPage).toMatch(/aria-label="上一页英语记录"[^>]*disabled/);
    expect(firstPage).not.toMatch(/aria-label="下一页英语记录"[^>]*disabled/);
    const lastPage = renderToStaticMarkup(createElement(EnglishRecordsView, { ...recordProps, offset: 100 }));
    expect(lastPage).not.toMatch(/aria-label="上一页英语记录"[^>]*disabled/);
    expect(lastPage).toMatch(/aria-label="下一页英语记录"[^>]*disabled/);
    const loading = renderToStaticMarkup(createElement(EnglishRecordsView, { ...recordProps, loading: true, offset: 50 }));
    expect(loading).toContain("正在读取英语记录");
    expect(loading).toContain('role="status"');
    expect(loading).toMatch(/aria-label="上一页英语记录"[^>]*disabled/);
    expect(loading).toMatch(/aria-label="下一页英语记录"[^>]*disabled/);
  });

  it("shows original prompts, group, BOPPPS progress, student messages and assessment records with a JSON export", () => {
    const html = renderToStaticMarkup(createElement(EnglishRecordDetail, { detail, loading: false, error: "", onClose: vi.fn(), onRetry: vi.fn(), onExport: vi.fn(), onDelete: vi.fn() }));
    expect(html).toContain("导出 JSON");
    expect(html).toContain("DeepSeek · 有人格");
    expect(html).toContain("提示词 v3");
    expect(html).toContain("共享模型来源 v12");
    expect(html).toContain(config.base_prompt);
    expect(html).toContain(config.personality_prompt);
    expect(html).toContain("人格提示词（本组使用）");
    expect(html).toContain("当前活动 3 / 4");
    expect(html).toContain("课程判定与阶段记录（1）");
    expect(html).toContain("请进一步解释证据为什么支持观点");
    expect(html).not.toContain("<script>");
    expect(html).toContain("删除会话");
    expect(html).toContain("登记时 BOPPPS 流程内容");
    expect(html).toContain(config.curriculum.participatory.activities[2].criterion);
    const control = renderToStaticMarkup(createElement(EnglishRecordDetail, { detail: { ...detail, conversation: { ...first, group_code: "deepseek_control", personality: false } },
      loading: false, error: "", onClose: vi.fn(), onRetry: vi.fn(), onExport: vi.fn() }));
    expect(control).toContain("人格提示词（本组不使用）");
  });

  it("keeps a failed detail request reviewable and retryable while announcing loading state", () => {
    const props = { detail: null, loading: false, error: "连接中断，请重试", onClose: vi.fn(), onRetry: vi.fn(), onExport: vi.fn() };
    const failed = renderToStaticMarkup(createElement(EnglishRecordDetail, props));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("连接中断，请重试");
    expect(failed).toContain("重试读取");
    expect(failed).not.toContain("导出 JSON");
    const loading = renderToStaticMarkup(createElement(EnglishRecordDetail, { ...props, loading: true }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain("正在读取英语会话详情");
    expect(loading).not.toContain("重试读取");
  });

  it("identifies missing legacy demo snapshots without presenting defaults as historical model or prompts", () => {
    const oldDetail: EnglishConversationDetail = { ...detail, conversation: legacy, connection: undefined,
      config: { ...detail.config, id: null, base_prompt: null, personality_prompt: null, prompt_revision: null, source_revision: null, curriculum: null } };
    const html = renderToStaticMarkup(createElement(EnglishRecordDetail, { detail: oldDetail, loading: false, error: "", onClose: vi.fn(), onRetry: vi.fn(), onExport: vi.fn() }));
    expect(html).toContain("历史演示未保存模型与提示词快照");
    expect(html).not.toContain(config.settings.model);
    expect(html).not.toContain(config.base_prompt);
    expect(html).not.toContain(config.personality_prompt);
    expect(html).not.toContain(config.settings.system_prompt);
    expect(html).toContain("历史演示没有登记快照");
  });
});
