import { z } from "zod";
import { requireUser, errorResponse, readJson } from "@/lib/server/http";
import { assertEnglishAccessCode } from "@/lib/server/english-access";
import { setEnglishLearningPause } from "@/lib/server/english-learning-pause";
import { chatSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pauseSchema = chatSchema.omit({ question_version: true }).extend({
  english_version: z.number().int().nonnegative(), paused: z.boolean()
}).strict();

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    assertEnglishAccessCode(request);
    const input = pauseSchema.parse(await readJson(request));
    return Response.json(await setEnglishLearningPause(user.id, input, input.paused));
  } catch (error) { return errorResponse(error); }
}
