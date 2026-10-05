import "server-only";
import { z } from "zod";
import { db } from "./db";
import { englishDatabaseError } from "./english-chat";
import { englishProgressSchema } from "@/lib/english-assistant";
import type { EnglishLearningControlResult } from "@/lib/types";

const controlMessageSchema = z.object({
  id: z.uuid(), role: z.enum(["user", "assistant"]), content: z.string(),
  status: z.literal("complete"), turn_id: z.uuid(), created_at: z.string(),
  error_code: z.string().nullable().optional()
});
const controlResultSchema = z.object({
  user: controlMessageSchema, assistant: controlMessageSchema,
  english_progress: englishProgressSchema, english_paused: z.boolean()
});

export async function setEnglishLearningPause(ownerId: string,
  input: { conversation_id: string; turn_id: string; content: string; english_version: number },
  paused: boolean): Promise<EnglishLearningControlResult> {
  const { data, error } = await db().rpc("set_english_learning_pause", {
    p_session: input.conversation_id, p_owner: ownerId, p_turn: input.turn_id,
    p_content: input.content, p_version: input.english_version, p_paused: paused
  });
  if (error) englishDatabaseError(error);
  return controlResultSchema.parse(data);
}

export function englishLearningPauseStream(result: EnglishLearningControlResult): Response {
  // Both messages and the pause flag have committed before any event is shown.
  const accepted = { type: "accepted", user: result.user, assistant: { ...result.assistant, content: "", status: "pending" } };
  const done = { type: "done", message: result.assistant,
    english_progress: result.english_progress, english_paused: result.english_paused };
  return new Response([accepted, done].map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }
  });
}
