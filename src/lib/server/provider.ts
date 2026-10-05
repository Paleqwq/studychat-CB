import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { StudySettings } from "@/lib/types";
import { isAllowedHostname, normalizeBaseUrl } from "@/lib/validation";
import { normalizeProviderAddress, resolveProviderEndpoint, type ProviderProtocol, type ApiUrlMode } from "@/lib/provider-endpoint";
import { parseSse } from "@/lib/sse";
import { HttpError } from "./http";

type Message = { role: "user" | "assistant"; content: string };
export type ProviderConfig = StudySettings & { api_key: string };

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // Only globally routed unicast IPv6; excludes mapped IPv4, ULA and link-local.
    return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith("2001:db8:");
  }
  return false;
}

export async function validateEndpoint(value: string, protocol?: ProviderProtocol, mode?: ApiUrlMode) {
  let base: string;
  try { base = protocol ? normalizeProviderAddress({ api_base_url: value, protocol, api_url_mode: mode }) : normalizeBaseUrl(value); } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "请输入合法的 HTTPS API 地址。");
  }
  const host = new URL(base).hostname;
  const defaults = "api.openai.com,api.anthropic.com,api.deepseek.com,openrouter.ai,api.siliconflow.cn";
  if (!isAllowedHostname(host, process.env.AI_ALLOWED_HOSTS ?? defaults)) {
    throw new HttpError(400, "此域名不在服务器 AI_ALLOWED_HOSTS 允许列表中，请先由部署者添加。");
  }
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
    throw new HttpError(400, "API 域名当前解析到本机或私有网络，请检查 DNS；若使用代理/TUN，请检查其 DNS 分流规则后重试。");
  }
  return base;
}

export function buildProviderRequest(config: ProviderConfig, messages: Message[]) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  const body: Record<string, unknown> = { model: config.model, stream: true };
  if (config.protocol === "anthropic") {
    if (config.anthropic_auth === "bearer") headers.Authorization = "Bearer " + config.api_key;
    else headers["x-api-key"] = config.api_key;
    headers["anthropic-version"] = "2023-06-01";
    if (config.anthropic_workspace) headers["anthropic-workspace-id"] = config.anthropic_workspace;
    body.system = config.system_prompt;
    body.messages = messages;
    body.max_tokens = config.max_tokens;
  } else if (config.protocol === "openai-responses") {
    headers.Authorization = "Bearer " + config.api_key;
    body.instructions = config.system_prompt;
    body.input = messages;
    body.max_output_tokens = config.max_tokens;
    body.store = false;
  } else {
    headers.Authorization = "Bearer " + config.api_key;
    body.messages = [{ role: "system", content: config.system_prompt }, ...messages];
    body[config.token_parameter] = config.max_tokens;
  }
  if (config.temperature !== null) body.temperature = config.temperature;
  return { url: resolveProviderEndpoint(config), headers, body };
}

export async function* decodeProviderStream(protocol: StudySettings["protocol"], stream: ReadableStream<Uint8Array>) {
  let completed = false;
  let sawText = false;
  for await (const data of parseSse(stream)) {
    if (data === "[DONE]") { if (protocol === "openai-chat") completed = true; break; }
    const event = JSON.parse(data);
    if (event.error || event.type === "error" || event.type === "response.failed") throw new Error("上游模型返回错误。");
    let text = "";
    if (protocol === "anthropic") {
      if (event.type === "content_block_start" && event.content_block?.type === "text") text = event.content_block.text ?? "";
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text = event.delta.text ?? "";
      if (event.type === "message_delta" && ["max_tokens", "tool_use", "pause_turn"].includes(event.delta?.stop_reason)) {
        throw new Error("回复未完整结束，请联系管理员调整模型或输出长度。");
      }
      if (event.type === "message_stop") completed = true;
    } else if (protocol === "openai-responses") {
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") text = event.delta ?? "";
      if (event.type === "response.completed") completed = true;
      if (event.type === "response.incomplete") throw new Error("回复被截断，请联系管理员调整输出长度。");
    } else {
      const choice = event.choices?.[0];
      if (typeof choice?.delta?.content === "string") text = choice.delta.content;
      if (typeof choice?.delta?.refusal === "string") text += choice.delta.refusal;
      if (choice?.finish_reason === "stop") completed = true;
      if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error("回复未完整结束，请联系管理员调整模型参数。");
    }
    if (text) { sawText = true; yield text; }
  }
  if (!completed || !sawText) throw new Error("模型连接中断或未返回文本，请重试。");
}

export function trimHistory(messages: Message[], budget = 60000): Message[] {
  const selected: Message[] = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (selected.length && size + messages[i].content.length > budget) break;
    selected.unshift(messages[i]);
    size += messages[i].content.length;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

export async function* generateReply(config: ProviderConfig, messages: Message[], signal: AbortSignal) {
  const base = await validateEndpoint(config.api_base_url, config.protocol, config.api_url_mode);
  const request = buildProviderRequest({ ...config, api_base_url: base }, trimHistory(messages));
  const response = await fetch(request.url, {
    method: "POST", headers: request.headers, body: JSON.stringify(request.body),
    signal, redirect: "error", cache: "no-store"
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 401) throw new Error("AI 服务认证失败（HTTP 401），请联系管理员检查该模型的 API 地址、认证方式及密钥。");
    throw new Error("AI 服务暂不可用（HTTP " + response.status + "），请联系管理员检查协议、模型或密钥。");
  }
  yield* decodeProviderStream(config.protocol, response.body);
}
