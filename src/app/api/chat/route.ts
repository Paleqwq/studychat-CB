import { db } from "@/lib/server/db";
import { decryptSecret } from "@/lib/server/crypto";
import { requireUser, assertStudyCode, readJson, errorResponse, databaseError, HttpError } from "@/lib/server/http";
import { generateReply } from "@/lib/server/provider";
import { currentConversationConnection } from "@/lib/server/conversation-connection";
import { createSseWriter } from "@/lib/server/sse-writer";
import { groups } from "@/lib/experiment";
import { chatSchema } from "@/lib/validation";
import type { ChatEvent, ChatMessage, StudySettings } from "@/lib/types";
import { questionChat } from "@/lib/server/question-chat";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    assertStudyCode(request);
    const input = chatSchema.parse(await readJson(request));
    const { data: conversation, error: conversationError } = await db().from("conversations")
      .select("id,config_id").eq("id", input.conversation_id).eq("owner_id", user.id).maybeSingle();
    if (conversationError) databaseError(conversationError.message);
    if (!conversation) throw new HttpError(403, "无权访问此会话。");
    const [snapshot, enrollment] = await Promise.all([
      db().from("config_versions").select("settings,api_key_ciphertext").eq("id", conversation.config_id).single(),
      db().from("participant_enrollments").select("group_code").eq("conversation_id", conversation.id).maybeSingle()
    ]);
    if (snapshot.error || enrollment.error) databaseError("READ_FAILED");
    const groupCode = enrollment.data?.group_code;
    const factor = enrollment.data ? groups.find(group => group.code === groupCode)?.model : null;
    if (factor === undefined) throw new HttpError(503, "模型连接信息不完整，请联系管理员核验。");
    const config = snapshot.data;
    if ((config.settings as StudySettings).question_mode?.enabled) {
      return await questionChat(request, user.id, input, config.settings as StudySettings, config.api_key_ciphertext, factor);
    }
    const connection = await currentConversationConnection(config.settings as StudySettings, factor);
    if (connection.info.source === "unavailable") {
      throw new HttpError(503, "模型连接尚未配置完整，请管理员重新发布对应模型的地址和密钥。");
    }
    // Check decryption before accepting a durable turn.
    const apiKey = decryptSecret(connection.api_key_ciphertext ?? config.api_key_ciphertext);
    const { data: turn, error: turnError } = await db().rpc("begin_turn", {
      p_conversation: conversation.id, p_owner: user.id, p_turn: input.turn_id, p_content: input.content
    });
    if (turnError) databaseError(turnError.message);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) abort.abort();
    let cancelStream = () => {};
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writer = createSseWriter<ChatEvent>(controller, { signal: abort.signal, onDisconnect: () => abort.abort() });
        cancelStream = writer.cancel;
        const emit = writer.emit;
        const timer = setTimeout(() => abort.abort(), 120000);
        const stopTimer = () => clearTimeout(timer);
        abort.signal.addEventListener("abort", stopTimer, { once: true });
        if (abort.signal.aborted) stopTimer();
        let content = "";
        let checkpoint = Date.now();
        let savedLength = 0;
        const save = async (status: "pending" | "complete" | "failed", errorCode: string | null = null) => {
          const { data, error } = await db().rpc("save_reply", {
            p_conversation: conversation.id, p_turn: input.turn_id, p_lease: turn.lock_token,
            p_content: content, p_status: status, p_error: errorCode
          });
          if (error) throw new Error("回复保存失败，请刷新确认记录后重试。");
          return data as ChatMessage;
        };
        try {
          emit({ type: "accepted", user: turn.user, assistant: turn.assistant });
          if (turn.state === "complete") { emit({ type: "done", message: turn.assistant }); return; }
          const { data: history, error } = await db().from("messages")
            .select("role,content").eq("conversation_id", conversation.id).eq("status", "complete").order("sequence");
          if (error) throw new Error("无法读取历史记录，请重试。");
          for await (const delta of generateReply(
            { ...connection.settings, api_key: apiKey },
            history as { role: "user" | "assistant"; content: string }[], abort.signal
          )) {
            content += delta;
            if (content.length > 49000) throw new Error("回复过长，请联系管理员调整输出长度。");
            emit({ type: "delta", text: delta });
            if (content.length - savedLength > 1000 || Date.now() - checkpoint > 2500) {
              await save("pending");
              savedLength = content.length; checkpoint = Date.now();
            }
          }
          const message = await save("complete");
          emit({ type: "done", message });
        } catch (error) {
          const wasAborted = abort.signal.aborted;
          abort.abort();
          if (turn.state !== "complete") {
            await save("failed", wasAborted ? "interrupted" : "provider_error").catch(() => {});
          }
          const safeMessage = error instanceof Error &&
            /^(AI 服务|回复|模型连接|上游模型|无法读取)/.test(error.message)
              ? error.message : "连接暂时中断，请重试；已保存的消息不会丢失。";
          emit({ type: "error", message: safeMessage });
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", stopTimer);
          request.signal.removeEventListener("abort", onAbort);
          writer.close();
        }
      },
      cancel() { cancelStream(); abort.abort(); }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }
    });
  } catch (error) { return errorResponse(error); }
}
