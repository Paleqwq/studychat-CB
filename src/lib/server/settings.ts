import { databaseUpgradeMessage } from "./env";
import "server-only";
import { db } from "./db";
import { databaseError, HttpError } from "./http";
import { defaultExperiment, type AdminExperiment, type ExperimentSettings, type ModelFactor } from "@/lib/experiment";

export type PrivateExperiment = {
  id: string; revision: number; settings: ExperimentSettings;
  encrypted_keys: Record<ModelFactor, string>; created_at: string;
};
export async function currentExperiment() {
  const { data: state, error } = await db().from("study_state").select("active_experiment_id,enabled").eq("id", 1).single();
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") throw new HttpError(503, databaseUpgradeMessage("请先在 Supabase 执行 002_factorial_experiment.sql 数据库升级。"));
    databaseError(error.message);
  }
  if (!state.active_experiment_id) return { config: null, enabled: false };
  const { data, error: configError } = await db().from("experiment_versions").select("*").eq("id", state.active_experiment_id).single();
  if (configError) databaseError(configError.message);
  return { config: data as PrivateExperiment, enabled: state.enabled as boolean };
}
export function redactedExperiment(config: PrivateExperiment | null, enabled: boolean): AdminExperiment {
  return {
    ...(config?.settings ?? defaultExperiment()),
    id: config?.id ?? "", revision: config?.revision ?? 0,
    has_api_keys: { deepseek: Boolean(config?.encrypted_keys.deepseek), chatgpt: Boolean(config?.encrypted_keys.chatgpt) },
    enabled, created_at: config?.created_at ?? ""
  };
}
