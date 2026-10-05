import type { ModelConnection, ModelFactor, ExperimentSettings } from "./experiment";
import type { StudySettings } from "./types";
import { resolveProviderEndpoint } from "./provider-endpoint";

// Transport settings may rotate; experimental settings must remain frozen.
export type ConnectionSettings = Pick<StudySettings,
  "protocol" | "api_base_url" | "api_url_mode" | "anthropic_auth" | "anthropic_workspace" | "token_parameter">;
export type ConversationConnectionInfo = {
  source: "latest" | "original" | "unavailable";
  experiment_revision: number | null;
  published_at: string | null;
  settings: ConnectionSettings | null;
  endpoint: string | null;
};
type PublishedConnection = { revision: number; created_at: string; settings: ExperimentSettings };

export function transportSettings(connection: ModelConnection | StudySettings): ConnectionSettings {
  const { protocol, api_base_url, anthropic_auth, anthropic_workspace, token_parameter } = connection;
  return { protocol, api_base_url, api_url_mode: connection.api_url_mode ?? "base",
    anthropic_auth, anthropic_workspace, token_parameter };
}

export function applyConnectionSettings(original: StudySettings, connection: ModelConnection): StudySettings {
  // Do not spread a connection: it also contains model, temperature and output budget.
  return { ...original, ...transportSettings(connection) };
}

export function describeConversationConnection(original: StudySettings, factor: ModelFactor | null,
  latest: PublishedConnection | null): ConversationConnectionInfo {
  if (factor && !latest) return { source: "unavailable", experiment_revision: null,
    published_at: null, settings: null, endpoint: null };
  const settings = transportSettings(factor ? latest!.settings.connections[factor] : original);
  return { source: factor ? "latest" : "original", experiment_revision: factor ? latest!.revision : null,
    published_at: factor ? latest!.created_at : null, settings, endpoint: resolveProviderEndpoint(settings) };
}
