import "server-only";
import type { StudySettings } from "@/lib/types";
import { modelFactors, type ModelFactor } from "@/lib/experiment";
import { applyConnectionSettings, describeConversationConnection } from "@/lib/conversation-connection";
import { currentExperiment } from "./settings";
import { HttpError } from "./http";

export async function currentConversationConnection(original: StudySettings, factor: ModelFactor | null) {
  if (factor !== null && !modelFactors.includes(factor)) {
    throw new HttpError(503, "模型连接信息不完整，请联系管理员核验。");
  }
  // One immutable publication is captured per request, not cached across turns.
  // Ungrouped historical records must not guess a model factor or borrow its key.
  const latest = factor ? (await currentExperiment()).config : null;
  const available = latest && factor && latest.settings.connections[factor] && latest.encrypted_keys[factor];
  const info = describeConversationConnection(original, factor, available ? latest : null);
  return { info,
    settings: info.source === "latest" ? applyConnectionSettings(original, latest!.settings.connections[factor!]) : original,
    api_key_ciphertext: info.source === "latest" ? latest!.encrypted_keys[factor!] : null };
}
