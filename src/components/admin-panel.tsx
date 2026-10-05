"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, Database, Eye, EyeOff, FileText, KeyRound, LoaderCircle, LogOut, MessagesSquare, PlugZap, RefreshCw, Save, Settings2, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import { authFetch, browserClient, browserAuthFailure, responseJson } from "@/lib/browser";
import { dataBackend } from "@/lib/backend";
import { demoConfig, demoRecord, demoCounts, saveDemoConfig, deleteDemoConversation } from "@/lib/demo";
import { defaultSettings, type ChatMessage, type RuntimeMode, type StudySettings } from "@/lib/types";
import { effectiveSettings, groups, groupLabel, modelFactors, type AdminExperiment, type ModelConnection, type ModelFactor, type GroupCounts, type ResearchConversation } from "@/lib/experiment";
import { experimentSchema, contentDraftSchema } from "@/lib/validation";
import { resolveProviderEndpoint } from "@/lib/provider-endpoint";
import { Brand, ChatMark, DemoBanner } from "./shared";
import { Markdown } from "./markdown";
import { questionMessageFeedback } from "@/lib/question-feedback";
import { ConversationDeleteDialog } from "./conversation-delete-dialog";
import { ConversationConnectionDetails } from "./conversation-connection-info";
import type { ConversationConnectionInfo } from "@/lib/conversation-connection";
import { BasePromptPresets } from "./base-prompt-presets";
import { QuestionModeSettings } from "./question-mode-settings";
import { QuestionProgress } from "./question-progress";
import { defaultQuestionMode, type QuestionProgress as QuestionState } from "@/lib/question-mode";

type Section = "overview" | "prompt" | "questions" | "connection" | "records";
type RecordDetail = { conversation: ResearchConversation; messages: ChatMessage[]; config: { revision: number; settings: StudySettings };
  connection: ConversationConnectionInfo; question_progress?: QuestionState | null; question_turns?: unknown[] };
const protocols = [
  { id: "openai-chat", label: "OpenAI Compatible", short: "Chat Completions", description: "OpenAI、DeepSeek 及兼容网关", endpoint: "/chat/completions" },
  { id: "openai-responses", label: "OpenAI Responses", short: "Responses", description: "OpenAI 原生 Responses 接口", endpoint: "/responses" },
  { id: "anthropic", label: "Anthropic", short: "Messages", description: "Claude 原生协议及兼容网关", endpoint: "/messages" }
] as const;
const nav: { id: Section; label: string; icon: typeof Settings2 }[] = [
  { id: "overview", label: "研究设置", icon: Settings2 },
  { id: "prompt", label: "AI 提示词", icon: FileText },
  { id: "questions", label: "题目问答", icon: BookOpen },
  { id: "connection", label: "模型连接", icon: PlugZap },
  { id: "records", label: "对话记录", icon: MessagesSquare }
];

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}
function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function ExperimentMatrix({ counts }: { counts: GroupCounts | null }) {
  return <div className="experiment-matrix"><table><caption>2 × 2 实验 · 已登记人数（跨配置版本累计）</caption>
    <thead><tr><th>模型因素</th><th>有人格提示词</th><th>无人格提示词</th></tr></thead><tbody>
      {modelFactors.map(factor => <tr key={factor}><th>{factor === "deepseek" ? "DeepSeek" : "ChatGPT"}</th>
        {groups.filter(g => g.model === factor).map(g => <td key={g.code}><strong>{counts?.[g.code] ?? "—"}</strong><span>{g.personality ? "基础 + 人格" : "仅基础提示词"}</span></td>)}</tr>)}
    </tbody></table><p>在当前人数最少的组中随机分配。刷新、重试、发布配置均不重新分组；管理员删除登记后人数会减少，重新登记按新参与者分配。已登记不等于已完成实验。</p></div>;
}

export function AdminPanel({ mode }: { mode: RuntimeMode }) {
  const [section, setSection] = useState<Section>("connection");
  const [bloomExpanded, setBloomExpanded] = useState(false);
  const [authenticated, setAuthenticated] = useState(mode === "demo");
  const [initializing, setInitializing] = useState(true);
  const [canRetryConnection, setCanRetryConnection] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [config, setConfig] = useState<AdminExperiment | null>(null);
  const [modelFactor, setModelFactor] = useState<ModelFactor>("deepseek");
  const [apiKeys, setApiKeys] = useState({ deepseek: "", chatgpt: "" });
  const [promptGroup, setPromptGroup] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [records, setRecords] = useState<ResearchConversation[]>([]);
  const [counts, setCounts] = useState<GroupCounts | null>(null);
  const [studentFilter, setStudentFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ResearchConversation | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const detailRequest = useRef(0);
  const recordListRequest = useRef(0);
  const deletePending = useRef(false);
  const recordDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const previewSettings = config ?? defaultSettings;
  const connection = config?.connections[modelFactor];

  async function loadSettings() {
    let next: AdminExperiment;
    if (mode === "demo") next = demoConfig();
    else {
      const response = await authFetch("/api/admin/settings", "admin");
      if (response.status === 401 || response.status === 403) setCanRetryConnection(false);
      next = await responseJson<AdminExperiment>(response);
    }
    setConfig(next); setApiKeys({ deepseek: "", chatgpt: "" }); setDirty(false); setConnectionDirty(false); setAuthenticated(true); setCanRetryConnection(false);
  }
  async function restoreSession() {
    const { data, error: sessionError } = await browserClient("admin").auth.getSession();
    if (sessionError) throw new Error(browserAuthFailure(sessionError).message);
    setCanRetryConnection(Boolean(data.session));
    if (data.session) await loadSettings();
    return Boolean(data.session);
  }
  async function retryConnection() {
    setSaving(true); setError("");
    try {
      if (!await restoreSession()) setError("请先登录管理员账号。");
    } catch (e) { setError(e instanceof Error ? e.message : "无法连接控制台，请稍后重试。"); }
    finally { setSaving(false); }
  }
  async function loadRecords(nextOffset = 0) {
    const request = ++recordListRequest.current;
    setRecordsLoading(true); setError("");
    try {
      if (mode === "demo") {
        const current = demoRecord();
        const matches = current && (!studentFilter.trim() || current.conversation.student_id === studentFilter.trim().toUpperCase()) &&
          (!groupFilter || current.conversation.group_code === groupFilter);
        setRecords(matches ? [current.conversation] : []);
        setTotal(matches ? 1 : 0); setOffset(0); setCounts(demoCounts());
      } else {
        const query = new URLSearchParams({ offset: String(nextOffset), student_id: studentFilter.trim(), group: groupFilter });
        const data = await responseJson<{ conversations: ResearchConversation[]; total: number; offset: number; counts: GroupCounts }>(
          await authFetch("/api/admin/conversations?" + query, "admin"));
        if (request !== recordListRequest.current) return false;
        setRecords(data.conversations); setTotal(data.total); setOffset(data.offset); setCounts(data.counts);
      }
      return true;
    } catch (e) { if (request === recordListRequest.current) setError(e instanceof Error ? e.message : "无法读取记录。"); return false; }
    finally { if (request === recordListRequest.current) setRecordsLoading(false); }
  }
  useEffect(() => {
    async function init() {
      try {
        if (mode === "demo") await loadSettings();
        else await restoreSession();
      } catch (e) { setError(e instanceof Error ? e.message : "无法验证管理员身份。"); }
      finally { setInitializing(false); }
    }
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if ((section === "records" || section === "overview") && authenticated) void loadRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, authenticated]);
  useEffect(() => {
    if (section !== "connection") setBloomExpanded(true);
  }, [section]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    if (detail || detailLoading) recordDialog.current?.showModal();
    else recordDialog.current?.close();
  }, [detail, detailLoading]);
  useEffect(() => {
    if (deleteTarget) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [deleteTarget]);

  function closeDetail() {
    detailRequest.current++;
    setDetail(null);
    setDetailLoading(false);
  }
  function requestDeleteConversation(conversation: ResearchConversation) {
    if (deletePending.current) return;
    setDeleteTarget(conversation); setDeleteConfirmation(""); setDeleteError(""); setError("");
  }
  function closeDeleteDialog() {
    if (deletePending.current) return;
    setDeleteTarget(null); setDeleteConfirmation(""); setDeleteError("");
  }
  async function confirmDeleteConversation() {
    if (!deleteTarget || deletePending.current || deleteConfirmation !== "删除") return;
    const target = deleteTarget;
    deletePending.current = true;
    setDeleting(true); setDeleteError(""); setNotice("");
    try {
      if (mode === "demo") deleteDemoConversation(target.id);
      else await responseJson<{ deleted: true; conversation_id: string }>(await authFetch("/api/admin/conversations", "admin", {
        method: "DELETE", body: JSON.stringify({ conversation_id: target.id, confirmation: "DELETE" })
      }));
      if (detail?.conversation.id === target.id) closeDetail();
      setDeleteTarget(null); setDeleteConfirmation("");
      setRecords(current => current.filter(record => record.id !== target.id));
      setTotal(current => Math.max(0, current - 1));
      const refreshed = await loadRecords(records.length === 1 && offset > 0 ? Math.max(0, offset - 50) : offset);
      setNotice(refreshed ? "已永久删除会话及关联消息、请求记录和学号登记；学号可重新登记，分组统计已更新。" :
        "会话已永久删除，但列表和分组统计刷新失败，请稍后重新查询。");
    } catch (e) { setDeleteError(e instanceof Error ? e.message : "删除失败，请刷新核实后重试。"); }
    finally { deletePending.current = false; setDeleting(false); }
  }

  function edit<K extends keyof AdminExperiment>(key: K, value: AdminExperiment[K]) {
    setConfig(current => current ? { ...current, [key]: value } : current);
    setDirty(true); setNotice("");
  }
  function editConnection<K extends keyof ModelConnection>(key: K, value: ModelConnection[K]) {
    if (config && connection) { edit("connections", { ...config.connections, [modelFactor]: { ...connection, [key]: value } }); setConnectionDirty(true); }
  }
  function changeProtocol(protocol: StudySettings["protocol"]) {
    // Changing wire protocol must not silently switch the assigned model provider.
    editConnection("protocol", protocol);
    setNotice("协议已切换，请核对当前模型的 API 地址、认证方式和密钥；不会自动更换服务商或模型。");
  }
  async function login(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError("");
    try {
      const { error: loginError } = await browserClient("admin").auth.signInWithPassword({ email, password });
      if (loginError) throw new Error(browserAuthFailure(loginError, "login").message);
      setPassword("");
      setCanRetryConnection(true);
      await loadSettings();
    } catch (e) { setError(e instanceof Error ? e.message : "无法登录。"); }
    finally { setSaving(false); }
  }
  async function publish() {
    if (!config) return;
    setError(""); setNotice(""); setSaving(true);
    try {
      const { id: _id, revision, has_api_keys: _has, created_at: _created,
        draft_revision, has_content_draft: _draft, ...editable } = config;
      const input = experimentSchema.safeParse({ ...editable, api_keys: apiKeys, expected_revision: revision,
        ...(draft_revision === undefined ? {} : { expected_draft_revision: draft_revision }) });
      if (!input.success) {
        const path = input.error.issues[0]?.path[0];
        if (path === "connections") {
          setSection("connection"); setModelFactor(input.error.issues[0].path[1] as ModelFactor);
          if (input.error.issues[0].path[2] === "api_base_url") throw new Error(input.error.issues[0].message);
        }
        if (path === "base_prompt" || path === "personality_prompt") setSection("prompt");
        if (path === "question_mode") {
          setSection("questions"); throw new Error("请完整填写三道题的标题、题干、目标层级和参考要点，并检查长度。");
        }
        throw new Error("请填写两套模型 ID、基础提示词和人格提示词，并检查参数；四组须同时准备好才能发布。");
      }
      if (mode === "demo") {
        const next = { ...config, revision: config.revision + 1, created_at: new Date().toISOString(), has_api_keys: { deepseek: false, chatgpt: false } };
        saveDemoConfig(next); setConfig(next);
        setNotice("演示配置已保存在本浏览器。真实密钥不会保存或使用；正式环境中已分组旧会话会使用最新连接，其余实验配置保持不变。");
      } else {
        const next = await responseJson<AdminExperiment>(await authFetch("/api/admin/settings", "admin", {
          method: "PUT", body: JSON.stringify(input.data)
        }));
        setConfig(next); setNotice("已同时发布四组配置 v" + next.revision + "。已分组旧会话下次请求使用最新地址、协议及密钥；原模型 ID、提示词、分组和生成参数不变。新登记使用完整新配置。");
      }
      setApiKeys({ deepseek: "", chatgpt: "" }); setDirty(false); setConnectionDirty(false);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败。"); }
    finally { setSaving(false); }
  }
  async function saveContentDraft() {
    if (!config) return;
    setError(""); setNotice(""); setSaving(true);
    try {
      const { title, assistant_name, welcome_message, disclosure, base_prompt, personality_prompt, question_mode } = config;
      const input = contentDraftSchema.parse({ content: { title, assistant_name, welcome_message, disclosure,
        base_prompt, personality_prompt, ...(question_mode ? { question_mode } : {}) },
        enabled: config.enabled, expected_draft_revision: config.draft_revision ?? 0 });
      const next = await responseJson<AdminExperiment>(await authFetch("/api/admin/content-draft", "admin", {
        method: "PUT", body: JSON.stringify(input)
      }));
      // Saving teaching content must retain unsaved connection edits on this screen.
      setConfig({ ...next, connections: config.connections }); setDirty(connectionDirty);
      setNotice("内容草稿 d" + next.draft_revision + " 已保存。完成模型配置并发布后，对新登记生效。");
    } catch (error) { setError(error instanceof Error ? error.message : "内容草稿暂时无法保存。"); }
    finally { setSaving(false); }
  }
  async function openRecord(id: string) {
    const request = ++detailRequest.current;
    setDetail(null); setDetailLoading(true); setError("");
    try {
      const data = mode === "demo" ? demoRecord() :
        await responseJson<RecordDetail>(await authFetch("/api/admin/conversations?id=" + id, "admin"));
      if (request === detailRequest.current) setDetail(data);
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败。"); }
    finally { if (request === detailRequest.current) setDetailLoading(false); }
  }
  function exportDetail() {
    if (!detail) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), mode, ...detail }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = "studychat-" + detail.conversation.participant_code + ".json";
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (initializing) return <div className="initializing"><LoaderCircle className="spin" size={24}/><span>正在连接控制台…</span></div>;
  if (!authenticated) return <div className="login-shell"><Brand admin/><main className="login-card">
    <div className="login-icon"><ShieldCheck size={29}/></div><h1>登录研究控制台</h1>
    <p className="muted">管理提示词、模型连接和对话记录。</p>
    <form onSubmit={login}>
      <Field label={dataBackend() === "cloudbase" ? "管理员账号（用户名或邮箱）" : "管理员邮箱"}><input type={dataBackend() === "cloudbase" ? "text" : "email"} value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" placeholder={dataBackend() === "cloudbase" ? "请输入 CloudBase 管理员账号" : "researcher@example.com"} required/></Field>
      <Field label="密码"><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" placeholder="输入管理员密码" required/></Field>
      {error && <p className="error-box" role="alert">{error}</p>}
      <button className="button primary full-width" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17}/> : <>登录控制台<ArrowRight size={17}/></>}</button>
      {canRetryConnection && <button type="button" className="button secondary full-width login-retry" disabled={saving} onClick={() => void retryConnection()}>
        <RefreshCw size={17}/>重试连接（使用已有登录）
      </button>}
    </form><p className="login-footnote"><KeyRound size={13}/>仅限研究管理员，不提供公开注册</p>
  </main><span className="login-bottom">研究控制台 · 仅管理员可访问</span></div>;

  const activeNav = nav.find(item => item.id === section)!;
  const selectedProtocol = protocols.find(p => p.id === connection?.protocol) ?? protocols[0];
  let endpointPreview = "";
  let endpointError = "";
  if (connection) {
    try { endpointPreview = resolveProviderEndpoint(connection); }
    catch (e) { endpointError = e instanceof Error ? e.message : "请检查 API 地址。"; }
  }
  return <div className="app-frame admin-frame">
    {mode === "demo" && <DemoBanner/>}
    <div className="admin-layout">
      <aside className="admin-sidebar"><Brand admin/>
        <div className="workspace-label"><span className="workspace-icon"><BookOpen size={16}/></span><span>研究工作区</span></div>
        <div className="sidebar-section-label">管理</div>
        <nav className="admin-project-nav" aria-label="后台导航">
          <button type="button" className={"admin-nav " + (section === "connection" ? "active" : "")}
            onClick={() => { setSection("connection"); setBloomExpanded(false); setNotice(""); }} aria-current={section === "connection" ? "page" : undefined}>
            <PlugZap size={18}/>模型连接{section === "connection" && <ChevronRight size={14}/>}</button>
          <a className="admin-nav" href="/admin/english-assistant"><BookOpen size={18}/>英语助教<ArrowUpRight size={14}/></a>
          <div className={"admin-nav-accordion " + (section !== "connection" ? "has-active" : "")}>
            <button type="button" className="admin-accordion-toggle" id="bloom-admin-heading"
              aria-expanded={bloomExpanded} aria-controls="bloom-admin-sections" onClick={() => setBloomExpanded(!bloomExpanded)}>
              <Settings2 size={18}/><span className="admin-accordion-label"><strong>Bloom 管理</strong>
                <small>{section === "connection" ? "研究设置、提示词与记录" : activeNav.label}</small></span>
              <ChevronRight size={16} className={"admin-accordion-chevron " + (bloomExpanded ? "expanded" : "")}/>
            </button>
            <div className="admin-accordion-items" id="bloom-admin-sections" role="group" aria-labelledby="bloom-admin-heading" hidden={!bloomExpanded}>
              {nav.filter(item => item.id !== "connection").map(item => {
                const Icon = item.icon;
                return <button type="button" key={item.id} className={"admin-nav " + (item.id === section ? "active" : "")}
                  onClick={() => { setSection(item.id); setNotice(""); }} aria-current={item.id === section ? "page" : undefined}>
                  <Icon size={18}/>{item.label}{item.id === section && <ChevronRight size={14}/>}</button>;
              })}
            </div>
          </div>
        </nav>
        <div className="admin-sidebar-note"><ShieldCheck size={16}/><p>管理设置仅在此处可见，<br/>不向被试开放。</p></div>
        <div className="admin-account"><span className="account-avatar">研</span><span>研究管理员<small>{mode === "demo" ? "本地演示工作区" : "管理员权限已验证"}</small></span>
          {mode !== "demo" && <button className="icon-button" aria-label="退出登录" onClick={async () => {
            setError("");
            try {
              const { error: logoutError } = await browserClient("admin").auth.signOut();
              if (logoutError) throw new Error(browserAuthFailure(logoutError).message);
              setAuthenticated(false); setConfig(null); setApiKeys({ deepseek: "", chatgpt: "" }); setDetail(null); setRecords([]);
            } catch (cause) { setError(cause instanceof Error ? cause.message : "退出失败，请重试。"); }
          }}><LogOut size={16}/></button>}</div>
      </aside>
      <main className="admin-main">
        <header className="admin-header"><div className="breadcrumb">工作区<ChevronRight size={13}/><strong>{activeNav.label}</strong></div>
          <a className="button small secondary" href="/" target="_blank" rel="noopener noreferrer">打开被试页<ArrowUpRight size={15}/></a></header>
        <div className="admin-content">
          <div className="admin-page-heading"><div>
            <h1>{activeNav.label}</h1><p>{section === "overview" ? "设置被试页面内容与对话开放状态。" :
              section === "prompt" ? "定义助手的角色、目标与交流规则。" : section === "questions" ? "配置三道题、目标层级与两轮问答流程。" :
              section === "connection" ? "选择接口协议，配置 API 地址与模型。" : "查看、追溯和导出被试的完整对话。"}</p></div>
            {section !== "records" ? <div className="publish-group"><span className={dirty ? "unsaved-label" : "saved-label"}>{dirty ? "有未发布修改" : config?.revision ? "当前 v" + config.revision : config?.has_content_draft ? "内容草稿 d" + config.draft_revision + " · 未发布" : "尚未发布"}</span>
              {!config?.id && section !== "connection" && dataBackend() === "cloudbase" && <button className="button secondary" onClick={() => void saveContentDraft()} disabled={saving || !config}><Save size={16}/>保存内容草稿</button>}
              <button className="button primary" onClick={() => void publish()} disabled={saving || !config}>{saving ? <LoaderCircle size={16} className="spin"/> : <Save size={16}/>}保存并发布</button></div> :
              <button className="button secondary" onClick={() => void loadRecords(offset)} disabled={recordsLoading}><RefreshCw size={16} className={recordsLoading ? "spin" : ""}/>刷新记录</button>}
          </div>
          {error && <div className="error-box" role="alert"><CircleAlert size={17}/>{error}</div>}
          {notice && <div className="success-box" role="status"><Check size={17}/>{notice}</div>}
          {config?.has_content_draft && <p className="small-note">已保存内容草稿 d{config.draft_revision}，模型配置尚未发布。开放状态随首次正式发布生效。</p>}
          {section !== "records" && config && <div className="settings-grid"><div className="settings-primary">
            {section === "overview" && <>
              <section className="settings-card compact"><div className="card-heading"><span className="section-icon"><SlidersHorizontal size={19}/></span><div><h2>模型 × 人格提示词</h2><p>四组均衡随机分配，组别仅管理员可见。</p></div></div><ExperimentMatrix counts={counts}/></section>
              <section className="settings-card"><div className="card-heading"><span className="section-icon"><Settings2 size={19}/></span><div><h2>对话空间</h2><p>四组共用同一页面与欢迎语；避免在这些内容中透露组别。</p></div></div>
                <div className="two-fields"><Field label="研究页面标题"><input value={config.title} maxLength={80} onChange={e => edit("title", e.target.value)}/></Field>
                  <Field label="助手名称"><input value={config.assistant_name} maxLength={40} onChange={e => edit("assistant_name", e.target.value)}/></Field></div>
                <Field label="欢迎语" help="在首次进入、尚未发送消息时展示。"><textarea rows={4} value={config.welcome_message} maxLength={2000} onChange={e => edit("welcome_message", e.target.value)}/></Field>
                <Field label="研究告知" help="始终显示在输入框下方，请根据实际研究及知情同意流程调整。"><textarea rows={3} value={config.disclosure} maxLength={2000} onChange={e => edit("disclosure", e.target.value)}/></Field>
              </section>
              <section className="settings-card compact"><div className="switch-row"><div><h2>开放研究对话</h2><p>关闭后暂停所有会话的新请求，已保存的记录不受影响。</p></div>
                <label className="toggle"><input type="checkbox" checked={config.enabled} onChange={e => edit("enabled", e.target.checked)} aria-label="开放研究对话"/><span/></label></div>
                <div className="small-note">更改此开关后，点击「保存并发布」生效；已在生成的回复会继续完成。</div>
              </section>
            </>}
            {section === "prompt" && <section className="settings-card"><div className="card-heading"><span className="section-icon"><FileText size={19}/></span><div><h2>实验提示词</h2><p>由服务端组合并注入，四组使用相同的基础任务。</p></div></div>
              <BasePromptPresets value={config.base_prompt} onApply={value => edit("base_prompt", value)} disabled={saving}/>
              <Field label="共用基础提示词 · 四组共用" help="填写研究任务、流程和共同规则。为避免混淆人格操纵，不要在此描述实验人格。">
                <textarea className="prompt-editor experiment-prompt" rows={7} maxLength={10000} value={config.base_prompt} onChange={e => edit("base_prompt", e.target.value)} spellCheck={false}/>
              </Field>
              <Field label="额外人格提示词 · 仅有人格组" help="DeepSeek 和 ChatGPT 的有人格组共用此文本；无人格组不添加任何人格提示词。请填写你的正式实验材料。">
                <textarea className="prompt-editor experiment-prompt" rows={8} maxLength={10000} value={config.personality_prompt} onChange={e => edit("personality_prompt", e.target.value)} placeholder="在这里定义实验人格、行为风格与表达方式…" spellCheck={false}/>
              </Field>
              <Field label="预览该组最终系统提示词"><select value={promptGroup} onChange={e => setPromptGroup(Number(e.target.value))}>{groups.map((g, i) => <option key={g.code} value={i}>{g.label}</option>)}</select></Field>
              <pre className="effective-prompt">{effectiveSettings(config, groups[promptGroup]).system_prompt}</pre>
              <div className="editor-bottom"><span>无人格 = 不额外注入人格，不代表模型本身没有风格</span></div>
              <div className="info-note"><ShieldCheck size={18}/><span>发布会生成新版本。已有会话保留开始时的模型 ID、提示词与分组；只有连接信息随对应模型的最新发布同步。</span></div>
              <p className="small-note">不要在提示词中保存机密；模型仍可能在回复中自述身份或复述提示。页面隐藏组别不等于完全盲法。</p>
            </section>}
            {section === "questions" && <QuestionModeSettings value={config.question_mode ?? defaultQuestionMode()}
              onChange={value => edit("question_mode", value)} onOpenPrompts={() => setSection("prompt")}/>}
            {section === "connection" && connection && <>
              <div className="model-tabs" aria-label="选择要配置的模型因素">{modelFactors.map(factor => <button key={factor} aria-pressed={modelFactor === factor} className={modelFactor === factor ? "active" : ""}
                onClick={() => { setModelFactor(factor); setShowKey(false); }}>{factor === "deepseek" ? "DeepSeek" : "ChatGPT"}<small>{config.has_api_keys[factor] ? "密钥已配置" : "待配置"}</small></button>)}</div>
              <div className="info-note"><PlugZap size={17}/><span>正在配置 {modelFactor === "deepseek" ? "DeepSeek" : "ChatGPT"} 因素的两个组。两套模型的协议、API 地址和密钥独立保存；请确认模型 ID 和网关实际路由对应此模型。</span></div>
              <div className="info-note"><RefreshCw size={17}/><span>保存并发布后，已分组旧会话下次请求自动更新对应模型的地址、协议、认证和密钥。原模型 ID、提示词、分组及生成参数不变；新接口必须支持旧模型 ID。历史未分组会话保留原连接。</span></div>
              <section className="settings-card"><div className="card-heading"><span className="section-icon"><PlugZap size={19}/></span><div><h2>接口协议</h2><p>不同协议使用独立的请求和流式响应适配器。</p></div></div>
                <div className="protocol-options">{protocols.map(protocol => <button key={protocol.id}
                  className={"protocol-card " + (connection.protocol === protocol.id ? "selected" : "")}
                  onClick={() => changeProtocol(protocol.id)} aria-pressed={connection.protocol === protocol.id}>
                  <span className="protocol-card-top"><span className="protocol-symbol">{protocol.id === "anthropic" ? "A" : "O"}</span><span className="radio-indicator">{connection.protocol === protocol.id && <span/>}</span></span>
                  <strong>{protocol.label}</strong><small>{protocol.short}</small></button>)}</div>
                <div className="protocol-description"><span className="status-dot"/>{selectedProtocol.description}<code>{selectedProtocol.endpoint}</code></div>
                <Field label="API 地址方式" help="不同服务商、协议可以使用不同路径；只修改当前模型的连接。">
                  <select value={connection.api_url_mode ?? "base"} onChange={e => editConnection("api_url_mode", e.target.value as ModelConnection["api_url_mode"])}>
                    <option value="base">基础地址 · 按协议追加路径</option><option value="endpoint">完整接口地址 · 不追加路径</option>
                  </select>
                </Field>
                <Field label={connection.api_url_mode === "endpoint" ? "完整 API 接口地址" : "API 基础地址"}
                  help={connection.api_url_mode === "endpoint" ? "填写服务商文档中的完整请求地址，不删除或追加任何接口路径；域名须在 AI_ALLOWED_HOSTS 中。" : "按所选协议追加 " + selectedProtocol.endpoint + "；自定义网关请填完整基础路径，域名须在 AI_ALLOWED_HOSTS 中。"}>
                  <input type="url" value={connection.api_base_url} onChange={e => editConnection("api_base_url", e.target.value)}
                    placeholder={"https://api.example.com/v1" + (connection.api_url_mode === "endpoint" ? selectedProtocol.endpoint : "")} spellCheck={false}/>
                </Field>
                <div className="info-note" role="status"><PlugZap size={17}/><span>{endpointError || <>最终请求地址：<code className="endpoint-url">{endpointPreview}</code></>}</span></div>
                <Field label="API 密钥" help={mode === "demo" ? "演示模式不会保存或调用密钥，请勿输入真实密钥。" : config.has_api_keys[modelFactor] ? "已加密保存。留空保留现有密钥；更换域名时必须重新填写。" : "首次发布必填，仅在服务端加密保存，不会返回完整密钥。"}>
                  <div className="secret-input"><input type={showKey ? "text" : "password"} value={apiKeys[modelFactor]} autoComplete="new-password" maxLength={1000}
                    disabled={mode === "demo"} onChange={e => { setApiKeys({ ...apiKeys, [modelFactor]: e.target.value }); setDirty(true); setConnectionDirty(true); }} placeholder={config.has_api_keys[modelFactor] ? "已保存 · 输入新密钥可替换" : mode === "demo" ? "演示模式 · 密钥输入已禁用" : "输入提供商或网关的 API 密钥"}/>
                    <button className="icon-button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div>
                </Field>
                <Field label="模型 ID" help="填写该服务实际支持的完整模型 ID，不自动替换为其他模型。"><input value={connection.model} onChange={e => editConnection("model", e.target.value)} placeholder="由 API 提供商给出的模型 ID" spellCheck={false}/></Field>
                {connection.protocol === "anthropic" && <div className="two-fields">
                  <Field label="Anthropic 认证方式"><select value={connection.anthropic_auth} onChange={e => editConnection("anthropic_auth", e.target.value as "x-api-key" | "bearer")}><option value="x-api-key">x-api-key 请求头</option><option value="bearer">Authorization: Bearer</option></select></Field>
                  <Field label="Workspace ID（选填）"><input value={connection.anthropic_workspace} onChange={e => editConnection("anthropic_workspace", e.target.value)} placeholder="需要时填写，通常留空"/></Field>
                </div>}
              </section>
              <section className="settings-card"><div className="card-heading"><span className="section-icon"><SlidersHorizontal size={19}/></span><div><h2>生成参数</h2><p>仅影响新会话，不向被试开放。</p></div></div>
                <div className="two-fields"><Field label="最大输出 Token" help="允许范围 256–8192。"><input type="number" min={256} max={8192} value={connection.max_tokens} onChange={e => editConnection("max_tokens", Number(e.target.value))}/></Field>
                  <Field label="Temperature（选填）" help="留空表示不发送此参数，兼容不支持温度的模型。"><input type="number" min={0} max={2} step={0.1} value={connection.temperature ?? ""} placeholder="使用模型默认值" onChange={e => editConnection("temperature", e.target.value === "" ? null : Number(e.target.value))}/></Field></div>
                {connection.protocol === "openai-chat" && <Field label="输出上限参数名" help="部分模型需要 max_completion_tokens，请遵循提供商文档。"><select value={connection.token_parameter} onChange={e => editConnection("token_parameter", e.target.value as StudySettings["token_parameter"])}><option value="max_tokens">max_tokens（常用兼容接口）</option><option value="max_completion_tokens">max_completion_tokens</option></select></Field>}
                <div className="info-note"><KeyRound size={17}/><span>接口只接收服务端验证后的会话历史。被试不能指定模型、地址、密钥或系统提示词。</span></div>
              </section>
            </>}
          </div><aside className="settings-preview">
            <div className="preview-label"><Eye size={15}/>被试端预览<span>只读</span></div>
            <div className="mini-chat"><div className="mini-chat-header">{previewSettings.title}</div><div className="mini-chat-body"><span className="mini-avatar"><ChatMark size={28}/></span><strong>{previewSettings.assistant_name}</strong><p>{previewSettings.welcome_message}</p></div>
              <div className="mini-composer">发送消息…<span>↑</span></div><p className="mini-disclosure">对话自动记录</p></div>
            <div className="boundary-list"><h3>被试端功能边界</h3><span><Check size={14}/>文本对话与自动保存</span><span><Check size={14}/>刷新恢复当前会话</span><span><X size={14}/>无模型切换、上传或工具</span><span><X size={14}/>不展示提示词与 API 密钥</span></div>
            <div className="version-note"><Database size={17}/><div><strong>{config.revision ? "配置版本 v" + config.revision : "等待首次发布"}</strong><p>{config.created_at ? "最近发布 " + formatDate(config.created_at) : "发布后才能开始真实研究对话。"}</p></div></div>
          </aside></div>}
          {section === "records" && <section className="records-card"><div className="records-heading"><div><h2>会话档案 <span>{total}</span></h2><p>按学号关联，导出包含组别、登记时间、配置版本和完整对话。</p></div><span className="record-privacy"><ShieldCheck size={14}/>仅管理员可见</span></div>
            <div className="records-summary"><ExperimentMatrix counts={counts}/></div>
            <form className="record-filters" onSubmit={e => { e.preventDefault(); void loadRecords(0); }}>
              <Field label="按完整学号查询"><input value={studentFilter} onChange={e => setStudentFilter(e.target.value)} maxLength={32} placeholder="保留前导 0"/></Field>
              <Field label="实验分组"><select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}><option value="">全部分组</option>{groups.map(g => <option key={g.code} value={g.code}>{g.label}</option>)}<option value="legacy">历史 / 未分组</option></select></Field>
              <button className="button secondary" disabled={recordsLoading}>查询</button>
            </form>
            {recordsLoading ? <div className="empty-state"><LoaderCircle className="spin" size={25}/><p>正在读取会话…</p></div> : records.length === 0 ? <div className="empty-state"><span><MessagesSquare size={28}/></span><h3>暂无对话记录</h3><p>{mode === "demo" ? "打开被试页发送一条消息，再回到这里刷新。" : "参与者开始对话后，记录会显示在这里。"}</p></div> :
              <div className="record-table-wrap"><table className="record-table"><thead><tr><th>学号 / 会话</th><th>分组 / 实验版本</th><th>开始时间</th><th/></tr></thead><tbody>{records.map(record =>
                <tr key={record.id}><td><strong>{record.student_id ?? record.participant_code}</strong><span>{record.title}</span></td><td>{groupLabel(record.group_code)}<span>{record.experiment_revision ? "v" + record.experiment_revision : "不纳入四组统计"}</span></td><td>{formatDate(record.created_at)}</td><td><div className="record-actions"><button className="button text small" disabled={deleting} onClick={() => void openRecord(record.id)}>查看对话<ChevronRight size={14}/></button>
                  <button className="button text small" disabled={deleting} aria-label={"删除会话 " + (record.student_id ?? record.participant_code)} onClick={() => requestDeleteConversation(record)}><Trash2 size={14}/>删除</button></div></td></tr>
              )}</tbody></table></div>}
            <div className="pagination"><span>共 {total} 个会话 · 时间以本机时区显示</span><div><button className="icon-button" aria-label="上一页" disabled={offset === 0 || recordsLoading} onClick={() => void loadRecords(Math.max(0, offset - 50))}><ArrowLeft size={16}/></button><span>{Math.floor(offset / 50) + 1}</span><button className="icon-button" aria-label="下一页" disabled={offset + 50 >= total || recordsLoading} onClick={() => void loadRecords(offset + 50)}><ArrowRight size={16}/></button></div></div>
          </section>}
        </div>
      </main>
    </div>
    <dialog ref={recordDialog} className="drawer-dialog" aria-label="会话详情" onClose={closeDetail}
      onClick={e => { if (e.target === e.currentTarget) closeDetail(); }}>
      <section className="record-drawer">
        <header><div><p className="eyebrow">会话详情</p><h2>{detail?.conversation.student_id ?? detail?.conversation.participant_code ?? "正在读取…"}</h2></div>
          <button autoFocus className="icon-button" aria-label="关闭会话详情" onClick={closeDetail}><X size={20}/></button></header>
        {detail ? <><div className="detail-meta"><span>{detail.messages.length} 条消息 · 登记配置 v{detail.config.revision}</span><div className="record-actions"><button className="button secondary small" onClick={exportDetail}><ArrowDownToLine size={15}/>导出 JSON</button>
          <button className="button secondary small" disabled={deleting} onClick={() => requestDeleteConversation(detail.conversation)}><Trash2 size={15}/>删除会话</button></div></div>
          <div className="detail-assignment"><strong>{groupLabel(detail.conversation.group_code)}</strong><span>{detail.conversation.experiment_revision ? "实验 v" + detail.conversation.experiment_revision : "历史记录"}{detail.conversation.assigned_at ? " · 登记 " + formatDate(detail.conversation.assigned_at) : ""}</span></div>
          <ConversationConnectionDetails connection={detail.connection} model={detail.config.settings.model}/>
          <QuestionProgress state={detail.question_progress} audience="admin"/>
          {detail.config.settings.question_mode?.enabled && <details className="config-details"><summary>查看登记时的三道题与目标层级</summary>
            {detail.config.settings.question_mode.questions.map((question, i) => <div key={i}><strong>第 {i + 1} 题 · {question.title} · {question.target_level}</strong><p>{question.prompt}</p><pre>{question.reference}</pre></div>)}
            <p>JSON 导出另含各轮判定与进度记录。模型达标判断需结合学生原回答复核。</p></details>}
          <details className="config-details"><summary>查看登记时的提示词与模型（保持不变）</summary><p>{detail.config.settings.model} · 登记时协议：{detail.config.settings.protocol}</p><pre>{detail.config.settings.system_prompt}</pre></details>
          <div className="record-messages">{detail.messages.map(message => <div key={message.id} className={"record-message " + message.role}><div><strong>{message.role === "user" ? "被试" : "AI 助手"}</strong><span>{formatDate(message.created_at)} · {message.status === "complete" ? "已保存" : "未完成"}</span></div><Markdown>{(message.role === "assistant" && detail.question_progress ? questionMessageFeedback(message.content) : message.content) || "（未返回文本）"}</Markdown></div>)}</div>
          <div className="export-note">导出包含历史消息、登记配置及读取详情时的当前连接，不包含密钥；不把当前连接当作历史请求审计。请按研究数据管理要求保管。</div>
        </> : <div className="empty-state"><LoaderCircle size={24} className="spin"/></div>}
      </section>
    </dialog>
    <ConversationDeleteDialog dialogRef={deleteDialog} conversation={deleteTarget} mode={mode} confirmation={deleteConfirmation}
      deleting={deleting} error={deleteError} onConfirmation={setDeleteConfirmation} onConfirm={() => void confirmDeleteConversation()} onClose={closeDeleteDialog}/>
  </div>;
}
