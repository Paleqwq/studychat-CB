"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, FileText, GraduationCap, KeyRound, LoaderCircle, LogOut, MessagesSquare, RefreshCw, Save, Settings2, ShieldCheck } from "lucide-react";
import { authFetch, browserClient, browserAuthFailure, responseJson } from "@/lib/browser";
import { dataBackend } from "@/lib/backend";
import { demoEnglishConfig, englishSettingsSchema, saveDemoEnglishConfig, type EnglishAdminConfiguration } from "@/lib/english-settings";
import { demoEnglishCounts, demoEnglishRecord, demoEnglishRecords } from "@/lib/english-demo";
import { deleteDemoEnglishConversation } from "@/lib/english-demo";
import { type EnglishCurriculum } from "@/lib/english-assistant";
import type { EnglishConversationDetail, EnglishGroupCounts, EnglishResearchConversation } from "@/lib/english-groups";
import type { RuntimeMode } from "@/lib/types";
import { DemoBanner } from "./shared";
import { EnglishPromptSettings, EnglishRecordDetail, EnglishRecordsView, EnglishSettingsView } from "./english-admin-views";
import { EnglishCurriculumEditor } from "./english-curriculum-editor";
import { EnglishDeleteDialog } from "./english-delete-dialog";

type Section = "settings" | "prompt" | "curriculum" | "records";
const nav = [
  { id: "settings", label: "课程设置", icon: Settings2 },
  { id: "prompt", label: "提示词配置", icon: FileText },
  { id: "curriculum", label: "BOPPPS 流程配置", icon: BookOpen },
  { id: "records", label: "英语分组与记录", icon: MessagesSquare }
] as const;
type RecordsResponse = { conversations: EnglishResearchConversation[]; total: number; offset: number; counts: EnglishGroupCounts };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
function EnglishAdminBrand() {
  return <div className="brand"><span className="brand-mark"><GraduationCap size={24} aria-hidden="true"/></span><span>英语助教管理</span></div>;
}

export function EnglishAdminNavigation({ section, onSection }: { section: Section; onSection: (section: Section) => void }) {
  return <nav aria-label="英语助教管理导航">{nav.map(item => <button key={item.id} type="button" className={"admin-nav " + (section === item.id ? "active" : "")}
    aria-current={section === item.id ? "page" : undefined} onClick={() => onSection(item.id)}>
    <item.icon size={18}/>{item.label}{section === item.id && <ChevronRight size={14}/>}</button>)}
    <a className="admin-nav" href="/admin"><ArrowLeft size={18}/>共享模型配置<ArrowUpRight size={14}/></a>
    <a className="admin-nav" href="/english-assistant"><BookOpen size={18}/>进入英语助教<ArrowUpRight size={14}/></a>
  </nav>;
}

export function EnglishAdminPanel({ mode }: { mode: RuntimeMode }) {
  const [section, setSection] = useState<Section>("settings");
  const [config, setConfig] = useState<EnglishAdminConfiguration | null>(null);
  const [authenticated, setAuthenticated] = useState(mode === "demo");
  const [initializing, setInitializing] = useState(true);
  const [canRetry, setCanRetry] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingConnection, setRefreshingConnection] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [records, setRecords] = useState<EnglishResearchConversation[]>([]);
  const [counts, setCounts] = useState<EnglishGroupCounts | null>(null);
  const [studentFilter, setStudentFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [detail, setDetail] = useState<EnglishConversationDetail | null>(null);
  const [detailTarget, setDetailTarget] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<EnglishResearchConversation | null>(null);
  const [deleteMessageCount, setDeleteMessageCount] = useState<number | null>(null);
  const [deleteDetailsLoading, setDeleteDetailsLoading] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const recordDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteDetailsRequest = useRef(0);
  const deletePending = useRef(false);

  async function readConfiguration() {
    if (mode === "demo") return demoEnglishConfig();
    const response = await authFetch("/api/admin/english-assistant-settings", "admin");
    if (response.status === 401 || response.status === 403) setCanRetry(false);
    return responseJson<EnglishAdminConfiguration>(response);
  }
  async function loadConfiguration() {
    const next = await readConfiguration();
    setConfig(next); setDirty(false); setAuthenticated(true); setCanRetry(false);
  }
  async function restoreSession() {
    const { data, error: sessionError } = await browserClient("admin").auth.getSession();
    if (sessionError) throw new Error(browserAuthFailure(sessionError).message);
    setCanRetry(Boolean(data.session));
    if (data.session) await loadConfiguration();
    return Boolean(data.session);
  }
  async function retryConnection() {
    setSaving(true); setError("");
    try {
      if (mode === "demo") await loadConfiguration();
      else if (!await restoreSession()) setError("请先登录管理员账号。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法连接，请稍后重试。"); }
    finally { setSaving(false); }
  }
  async function refreshSharedConnection() {
    setRefreshingConnection(true); setError("");
    try {
      const next = await readConfiguration();
      setConfig(current => current ? { ...current, settings: { ...next.settings, disclosure: current.settings.disclosure },
        has_api_key: next.has_api_key, shared_experiment_revision: next.shared_experiment_revision } : next);
      setNotice("共享 DeepSeek 模型状态已刷新，英语提示词草稿已保留。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取共享模型状态，请重试。"); }
    finally { setRefreshingConnection(false); }
  }
  async function loadRecords(nextOffset = 0): Promise<boolean> {
    const request = ++listRequest.current;
    setRecordsLoading(true); setError("");
    try {
      let data: RecordsResponse;
      if (mode === "demo") {
        const all = demoEnglishRecords().filter(record =>
          (!studentFilter.trim() || record.student_id === studentFilter.trim().toUpperCase()) &&
          (!groupFilter || (groupFilter === "legacy" ? !record.group_code : record.group_code === groupFilter)));
        data = { conversations: all.slice(nextOffset, nextOffset + 50), total: all.length, offset: nextOffset, counts: demoEnglishCounts() };
      } else {
        const query = new URLSearchParams({ offset: String(nextOffset), student_id: studentFilter.trim(), group: groupFilter });
        data = await responseJson<RecordsResponse>(await authFetch("/api/admin/english-assistant-conversations?" + query, "admin"));
      }
      if (request !== listRequest.current) return false;
      const lastOffset = Math.max(0, Math.floor(Math.max(0, data.total - 1) / 50) * 50);
      if (data.offset > lastOffset) return await loadRecords(lastOffset);
      setRecords(data.conversations); setTotal(data.total); setOffset(data.offset); setCounts(data.counts);
      return true;
    } catch (cause) { if (request === listRequest.current) setError(cause instanceof Error ? cause.message : "英语记录读取失败，请重试查询。"); return false; }
    finally { if (request === listRequest.current) setRecordsLoading(false); }
  }

  useEffect(() => {
    async function initialize() {
      try { if (mode === "demo") await loadConfiguration(); else await restoreSession(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "无法连接英语助教管理页。"); }
      finally { setInitializing(false); }
    }
    void initialize();
    return () => { listRequest.current++; detailRequest.current++; deleteDetailsRequest.current++; };
    // Session restoration only runs once; editing must not reload a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (authenticated && (section === "settings" || section === "records")) void loadRecords();
    // Filters are applied on explicit query, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, authenticated]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    if (detailTarget && !recordDialog.current?.open) recordDialog.current?.showModal();
    else if (!detailTarget) recordDialog.current?.close();
  }, [detailTarget]);
  useEffect(() => {
    if (deleteTarget && !deleteDialog.current?.open) deleteDialog.current?.showModal();
    else if (!deleteTarget) deleteDialog.current?.close();
  }, [deleteTarget]);

  function edit<K extends "enabled" | "base_prompt" | "personality_prompt">(key: K, value: EnglishAdminConfiguration[K]) {
    setConfig(current => current ? { ...current, [key]: value } : current);
    setDirty(true); setNotice("");
  }
  function editDisclosure(value: string) {
    setConfig(current => current ? { ...current, settings: { ...current.settings, disclosure: value } } : current);
    setDirty(true); setNotice("");
  }
  function editCurriculum(curriculum: EnglishCurriculum) {
    setConfig(current => current ? { ...current, curriculum } : current);
    setDirty(true); setNotice("");
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const { error: loginError } = await browserClient("admin").auth.signInWithPassword({ email, password });
      if (loginError) throw new Error(browserAuthFailure(loginError, "login").message);
      setPassword(""); setCanRetry(true); await loadConfiguration();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法登录。"); }
    finally { setSaving(false); }
  }
  async function logout() {
    setSaving(true); setError("");
    try {
      const { error: logoutError } = await browserClient("admin").auth.signOut();
      if (logoutError) throw new Error(browserAuthFailure(logoutError).message);
      listRequest.current++; detailRequest.current++;
      deleteDetailsRequest.current++;
      setAuthenticated(false); setConfig(null); setDirty(false); setCanRetry(false); setNotice("");
      setDetailTarget(null); setDetail(null); setRecords([]); setCounts(null);
      setDeleteTarget(null); setDeleteConfirmation(""); setDeleteError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "退出失败，请重试。"); }
    finally { setSaving(false); }
  }
  async function publish() {
    if (!config || saving) return;
    setError(""); setNotice(""); setSaving(true);
    try {
      const parsed = englishSettingsSchema.safeParse({ enabled: config.enabled, disclosure: config.settings.disclosure,
        base_prompt: config.base_prompt, personality_prompt: config.personality_prompt, curriculum: config.curriculum,
        expected_revision: config.revision });
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        if (field === "curriculum") {
          setSection("curriculum"); throw new Error("请完整填写六阶段的说明、活动任务和达标条件，并检查活动数量及词数范围。");
        }
        if (field === "base_prompt" || field === "personality_prompt") {
          setSection("prompt"); throw new Error("请填写 1–10000 字的基础教学提示词与人格提示词。");
        }
        setSection("settings"); throw new Error("请填写 1–2000 字的英语课程登记说明，并检查课程状态。");
      }
      let next: EnglishAdminConfiguration;
      if (mode === "demo") {
        next = { ...config, id: crypto.randomUUID(), revision: config.revision + 1, created_at: new Date().toISOString() };
        saveDemoEnglishConfig(next); next = demoEnglishConfig();
      } else {
        next = await responseJson<EnglishAdminConfiguration>(await authFetch("/api/admin/english-assistant-settings", "admin", {
          method: "PUT", body: JSON.stringify(parsed.data)
        }));
      }
      setConfig(next); setDirty(false);
      setNotice("英语提示词配置 v" + next.revision + " 已" + (mode === "demo" ? "保存到本浏览器" : "发布") +
        "。新登记使用此版本的 BOPPPS 内容，原分组与课程快照保留。课程已" + (next.enabled ? "启用。" : "暂停。"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发布失败，请重试。"); }
    finally { setSaving(false); }
  }
  async function openRecord(id: string) {
    const request = ++detailRequest.current;
    setDetailTarget(id); setDetail(null); setDetailLoading(true); setDetailError("");
    try {
      const next = mode === "demo" ? demoEnglishRecord(id) :
        await responseJson<EnglishConversationDetail>(await authFetch("/api/admin/english-assistant-conversations?id=" + encodeURIComponent(id), "admin"));
      if (!next) throw new Error("此英语会话未找到，请刷新记录后重试。");
      if (request === detailRequest.current) setDetail(next);
    } catch (cause) { if (request === detailRequest.current) setDetailError(cause instanceof Error ? cause.message : "读取英语详情失败。"); }
    finally { if (request === detailRequest.current) setDetailLoading(false); }
  }
  function closeDetail() {
    detailRequest.current++; setDetailTarget(null); setDetail(null); setDetailLoading(false); setDetailError("");
  }
  async function readDeleteDetails(target: EnglishResearchConversation) {
    const request = ++deleteDetailsRequest.current;
    setDeleteMessageCount(null); setDeleteDetailsLoading(true); setDeleteError("");
    try {
      const next = mode === "demo" ? demoEnglishRecord(target.id) :
        await responseJson<EnglishConversationDetail>(await authFetch("/api/admin/english-assistant-conversations?id=" + encodeURIComponent(target.id), "admin"));
      if (!next) throw new Error("此英语会话未找到，请刷新记录。");
      if (request === deleteDetailsRequest.current) { setDeleteTarget(next.conversation); setDeleteMessageCount(next.messages.length); }
    } catch (cause) { if (request === deleteDetailsRequest.current) setDeleteError(cause instanceof Error ? cause.message : "无法读取目标消息数量，请重试。"); }
    finally { if (request === deleteDetailsRequest.current) setDeleteDetailsLoading(false); }
  }
  function requestDeleteConversation(target: EnglishResearchConversation) {
    if (deletePending.current) return;
    setDeleteTarget(target); setDeleteConfirmation(""); setDeleteError(""); setNotice("");
    if (detail?.conversation.id === target.id) {
      deleteDetailsRequest.current++; setDeleteMessageCount(detail.messages.length); setDeleteDetailsLoading(false);
    } else void readDeleteDetails(target);
  }
  function closeDeleteDialog() {
    if (deletePending.current) return;
    deleteDetailsRequest.current++; setDeleteTarget(null); setDeleteMessageCount(null); setDeleteDetailsLoading(false);
    setDeleteConfirmation(""); setDeleteError("");
  }
  async function confirmDeleteConversation() {
    if (!deleteTarget || deletePending.current || deleteDetailsLoading || deleteMessageCount === null || deleteConfirmation !== deleteTarget.student_id) return;
    const target = deleteTarget;
    deletePending.current = true; setDeleting(true); setDeleteError(""); setNotice("");
    try {
      if (mode === "demo") deleteDemoEnglishConversation(target.id);
      else await responseJson<{ deleted: boolean }>(await authFetch("/api/admin/english-assistant-conversations", "admin", {
        method: "DELETE", body: JSON.stringify({ conversation_id: target.id })
      }));
      if (detail?.conversation.id === target.id) closeDetail();
      setDeleteTarget(null); setDeleteConfirmation(""); setDeleteMessageCount(null);
      setRecords(current => current.filter(record => record.id !== target.id));
      const nextTotal = Math.max(0, total - 1); setTotal(nextTotal);
      const lastOffset = Math.max(0, Math.floor(Math.max(0, nextTotal - 1) / 50) * 50);
      const refreshed = await loadRecords(Math.min(offset, lastOffset));
      setNotice(refreshed ? "英语会话、消息和学习进度已永久删除，登记已释放，英语分组人数已更新。" :
        "英语会话已删除，列表和分组人数刷新失败，请重新查询。");
    } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : "删除失败，请核实后重试。"); }
    finally { deletePending.current = false; setDeleting(false); }
  }
  function exportDetail() {
    if (!detail) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), mode, ...detail,
      config: detail.config.id === null ? null : detail.config }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = "english-assistant-" + detail.conversation.participant_code + ".json";
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (initializing) return <div className="initializing"><LoaderCircle className="spin" size={24}/><span>正在连接英语助教管理页…</span></div>;
  if (!authenticated) return <div className="login-shell"><EnglishAdminBrand/><main className="login-card">
    <div className="login-icon"><ShieldCheck size={29}/></div><h1>登录英语助教管理</h1>
    <p className="muted">管理英语教学提示词、独立分组与课程记录。</p>
    <form onSubmit={login}>
      <Field label={dataBackend() === "cloudbase" ? "管理员账号（用户名或邮箱）" : "管理员邮箱"}><input type={dataBackend() === "cloudbase" ? "text" : "email"} value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required/></Field>
      <Field label="密码"><input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required/></Field>
      {error && <div className="error-box" role="alert">{error}</div>}
      <button className="button primary full-width" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17}/> : <>登录<ArrowRight size={17}/></>}</button>
      {canRetry && <button type="button" className="button secondary full-width login-retry" disabled={saving} onClick={() => void retryConnection()}><RefreshCw size={17}/>使用已有登录重试</button>}
    </form><p className="login-footnote"><KeyRound size={13}/>仅限管理员访问</p>
    <p className="small-note"><a className="text-link" href="/english-assistant"><ArrowLeft size={14}/>返回英语助教</a></p>
  </main></div>;
  if (!config) return <div className="setup-shell"><EnglishAdminBrand/><div className="setup-card">
    <h1>暂时无法读取英语配置</h1><p role="alert">{error || "请稍后重试。"}</p>
    <button className="button secondary" disabled={saving} onClick={() => void retryConnection()}><RefreshCw size={16}/>重试连接</button>
  </div></div>;

  const active = nav.find(item => item.id === section)!;
  return <div className="app-frame admin-frame english-admin">
    {mode === "demo" && <DemoBanner/>}
    <div className="admin-layout">
      <aside className="admin-sidebar"><EnglishAdminBrand/>
        <div className="workspace-label"><span className="workspace-icon"><GraduationCap size={16}/></span><span>英语教学工作区</span></div>
        <div className="sidebar-section-label">英语课程管理</div>
        <EnglishAdminNavigation section={section} onSection={value => { setSection(value); setNotice(""); }}/>
        <div className="admin-sidebar-note"><ShieldCheck size={16}/><p>英语独立分组与记录，<br/>两组共用 DeepSeek。</p></div>
        <div className="admin-account"><span className="account-avatar">英</span><span>英语课程管理员<small>{mode === "demo" ? "本地英语演示" : "管理员权限已验证"}</small></span>
          {mode !== "demo" && <button type="button" className="icon-button" aria-label="退出管理员登录" disabled={saving} onClick={() => void logout()}><LogOut size={16}/></button>}
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header"><div className="breadcrumb">英语教学<ChevronRight size={13}/><strong>{active.label}</strong></div>
          <a className="button small secondary" href="/english-assistant">打开英语助教<ArrowUpRight size={15}/></a>
        </header>
        <div className="admin-content">
          <div className="admin-page-heading"><div><h1>{section === "settings" ? "英语课程设置" : section === "prompt" ? "英语提示词配置" : section === "curriculum" ? "BOPPPS 流程配置" : "英语分组与记录"}</h1>
            <p>{section === "records" ? "查看英语独立登记、课程进度和学生作答。" : "共享 DeepSeek 模型，独立发布英语教学提示词与课程状态。"}</p></div>
            {section !== "records" && <div className="publish-group"><span className={dirty ? "unsaved-label" : "saved-label"}>{dirty ? "有未发布修改" : "英语配置 v" + config.revision}</span>
              <button type="button" className="button primary" disabled={saving} onClick={() => void publish()}>{saving ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>}保存并发布</button>
            </div>}
          </div>
          {error && <div className="error-box" role="alert"><CircleAlert size={17}/>{error}</div>}
          {notice && <div className="success-box" role="status"><Check size={17}/>{notice}</div>}
          {section === "settings" && <EnglishSettingsView config={config} counts={counts} mode={mode} disabled={saving} refreshing={refreshingConnection}
            onEnabled={value => edit("enabled", value)} onDisclosure={editDisclosure} onRefreshConnection={() => void refreshSharedConnection()}/>}
          {section === "prompt" && <EnglishPromptSettings config={config} disabled={saving}
            onBasePrompt={value => edit("base_prompt", value)} onPersonalityPrompt={value => edit("personality_prompt", value)}/>}
          {section === "curriculum" && <EnglishCurriculumEditor value={config.curriculum} disabled={saving} onChange={editCurriculum}/>}
          {section === "records" && <EnglishRecordsView records={records} counts={counts} total={total} offset={offset} loading={recordsLoading}
            studentFilter={studentFilter} groupFilter={groupFilter} onStudentFilter={setStudentFilter} onGroupFilter={setGroupFilter}
            onQuery={nextOffset => void loadRecords(nextOffset)} onOpen={id => void openRecord(id)} onDelete={requestDeleteConversation} deleting={deleting}/>}
        </div>
      </main>
    </div>
    <dialog ref={recordDialog} className="drawer-dialog english-admin-detail-dialog" aria-label="英语会话详情" onClose={closeDetail}
      onClick={event => { if (event.target === event.currentTarget) closeDetail(); }}>
      <EnglishRecordDetail detail={detail} loading={detailLoading} error={detailError} onClose={closeDetail}
        onRetry={() => { if (detailTarget) void openRecord(detailTarget); }} onExport={exportDetail}
        onDelete={() => { if (detail) requestDeleteConversation(detail.conversation); }} deleting={deleting}/>
    </dialog>
    <EnglishDeleteDialog dialogRef={deleteDialog} conversation={deleteTarget} messageCount={deleteMessageCount} loading={deleteDetailsLoading}
      mode={mode} confirmation={deleteConfirmation} deleting={deleting} error={deleteError} onConfirmation={setDeleteConfirmation}
      onConfirm={() => void confirmDeleteConversation()} onClose={closeDeleteDialog} onRetryDetails={() => { if (deleteTarget) void readDeleteDetails(deleteTarget); }}/>
  </div>;
}
