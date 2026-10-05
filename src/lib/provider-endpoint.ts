import type { StudySettings } from "./types";

export type ProviderProtocol = StudySettings["protocol"];
export type ApiUrlMode = "base" | "endpoint";
type EndpointConfig = Pick<StudySettings, "protocol" | "api_base_url" | "api_url_mode">;

export const protocolPaths: Record<ProviderProtocol, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  anthropic: "/messages"
};

function parseApiUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new Error("请输入合法的 HTTPS API 地址。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) {
    throw new Error("API 地址须为不含账号、查询参数的 HTTPS 地址（443 端口）。");
  }
  return url;
}

// Kept for legacy callers that do not yet specify a protocol or URL mode.
export function normalizeBaseUrl(value: string): string {
  const url = parseApiUrl(value);
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages)$/, "");
  return url.origin + pathname;
}

export function normalizeProviderAddress(config: EndpointConfig): string {
  const url = parseApiUrl(config.api_base_url);
  const pathname = url.pathname.replace(/\/+$/, "");
  const endpointPath = Object.values(protocolPaths).find(path => pathname.endsWith(path));
  if (endpointPath && endpointPath !== protocolPaths[config.protocol]) {
    throw new Error("API 地址中的接口路径与所选协议不匹配，请分别填写该模型对应的地址。");
  }
  // Explicit endpoints may have provider-specific paths and trailing slashes.
  // Never strip or append a path in this mode.
  if (config.api_url_mode === "endpoint") return url.href;

  let basePath = endpointPath ? pathname.slice(0, -endpointPath.length) : pathname;
  // Only canonical official hosts have documented default prefixes.
  // Custom gateways must retain their supplied path, including an empty path.
  if (!basePath && (url.hostname === "api.openai.com" || url.hostname === "api.anthropic.com")) basePath = "/v1";
  if (url.hostname === "api.deepseek.com" && config.protocol === "anthropic") {
    if (!basePath || basePath === "/v1" || basePath === "/anthropic") basePath = "/anthropic/v1";
  }
  return url.origin + basePath;
}

export function resolveProviderEndpoint(config: EndpointConfig): string {
  const address = normalizeProviderAddress(config);
  return config.api_url_mode === "endpoint" ? address : address + protocolPaths[config.protocol];
}
