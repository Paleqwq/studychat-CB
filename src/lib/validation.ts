import { z } from "zod";
import { normalizeProviderAddress } from "./provider-endpoint";
import { questionModeSchema } from "./question-mode";
export { normalizeBaseUrl } from "./provider-endpoint";

export const settingsSchema = z.object({
  protocol: z.enum(["openai-chat", "openai-responses", "anthropic"]),
  anthropic_auth: z.enum(["x-api-key", "bearer"]),
  anthropic_workspace: z.string().trim().max(100).regex(/^[a-zA-Z0-9_-]*$/),
  title: z.string().trim().min(1).max(80),
  assistant_name: z.string().trim().min(1).max(40),
  welcome_message: z.string().trim().min(1).max(2000),
  disclosure: z.string().trim().min(1).max(2000),
  system_prompt: z.string().trim().min(1).max(20000),
  api_base_url: z.url().max(500),
  api_url_mode: z.enum(["base", "endpoint"]).optional(),
  model: z.string().trim().min(1).max(160),
  temperature: z.number().min(0).max(2).nullable(),
  max_tokens: z.number().int().min(256).max(8192),
  token_parameter: z.enum(["max_tokens", "max_completion_tokens"]),
  api_key: z.string().trim().max(1000).optional(),
  enabled: z.boolean(),
  expected_revision: z.number().int().nonnegative()
}).strict();

export const chatSchema = z.object({
  conversation_id: z.uuid(),
  turn_id: z.uuid(),
  question_version: z.number().int().nonnegative().optional(),
  content: z.string().trim().min(1).max(8000)
}).strict();

export const studentIdSchema = z.string().trim().min(1).max(32).regex(/^[0-9A-Za-z_-]+$/)
  .transform(value => value.toUpperCase());
export const registrationSchema = z.object({ student_id: studentIdSchema }).strict();
export const deleteConversationSchema = z.object({
  conversation_id: z.uuid(),
  confirmation: z.literal("DELETE")
}).strict();
const connectionSchema = settingsSchema.pick({ protocol: true, anthropic_auth: true, anthropic_workspace: true,
  api_base_url: true, api_url_mode: true, model: true, temperature: true, max_tokens: true, token_parameter: true }).superRefine((connection, context) => {
  try { normalizeProviderAddress(connection); } catch (error) {
    context.addIssue({ code: "custom", path: ["api_base_url"], message: error instanceof Error ? error.message : "请检查 API 地址。" });
  }
});
export const experimentSchema = settingsSchema.pick({ title: true, assistant_name: true, welcome_message: true, disclosure: true }).extend({
  base_prompt: z.string().trim().min(1).max(10000),
  personality_prompt: z.string().trim().min(1).max(10000),
  question_mode: questionModeSchema.optional(),
  connections: z.object({ deepseek: connectionSchema, chatgpt: connectionSchema }).strict(),
  api_keys: z.object({ deepseek: z.string().trim().max(1000), chatgpt: z.string().trim().max(1000) }).strict(),
  enabled: z.boolean(),
  expected_revision: z.number().int().nonnegative(),
  expected_draft_revision: z.number().int().nonnegative().optional()
}).strict();

/** Teaching content can be saved before model connections or API keys exist. */
export const experimentContentSchema = experimentSchema.pick({
  title: true, assistant_name: true, welcome_message: true, disclosure: true,
  base_prompt: true, personality_prompt: true, question_mode: true
}).strict();
export const contentDraftSchema = z.object({
  content: experimentContentSchema,
  enabled: z.boolean(),
  expected_draft_revision: z.number().int().nonnegative()
}).strict();
export type ExperimentContent = z.infer<typeof experimentContentSchema>;

export function isAllowedHostname(hostname: string, allowlist: string): boolean {
  const hosts = allowlist.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return hosts.includes(hostname.toLowerCase());
}
