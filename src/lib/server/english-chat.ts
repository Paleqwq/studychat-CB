import { databaseUpgradeMessage } from "./env";
import "server-only";
import { db } from "./db";
import { decryptSecret } from "./crypto";
import { databaseError, HttpError } from "./http";
import { generateReply } from "./provider";
import { buildEnglishPrompt, parseEnglishAssessment, type EnglishTeachingPrompts } from "./english-prompt";
import { currentConversationConnection } from "./conversation-connection";
import { createSseWriter } from "./sse-writer";
import { parseEnglishProgress, resolveEnglishCurriculum, advanceEnglishProgress, englishTurnContent, type EnglishProgress } from "@/lib/english-assistant";
import type { ChatMessage, StudySettings } from "@/lib/types";

export function englishDatabaseError(error: { code?: string; message: string }): never {
  if (["PGRST202", "42883", "42703", "PGRST204", "42P01"].includes(error.code ?? "")) {
    throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 执行尚未应用的 005_english_assistant.sql、006_english_groups.sql、007_english_curriculum_and_delete.sql 和 008_english_learning_pause.sql，再使用英语助教。"));
  }
  if (error.message.includes("ENGLISH_LEARNING_PAUSED")) {
    throw new HttpError(409, "本次英语学习已暂停，请点击“继续学习”后再作答。");
  }
  if (error.message.includes("INVALID_ENGLISH_CONTROL")) throw new HttpError(400, "暂停或继续学习的请求无效，请刷新页面重试。");
  if (error.message.includes("ENGLISH_STATE_CONFLICT")) {
    throw new HttpError(409, "英语学习进度已更新，请刷新页面后再作答。");
  }
  if (error.message.includes("ENGLISH_COMPLETED")) {
    throw new HttpError(409, "本次英语学习已完成，可查看已保存的学习记录。");
  }
  if (error.message.includes("INVALID_ENGLISH_ASSESSMENT")) {
    throw new HttpError(503, "回复未通过校验，英语学习进度未改变，请重试本次回复。");
  }
  if (error.message.includes("ENGLISH_PAUSED")) {
    throw new HttpError(403, "英语助教已暂停，请联系管理员。");
  }
  if (error.message.includes("INVALID_ENGLISH_CONFIG")) {
    throw new HttpError(400, "请完整填写英语课程提示词，并在原模型连接页配置 DeepSeek。");
  }
  databaseError(error.message);
}

type EnglishInput = { conversation_id: string; turn_id: string; content: string; english_version: number };
type EnglishEvent =
  | { type: "accepted"; user: ChatMessage; assistant: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage; english_progress: EnglishProgress; english_paused: boolean }
  | { type: "error"; message: string };

export async function englishChat(request: Request, ownerId: string, input: EnglishInput,
  settings: StudySettings, ciphertext: string,
  teaching: EnglishTeachingPrompts & { model_factor?: "deepseek" | null } = {}) {
  const { data: turn, error } = await db().rpc("begin_english_turn", {
    p_session: input.conversation_id, p_owner: ownerId, p_turn: input.turn_id,
    p_content: input.content, p_version: input.english_version
  });
  if (error) englishDatabaseError(error);
  const curriculum = resolveEnglishCurriculum(teaching.curriculum);
  const state = parseEnglishProgress(turn.english_progress, curriculum);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) abort.abort();
  let cancelStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = createSseWriter<EnglishEvent>(controller, { signal: abort.signal, onDisconnect: () => abort.abort() });
      cancelStream = writer.cancel;
      const emit = writer.emit;
      const timer = setTimeout(() => abort.abort(), 120000);
      const stopTimer = () => clearTimeout(timer);
      abort.signal.addEventListener("abort", stopTimer, { once: true });
      if (abort.signal.aborted) stopTimer();
      let committed = turn.state === "complete";
      try {
        emit({ type: "accepted", user: turn.user, assistant: turn.assistant });
        if (committed) { emit({ type: "done", message: turn.assistant, english_progress: state, english_paused: turn.english_paused ?? false }); return; }
        if (abort.signal.aborted) throw new Error("回复已中断，请重试。");
        const connection = teaching.model_factor
          ? await currentConversationConnection(settings, teaching.model_factor) : null;
        if (connection?.info.source === "unavailable") throw new Error("模型连接暂不可用，请联系管理员检查原后台的 DeepSeek 设置。");
        const apiKey = decryptSecret(connection?.api_key_ciphertext ?? ciphertext);
        const modelSettings = connection?.settings ?? settings;
        const { data: history, error: historyError } = await db().from("english_assistant_messages")
          .select("role,content").eq("session_id", input.conversation_id).eq("status", "complete").order("sequence");
        if (historyError) throw new Error("无法读取英语学习记录，请重试。");
        const messages = history as { role: "user" | "assistant"; content: string }[];
        const systemPrompt = buildEnglishPrompt(state, teaching);
        let correction = "";
        let assessment: ReturnType<typeof parseEnglishAssessment> | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (abort.signal.aborted) throw new Error("回复已中断，请重试。");
          let raw = "";
          for await (const delta of generateReply({ ...modelSettings, question_mode: undefined, api_key: apiKey,
            system_prompt: systemPrompt + correction }, messages, abort.signal)) {
            if (abort.signal.aborted) throw new Error("回复已中断，请重试。");
            raw += delta;
            if (raw.length > 20000) throw new Error("回复过长，请联系管理员调整输出长度。");
          }
          if (abort.signal.aborted) throw new Error("回复已中断，请重试。");
          try { assessment = parseEnglishAssessment(raw, input.content, state, curriculum); break; }
          catch {
            // Never include the rejected response, student text or credentials
            // in diagnostics or send the internal JSON protocol to the browser.
            console.warn("english_assessment_validation_failed", { attempt });
            if (attempt === 2) throw new Error("回复格式未通过校验，英语学习进度未改变，请重试本次回复。");
            correction = "\n\n【程序内部输出校正】请根据同一份原始学生对话重新生成本次结果。只返回合法 JSON，恰好包含 achieved（布尔值）、evidence（不超过300字的连续学生原话）、feedback（1至6000字的反馈）。不得输出代码围栏或额外字段。练习与后测达标必须有最新学生回答中的真实证据；确认、跳题或自称达标不是练习证据。保持当前 BOPPPS 阶段，不向学生提及本条约束或校验。";
          }
        }
        if (!assessment || abort.signal.aborted) throw new Error("回复已中断，请重试。");
        const next = advanceEnglishProgress(state, assessment.achieved, curriculum);
        const content = englishTurnContent(state, next, assessment.feedback, curriculum);
        const { data: saved, error: saveError } = await db().rpc("save_english_reply", {
          p_session: input.conversation_id, p_turn: input.turn_id, p_lease: turn.lock_token,
          p_expected: state, p_assessment: assessment, p_content: content, p_status: "complete", p_error: null
        });
        if (saveError) englishDatabaseError(saveError);
        committed = true;
        // Show the fixed next-stage task only after message and progress commit.
        emit({ type: "delta", text: content });
        emit({ type: "done", message: saved.message as ChatMessage,
          english_progress: parseEnglishProgress(saved.english_progress, curriculum), english_paused: false });
      } catch (error) {
        const wasAborted = abort.signal.aborted;
        abort.abort();
        if (!committed) await db().rpc("save_english_reply", {
          p_session: input.conversation_id, p_turn: input.turn_id, p_lease: turn.lock_token,
          p_expected: state, p_assessment: null, p_content: "", p_status: "failed",
          p_error: wasAborted ? "interrupted" : "english_reply_error"
        }).then(() => {}, () => {});
        const safeMessage = error instanceof Error && /^(AI 服务|回复|模型连接|上游模型|无法读取)/.test(error.message)
          ? error.message : "英语助教回复暂时中断，请刷新确认记录后重试；当前学习阶段不会跳过。";
        emit({ type: "error", message: safeMessage });
      } finally {
        clearTimeout(timer); abort.signal.removeEventListener("abort", stopTimer);
        request.signal.removeEventListener("abort", onAbort);
        writer.close();
      }
    },
    cancel() { cancelStream(); abort.abort(); }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
