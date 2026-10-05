"use client";
import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import Link from "next/link";
import { ArrowUp, BookOpen, Check, ChevronRight, CircleHelp, FlaskConical, LoaderCircle, LockKeyhole, PanelLeft, Pause, Play, RefreshCw, SquarePen, X } from "lucide-react";
import { authFetch, browserClient, browserAuthFailure, hasLegacySupabaseSession, responseJson } from "@/lib/browser";
import { dataBackend } from "@/lib/backend";
import { demoConfig, demoReply, demoSession, saveDemoSession, demoQuestionReply } from "@/lib/demo";
import { demoEnglishReply, demoEnglishSession, isDemoEnglishSessionStateConflict, isDemoEnglishSessionUnavailable, saveDemoEnglishSession, setDemoEnglishLearningPause } from "@/lib/english-demo";
import { englishPublicSettings } from "@/lib/english-assistant";
import { demoEnglishConfig } from "@/lib/english-settings";
import { parseSse } from "@/lib/sse";
import { type PublicSettings, type ChatEvent, type ChatMessage, type RuntimeMode, type SessionPayload } from "@/lib/types";
import { participantSettings, participantMessageContent } from "@/lib/participant-presentation";
import { registrationSchema } from "@/lib/validation";
import { conversationTitle, openedConversationsKey, readOpenedConversations, rememberOpenedConversation, type OpenedConversation } from "@/lib/opened-conversations";
import { ChatMark, DemoBanner } from "./shared";
import { Markdown } from "./markdown";
import { QuestionProgress } from "./question-progress";
import { EnglishProgress } from "./english-progress";
import { ConversationHistory } from "./conversation-history";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string;
      remove: (id: string) => void;
    };
  }
}

type EnglishPauseRequest = { conversation_id: string; turn_id: string; content: string; english_version: number; paused: boolean };
type EnglishPauseResult = { user: ChatMessage; assistant: ChatMessage; english_progress: NonNullable<SessionPayload["english_progress"]>; english_paused: boolean };

export function ParticipantChat({ mode, requireCode, initialSettings, assistantMode = "general" }: { mode: RuntimeMode; requireCode: boolean; initialSettings: PublicSettings; assistantMode?: "general" | "english" }) {
  const english = assistantMode === "english";
  const identity = english ? "english-participant" : "participant";
  const accessCodeKey = english ? "studychat.english-assistant.access-code" : "studychat.access-code";
  const sessionPath = english ? "/api/english-assistant/session" : "/api/session";
  const chatPath = english ? "/api/english-assistant/chat" : "/api/chat";
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState(false);
  const [code, setCode] = useState("");
  const [studentId, setStudentId] = useState("");
  const [entrySettings, setEntrySettings] = useState(initialSettings);
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReady, setCaptchaReady] = useState(false);
  const [help, setHelp] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [legacyIdentity, setLegacyIdentity] = useState(false);
  const [newConversation, setNewConversation] = useState(false);
  const [openedConversations, setOpenedConversations] = useState<OpenedConversation[]>([]);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const captchaContainer = useRef<HTMLDivElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const mobileDialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const sessionRef = useRef<SessionPayload | null>(null);
  const inFlight = useRef(false);
  const pauseRequest = useRef<EnglishPauseRequest | null>(null);
  const newConversationDialog = useRef<HTMLDialogElement>(null);
  const siteKey = mode === "live" && dataBackend() === "supabase" ? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY : undefined;
  const visibleSettings = session?.settings ?? entrySettings;
  const settings = english ? englishPublicSettings(visibleSettings.disclosure) : participantSettings(visibleSettings);
  const messages = session?.messages ?? [];
  const failed = messages.findLast(m => m.role === "assistant" && m.status !== "complete");
  const questionCompleted = session?.question_progress?.phase === "completed";
  const conversationCompleted = english ? session?.english_progress?.completed === true : questionCompleted;
  const englishPaused = english && session?.english_paused === true;

  function clearPauseRequest() { pauseRequest.current = null; setPausePending(false); }

  function update(next: SessionPayload) {
    // A stale English tab must not publish a state rejected by the demo store.
    if (mode === "demo" && english) saveDemoEnglishSession(next);
    sessionRef.current = next;
    setSession(next);
    if (pauseRequest.current && (pauseRequest.current.conversation_id !== next.conversation.id ||
      next.messages.some(message => message.turn_id === pauseRequest.current?.turn_id && message.role === "assistant" && message.status === "complete"))) clearPauseRequest();
    if (mode === "demo" && !english) saveDemoSession(next);
  }
  function recoverEnglishDemoSession(stateConflict = false) {
    setInput(""); setSaved(false);
    try {
      const current = demoEnglishSession();
      sessionRef.current = current; setSession(current); setEntry(!current);
      clearPauseRequest();
      if (current) setError(stateConflict ? "英语学习状态已在另一页面更新，已恢复最新题目、进度和暂停状态。" : "原英语会话已删除或无法恢复，已读取本浏览器当前英语会话，请核对学号后继续。");
      else setError("英语会话已删除或无法恢复，请核对学号后重新登记。");
    } catch {
      sessionRef.current = null; setSession(null); setEntry(true);
      clearPauseRequest();
      setError("英语会话暂时无法恢复，请刷新页面后重新登记。");
    }
  }
  async function boot(accessCode = code, captcha = captchaToken, register = false) {
    setLoading(true); setError("");
    try {
      const registration = register ? registrationSchema.safeParse({ student_id: studentId }) : null;
      if (registration && !registration.success) throw new Error("请填写 1–32 位数字或字母学号，可含短横线和下划线。");
      const data = mode === "demo" ? (english ? demoEnglishSession(registration?.data?.student_id) : demoSession(registration?.data?.student_id)) :
        await responseJson<SessionPayload | { registration_required: true; settings: PublicSettings }>(await authFetch(sessionPath, identity,
          register ? { method: "POST", body: JSON.stringify(registration?.data) } : {}, { code: accessCode, captchaToken: captcha }));
      if (!data || "registration_required" in data) {
        if (data) setEntrySettings(data.settings);
        if (mode === "demo" && english) { sessionRef.current = null; setSession(null); setSaved(false); }
        setEntry(true); return;
      }
      update(data);
      setEntry(false);
      setSaved(data.messages.length > 0 && data.messages.every(m => m.status === "complete"));
      if (accessCode) sessionStorage.setItem(accessCodeKey, accessCode);
    } catch (e) {
      if (mode === "demo" && english && isDemoEnglishSessionUnavailable(e)) recoverEnglishDemoSession();
      else {
        setError(e instanceof Error ? e.message : "连接失败，请重试。");
        if (!sessionRef.current) setEntry(true);
      }
    } finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    async function init() {
      const savedCode = sessionStorage.getItem(accessCodeKey) ?? "";
      setCode(savedCode);
      if (mode === "demo") { setEntrySettings(english ? englishPublicSettings(demoEnglishConfig().settings.disclosure) : participantSettings(demoConfig())); await boot(); return; }
      setLegacyIdentity(hasLegacySupabaseSession(identity));
      const { data, error: sessionError } = await browserClient(identity).auth.getSession();
      if (!active) return;
      if (sessionError) setError(browserAuthFailure(sessionError).message);
      if ((requireCode && !savedCode) || !data.session) {
          setEntry(true); setLoading(false);
      } else await boot(savedCode);
    }
    void init().catch(() => { if (active) { setLoading(false); setError("初始化失败，请刷新页面重试。"); } });
    return () => { active = false; abort.current?.abort(); };
    // Initialization intentionally runs once; form state must not create extra sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setOpenedConversations(rememberOpenedConversation(mode, assistantMode, session ? conversationTitle(assistantMode, session) : undefined));
  }, [mode, assistantMode, session?.conversation.title, session?.messages.length]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === openedConversationsKey(mode) || event.key === null) setOpenedConversations(readOpenedConversations(mode));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [mode]);
  useEffect(() => {
    if (!entry || !siteKey || !captchaReady || !captchaContainer.current || !window.turnstile) return;
    const id = window.turnstile.render(captchaContainer.current, {
      sitekey: siteKey, callback: setCaptchaToken,
      "expired-callback": () => setCaptchaToken(""),
      "error-callback": () => { setCaptchaToken(""); setError("安全验证加载失败，请检查网络后刷新页面。"); }
    });
    return () => window.turnstile?.remove(id);
  }, [entry, siteKey, captchaReady]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: busy ? "instant" : "smooth", block: "end" }); }, [messages, busy]);
  useEffect(() => {
    if (textArea.current) {
      textArea.current.style.height = "auto";
      textArea.current.style.height = Math.min(textArea.current.scrollHeight, 170) + "px";
    }
  }, [input]);
  useEffect(() => {
    if (help) helpDialog.current?.showModal();
    else helpDialog.current?.close();
  }, [help]);
  useEffect(() => {
    if (mobileNav) mobileDialog.current?.showModal();
    else mobileDialog.current?.close();
  }, [mobileNav]);
  useEffect(() => {
    if (newConversation) newConversationDialog.current?.showModal();
    else newConversationDialog.current?.close();
  }, [newConversation]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const onResize = () => { if (query.matches) setMobileNav(false); };
    query.addEventListener("change", onResize);
    return () => query.removeEventListener("change", onResize);
  }, []);

  function applyEvent(event: ChatEvent, local: SessionPayload) {
    if (event.type === "accepted") {
      local.messages = local.messages.filter(m => m.turn_id !== event.user.turn_id).concat(event.user, event.assistant);
      local.conversation.title = english ? "英语助教" : local.conversation.title === "尚未开始对话" ? event.user.content.slice(0, 60) : local.conversation.title;
    } else if (event.type === "delta") {
      local.messages = local.messages.map((m, i) => i === local.messages.length - 1 ? { ...m, content: m.content + event.text } : m);
    } else if (event.type === "done") {
      local.messages = local.messages.map(m => m.id === event.message.id ? event.message : m);
      if (!english && event.question_progress) local.question_progress = event.question_progress;
      if (english && event.english_progress) local.english_progress = event.english_progress;
      if (english && event.english_paused !== undefined) local.english_paused = event.english_paused;
      local.conversation.updated_at = new Date().toISOString();
      setSaved(true);
    } else throw new Error(event.message);
    update({ ...local, messages: [...local.messages] });
  }
  async function send(retry = false) {
    if (!sessionRef.current || inFlight.current) return;
    if (english && (sessionRef.current.english_paused || sessionRef.current.enabled === false || pauseRequest.current)) return;
    if (english ? sessionRef.current.english_progress?.completed : sessionRef.current.question_progress?.phase === "completed") return;
    const previousUser = failed && messages.find(m => m.turn_id === failed.turn_id && m.role === "user");
    const text = retry ? previousUser?.content ?? "" : input.trim();
    if (!text) return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const turnId = retry && failed ? failed.turn_id : crypto.randomUUID();
    const local: SessionPayload = structuredClone(sessionRef.current);
    if (!retry) setInput("");
    const controller = new AbortController();
    abort.current = controller;
    let accepted = false;
    let complete = false;
    let englishDemoLease = false;
    try {
      if (mode === "demo") {
        if (english ? !demoEnglishConfig().enabled : !demoConfig().enabled) throw new Error("本次对话已暂停，请联系管理员。");
        const now = new Date().toISOString();
        const user: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, turn_id: turnId, status: "complete", created_at: now };
        const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", turn_id: turnId, status: "pending", created_at: now };
        if (english) {
          local.conversation.locked_until = new Date(Date.now() + 150000).toISOString();
          englishDemoLease = true;
        }
        applyEvent({ type: "accepted", user, assistant }, local); accepted = true;
        const englishTurn = english ? demoEnglishReply(local) : null;
        const questionTurn = english ? null : demoQuestionReply(local);
        const reply = englishTurn?.content ?? questionTurn?.content ?? demoReply(text);
        for (let i = 0; !englishTurn?.english_paused && i < reply.length; i += 5) {
          if (controller.signal.aborted) throw new Error("演示回复已中断。");
          await new Promise(resolve => setTimeout(resolve, 22));
          applyEvent({ type: "delta", text: reply.slice(i, i + 5) }, local);
        }
        if (english) local.conversation.locked_until = null;
        applyEvent({ type: "done", message: { ...assistant, content: reply, status: "complete" },
          ...(englishTurn ? { english_progress: englishTurn.english_progress, english_paused: englishTurn.english_paused } : {}),
          ...(questionTurn ? { question_progress: questionTurn.question_progress } : {}) }, local);
        complete = true;
        englishDemoLease = false;
      } else {
        const response = await authFetch(chatPath, identity, {
          method: "POST", signal: controller.signal,
          body: JSON.stringify({ conversation_id: local.conversation.id, turn_id: turnId, content: text,
            ...(english && local.english_progress ? { english_version: local.english_progress.version } :
              !english && local.question_progress ? { question_version: local.question_progress.version } : {}) })
        }, { code });
        if (!response.ok) await responseJson(response);
        if (!response.body) throw new Error("未收到回复，请重试。");
        for await (const data of parseSse(response.body)) {
          const event = JSON.parse(data) as ChatEvent;
          if (event.type === "accepted") accepted = true;
          if (event.type === "done") complete = true;
          applyEvent(event, local);
        }
        if (!complete) throw new Error("连接中断，请点击重试以恢复本条回复。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败，请重试。");
      if (mode === "demo" && english) local.conversation.locked_until = null;
      if (mode === "demo" && english && (isDemoEnglishSessionUnavailable(e) || isDemoEnglishSessionStateConflict(e))) {
        englishDemoLease = false;
        recoverEnglishDemoSession(isDemoEnglishSessionStateConflict(e));
      } else if (accepted) {
        local.messages = local.messages.map(m => m.turn_id === turnId && m.role === "assistant" ? { ...m, status: "failed" } : m);
        try { update(local); englishDemoLease = false; }
        catch (saveError) {
          if (mode === "demo" && english && (isDemoEnglishSessionUnavailable(saveError) || isDemoEnglishSessionStateConflict(saveError))) {
            englishDemoLease = false;
            recoverEnglishDemoSession(isDemoEnglishSessionStateConflict(saveError));
          }
          else setError("回复未完成且暂时无法保存，请刷新页面恢复会话后重试。");
        }
      } else if (!retry) {
        // The request may have reached the server before transport failure. Recover
        // authoritative history before letting a new turn create a duplicate.
        setInput(text);
        if (mode === "live") {
          try {
            const recovered = await responseJson<SessionPayload>(await authFetch(sessionPath, identity, {}, { code }));
            update(recovered);
            if (recovered.messages.some(m => m.turn_id === turnId)) setInput("");
          } catch { setError("暂时无法确认保存状态，请刷新后再发送，避免重复记录。"); setEntry(true); }
        }
      }
    } finally {
      if (englishDemoLease && sessionRef.current?.conversation.id === local.conversation.id) {
        local.conversation.locked_until = null;
        try { update(local); }
        catch (saveError) {
          if (isDemoEnglishSessionUnavailable(saveError) || isDemoEnglishSessionStateConflict(saveError)) recoverEnglishDemoSession(isDemoEnglishSessionStateConflict(saveError));
          else setError("暂时无法保存英语会话状态，请刷新页面后重试。");
        }
      }
      inFlight.current = false; setBusy(false); abort.current = null; textArea.current?.focus();
    }
  }

  function focusConversation() {
    setMobileNav(false);
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    textArea.current?.focus();
  }

  async function changeEnglishPause(paused: boolean) {
    const current = sessionRef.current;
    if (!english || !current?.english_progress || current.english_progress.completed || inFlight.current) return;
    // Keep the original request after an uncertain response so retries remain
    // idempotent even when the server committed before the connection failed.
    const request = pauseRequest.current?.conversation_id === current.conversation.id && pauseRequest.current.paused === paused
      ? pauseRequest.current : { conversation_id: current.conversation.id, turn_id: crypto.randomUUID(),
        content: paused ? "暂停学习" : "继续学习", english_version: current.english_progress.version, paused };
    pauseRequest.current = request; setPausePending(true);
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const controller = new AbortController(); abort.current = controller;
    let completed = false;
    let rejected = false;
    try {
      if (mode === "demo") {
        setDemoEnglishLearningPause(current, paused, request.content, request.turn_id);
        const restored = demoEnglishSession();
        if (!restored) throw new Error("英语会话已删除或无法恢复，请重新登记。");
        update(restored); completed = true;
      } else {
        const response = await authFetch("/api/english-assistant/pause", identity,
          { method: "POST", body: JSON.stringify(request), signal: controller.signal }, { code });
        // Explicit client rejections did not commit this control. Timeouts and
        // server failures can still hide a committed operation.
        rejected = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 499;
        const result = await responseJson<EnglishPauseResult>(response);
        const local = structuredClone(sessionRef.current ?? current);
        applyEvent({ type: "accepted", user: result.user, assistant: result.assistant }, local);
        applyEvent({ type: "done", message: result.assistant, english_progress: result.english_progress, english_paused: result.english_paused }, local);
        completed = true;
        const restored = await responseJson<SessionPayload>(await authFetch(sessionPath, identity, {}, { code }));
        update(restored);
      }
      clearPauseRequest(); setSaved(true);
    } catch (e) {
      if (completed) {
        clearPauseRequest(); setSaved(true);
        setError("学习状态已保存，暂时无法刷新记录，请稍后刷新页面。");
      } else if (mode === "demo") {
        if (isDemoEnglishSessionUnavailable(e) || isDemoEnglishSessionStateConflict(e)) recoverEnglishDemoSession(isDemoEnglishSessionStateConflict(e));
        else setError(e instanceof Error ? e.message : "学习状态保存失败，请重试。");
      } else {
        setError(e instanceof Error ? e.message : "学习状态保存失败，请重试。");
        try {
          const restored = await responseJson<SessionPayload>(await authFetch(sessionPath, identity, {}, { code }));
          update(restored);
          if (rejected && !restored.messages.some(message => message.turn_id === request.turn_id)) {
            clearPauseRequest();
            setSaved(restored.messages.every(message => message.status === "complete"));
          } else if (!pauseRequest.current) { setError(""); setSaved(true); }
        } catch { setError("暂时无法确认学习状态，请点击相同按钮重试或刷新页面恢复。"); }
      }
    } finally {
      inFlight.current = false; setBusy(false); abort.current = null;
      if (!sessionRef.current?.english_paused) textArea.current?.focus();
    }
  }

  const conversationTypes = [
    { mode: "general", href: "/", label: "对话实验", description: "开始或继续本次对话实验。", icon: FlaskConical },
    { mode: "english", href: "/english-assistant", label: "英语助教", description: "学习 PEEC 写作，继续英语练习。", icon: BookOpen }
  ] as const;

  function closeNewConversation() {
    newConversationDialog.current?.close();
    setNewConversation(false);
  }

  function newConversationButton(rail = false) {
    return <button type="button" className={rail ? "icon-button rail-chat" : "new-conversation-button"}
      aria-label="新对话" aria-haspopup="dialog" aria-controls="new-conversation-dialog" disabled={busy}
      title={busy ? "正在回复，请等待完成后选择" : "新对话"}
      onClick={() => { if (!inFlight.current) setNewConversation(true); }}>
      <SquarePen size={rail ? 20 : 17} strokeWidth={1.7}/>{!rail && <span>新对话</span>}
    </button>;
  }

  const sidebarConversations = openedConversations.length ? openedConversations : [{ mode: assistantMode, title: conversationTitle(assistantMode, session) }];
  const sidebarContent = <>
    {newConversationButton()}
    <div className="sidebar-section-label">当前会话</div>
    <ConversationHistory items={sidebarConversations} currentMode={assistantMode} busy={busy}
      isBusy={() => inFlight.current} onSelect={selectedMode => {
        if (selectedMode === assistantMode) focusConversation();
        else setMobileNav(false);
      }}/>
    <div className="sidebar-bottom">
      <p><LockKeyhole size={14}/>对话自动保存</p>
      <span>在同一浏览器中可继续本次对话。</span>
      <div className="participant-id"><span>{session?.student_id ? "学号" : "会话编号"}</span><strong>{session?.student_id ?? session?.conversation.participant_code ?? "等待登记"}</strong></div>
    </div>
  </>;

  return <div className={"app-frame" + (english ? " english-assistant" : "")}>
    {mode === "demo" && <DemoBanner/>}
    {siteKey && mode === "live" && <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onReady={() => setCaptchaReady(true)}/>}
    <div className={"chat-layout " + (sidebarOpen ? "" : "sidebar-collapsed")}>
      <aside className="participant-sidebar" aria-label="对话侧栏">
        <div className="sidebar-rail">
          <button className="icon-button" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"} aria-expanded={sidebarOpen}
            aria-controls="conversation-sidebar" title={sidebarOpen ? "收起侧栏" : "展开侧栏"} onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeft size={20}/></button>
          {newConversationButton(true)}
          <button className="icon-button rail-chat active" aria-label="当前对话" title="当前对话" onClick={focusConversation}><ChatMark size={21}/></button>
          <div className="rail-bottom"><span className="participant-avatar" title="学生" aria-label="学生">学</span></div>
        </div>
        <section className="sidebar-panel" id="conversation-sidebar" hidden={!sidebarOpen}>
          <header className="sidebar-panel-heading">对话</header>
          {sidebarContent}
        </section>
      </aside>
      <main className="chat-main">
        <header className="chat-header">
          <div className="chat-header-title">
            <button className="icon-button mobile-sidebar-toggle" aria-label="打开对话侧栏" aria-haspopup="dialog" onClick={() => setMobileNav(true)}><PanelLeft size={20}/></button>
            <span className="chat-title">{settings.title}</span>
          </div>
          <button className="icon-button" aria-label="查看使用说明" aria-haspopup="dialog" title="使用说明" onClick={() => setHelp(true)}><CircleHelp size={20}/></button>
        </header>
        <div className={"chat-stage " + (messages.length ? "has-messages" : "is-empty") + (entry ? " requires-entry" : "")}>
          <div className="chat-scroll">
            {entry ? <section className="entry-card">
              <span className="welcome-mark"><ChatMark size={32}/></span>
              <h1>{english ? "进入英语助教" : "进入对话"}</h1><p className="muted">使用学号登记，继续属于你的对话。</p>
              {legacyIdentity && <p className="small-note">检测到此前网站的登录记录。旧记录需要管理员完成身份迁移后才能继续，请先联系管理员确认，再登记。</p>}
              <form onSubmit={e => { e.preventDefault(); void boot(code, captchaToken, true); }}>
                <label className="field"><span>学号</span><input type="text" value={studentId} onChange={e => setStudentId(e.target.value)} required maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="请输入完整学号，保留开头的 0"/><small>登记后不可自行修改。请使用同一浏览器参与；更换设备请联系管理员。</small></label>
                {requireCode && <label className="field"><span>访问码</span><input value={code} onChange={e => setCode(e.target.value)} required autoComplete="off" placeholder="由管理员提供"/></label>}
                <label className="entry-confirm"><input type="checkbox" required/><span>我已核对学号，并知悉学号将关联本次对话、对话内容将被保存。</span></label>
                {siteKey && <div ref={captchaContainer} className="captcha-container"/>}
                {error && <p className="error-box" role="alert">{error}</p>}
                <button className="button primary full-width" disabled={loading || Boolean(siteKey && !captchaToken)}>
                  {loading ? <LoaderCircle className="spin" size={17}/> : <>进入对话<ChevronRight size={16}/></>}
                </button>
              </form>
            </section> : messages.length === 0 ? <section className="welcome">
              <div className="welcome-heading"><span className="welcome-mark"><ChatMark size={31}/></span><h1>{settings.assistant_name}</h1></div>
              <p className="welcome-copy">{settings.welcome_message}</p>
            </section> : <div className="message-list" aria-label="对话消息" aria-busy={busy}>
              {messages.map(message => <article key={message.id} className={"message " + message.role}>
                {message.role === "assistant" && <div className="assistant-avatar"><ChatMark size={22}/></div>}
                <div className="message-content">
                  <div className={message.role === "user" ? "sr-only" : "message-author"}>{message.role === "user" ? "你" : settings.assistant_name}</div>
                  <div className="message-body">{message.content
                    ? message.role === "user" ? <p className="user-message-text">{message.content}</p> : <Markdown>{participantMessageContent(message, !english && Boolean(session?.question_progress))}</Markdown>
                    : <span className="typing"><i/><i/><i/><span className="sr-only">正在生成回复</span></span>}</div>
                  {message.status === "failed" && <span className="message-status warning-text">此条回复未完成</span>}
                </div>
              </article>)}
              <div ref={end}/>
            </div>}
          </div>
          {!entry && <div className="composer-region">
            {english ? <EnglishProgress state={session?.english_progress} course={session?.english_course}/> : <QuestionProgress state={session?.question_progress}/>}
            {english && session && !conversationCompleted && <div className={"english-learning-control" + (englishPaused ? " is-paused" : "")}>
              <span role={englishPaused ? "status" : undefined}>{englishPaused ? "学习已暂停，当前题目与进度已保留" : pausePending ? "学习状态尚待确认，请重试当前操作。" : "可暂停学习，保留当前题目与进度"}</span>
              <button type="button" className="english-learning-button" disabled={busy || loading}
                onClick={() => void changeEnglishPause(!englishPaused)}>
                {busy && pausePending ? <LoaderCircle size={14} className="spin"/> : englishPaused ? <Play size={14}/> : <Pause size={14}/>}
                {englishPaused ? "继续学习" : "暂停学习"}
              </button>
            </div>}
            {(error || (failed && !busy) || (!session && !loading)) && <div className="chat-error" role="alert">
              {error && <span>{error}</span>}
              {failed && !busy && <button className="retry-button" disabled={english && (englishPaused || pausePending || session?.enabled === false || conversationCompleted)} onClick={() => void send(true)}><RefreshCw size={14}/>重试回复</button>}
              {!session && !loading && <button className="retry-button" onClick={() => void boot()}><RefreshCw size={14}/>重新连接</button>}
            </div>}
            <form className={"composer " + (busy ? "is-busy" : "")} onSubmit={e => { e.preventDefault(); void send(); }}>
              <textarea ref={textArea} aria-label="输入消息" rows={1} maxLength={8000} value={input}
                onChange={e => setInput(e.target.value)} placeholder={conversationCompleted ? english ? "BOPPPS 学习已完成，可回看学习记录" : "两轮问答已完成，感谢参与" : session?.enabled === false ? "本次对话已暂停，请联系管理员" : englishPaused ? "学习已暂停，点击“继续学习”后作答" : pausePending ? "请先确认学习状态后继续作答" : "给" + settings.assistant_name + "发送消息"}
                disabled={conversationCompleted || loading || !session || session.enabled === false || busy || Boolean(failed) || englishPaused || pausePending}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/>
              <div className="composer-toolbar">
                <span className="chat-feedback" role="status" aria-live="polite">
                  {loading ? <><LoaderCircle size={13} className="spin"/>正在连接…</> :
                    busy ? <><LoaderCircle size={13} className="spin"/>{pausePending ? "正在保存学习状态…" : "正在回复…"}</> :
                    saved ? <><Check size={14}/>{mode === "demo" ? "已保存到本浏览器" : "对话已保存"}</> :
                    <><LockKeyhole size={13}/>对话自动记录</>}
                </span>
                <div className="composer-actions"><span className="input-hint">Shift + Enter 换行</span>
                  <button type="submit" className="send-button" aria-label="发送消息" title="发送消息"
                    disabled={conversationCompleted || !input.trim() || busy || loading || !session || !session.enabled || Boolean(failed) || englishPaused || pausePending}>
                    {busy ? <LoaderCircle className="spin" size={20}/> : <ArrowUp size={22}/>}
                  </button>
                </div>
              </div>
            </form>
          </div>}
        </div>
        <p className="disclosure">{settings.disclosure}</p>
      </main>
    </div>
    <dialog ref={mobileDialog} className="mobile-sidebar-dialog" aria-label="对话侧栏" onClose={() => setMobileNav(false)}
      onClick={e => { if (e.target === e.currentTarget) setMobileNav(false); }}>
      <section className="mobile-sidebar-content">
        <header className="sidebar-panel-heading"><span>对话</span><button className="icon-button" aria-label="关闭对话侧栏" autoFocus onClick={() => setMobileNav(false)}><X size={20}/></button></header>
        {sidebarContent}
      </section>
    </dialog>
    <dialog ref={newConversationDialog} id="new-conversation-dialog" className="new-conversation-dialog"
      aria-labelledby="new-conversation-title" aria-describedby="new-conversation-description" onClose={() => setNewConversation(false)}
      onClick={e => { if (e.target === e.currentTarget) closeNewConversation(); }}>
      <section className="new-conversation-picker">
        <header><h2 id="new-conversation-title">新对话</h2><button type="button" className="icon-button" aria-label="关闭新对话选择" autoFocus onClick={closeNewConversation}><X size={20}/></button></header>
        <p id="new-conversation-description">选择要进入的对话类型。</p>
        <nav className="conversation-type-options" aria-label="选择对话类型">
          {conversationTypes.map(item => <Link key={item.mode} href={item.href}
            className={"conversation-type-option" + (assistantMode === item.mode ? " active" : "")}
            aria-current={assistantMode === item.mode ? "page" : undefined} aria-disabled={busy || undefined}
            onClick={event => { if (inFlight.current) event.preventDefault(); }}
            onNavigate={event => {
              if (inFlight.current) { event.preventDefault(); return; }
              closeNewConversation();
              if (assistantMode === item.mode) { event.preventDefault(); focusConversation(); }
              else setMobileNav(false);
            }}>
            <span className="conversation-type-icon"><item.icon size={23} strokeWidth={1.7}/></span>
            <span className="conversation-type-copy"><strong>{item.label}</strong><span>{item.description}</span></span>
            <ChevronRight size={18}/>
          </Link>)}
        </nav>
      </section>
    </dialog>
    <dialog ref={helpDialog} className="help-dialog" aria-labelledby="help-title" onClose={() => setHelp(false)}
      onClick={e => { if (e.target === e.currentTarget) setHelp(false); }}>
      <section className="participant-help">
        <header><h2 id="help-title">关于本次对话</h2><button className="icon-button" aria-label="关闭使用说明" autoFocus onClick={() => setHelp(false)}><X size={20}/></button></header>
        <p>{settings.disclosure}</p>
        {english && <p>英语助教按 BOPPPS 的导入、目标、前测、参与式学习、后测、总结依次开展 PEEC 写作学习。请完成当前活动，系统会根据作答推进；阶段进度只用于查看。</p>}
        {english && <p>这是独立的 PEEC 课程，分别保留课程记录与学习进度。</p>}
        {english && <p>表达“不想学了”或点击“暂停学习”可保留当前题目与进度；点击“继续学习”后从原处继续。</p>}
        <p>点击侧栏的“新对话”可选择对话类型，各自记录分别保留；回复生成期间，请等待回复完成后切换。</p>
        <p>刷新页面可恢复当前会话；清除浏览器数据或更换设备后，请联系管理员核验，不能仅凭学号读取记录。</p>
        <p>{mode === "demo" ? "当前为本地演示，回复为模拟内容，对话只保存在这个浏览器中。" : "对话记录会保存在服务端。有关记录的查看或删除，请联系管理员。"}</p>
        {english && <p><Link className="text-link" href="/admin/english-assistant" aria-disabled={busy || undefined}
          title={busy ? "正在回复，请等待完成后打开管理页" : "英语课程管理"}
          onClick={event => { if (inFlight.current) event.preventDefault(); }}
          onNavigate={event => { if (inFlight.current) event.preventDefault(); }}>英语课程管理</Link></p>}
      </section>
    </dialog>
  </div>;
}
