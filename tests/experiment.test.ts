import { describe, expect, it } from "vitest";
import { defaultExperiment, effectiveSettings, groups } from "@/lib/experiment";
import { experimentSchema, registrationSchema } from "@/lib/validation";
import { publicSettings } from "@/lib/types";
import { participantConversation } from "@/lib/participant";
import { redactedExperiment } from "@/lib/server/settings";

describe("factorial experiment validation and redaction", () => {
  it("requires a student identifier and refuses client-selected assignment fields", () => {
    expect(registrationSchema.parse({ student_id: " 00123ab " })).toEqual({ student_id: "00123AB" });
    for (const student_id of ["", "学号", "123 456", "a".repeat(33)]) expect(registrationSchema.safeParse({ student_id }).success).toBe(false);
    expect(registrationSchema.safeParse({ student_id: "00123", group_code: "chatgpt_control" }).success).toBe(false);
  });
  it("requires both models and an explicit personality manipulation before publishing", () => {
    const config = defaultExperiment();
    const input = { ...config, personality_prompt: "人格", api_keys: { deepseek: "", chatgpt: "" }, expected_revision: 0, enabled: true };
    expect(experimentSchema.safeParse(input).success).toBe(false);
    input.connections.deepseek.model = "deepseek-test";
    input.connections.chatgpt.model = "chatgpt-test";
    expect(experimentSchema.safeParse(input).success).toBe(true);
    expect(experimentSchema.safeParse({ ...input, personality_prompt: " " }).success).toBe(false);
    expect(experimentSchema.safeParse({ ...input, assignments: {} }).success).toBe(false);
  });
  it("composes prompts orthogonally and exposes only common presentation", () => {
    const config = { ...defaultExperiment(), base_prompt: "task", personality_prompt: "personality" };
    for (const g of groups) {
      const effective = effectiveSettings(config, g);
      expect(effective.system_prompt).toBe(g.personality ? "task\n\npersonality" : "task");
      expect(publicSettings(effective)).toEqual(publicSettings(config));
      expect(JSON.stringify(publicSettings(effective))).not.toContain("system_prompt");
    }
  });
  it("omits configuration, group and lease identifiers from participant payloads", () => {
    const safe = participantConversation({ id: "c", participant_code: "P", title: "chat", created_at: "", updated_at: "", request_count: 0,
      config_id: "secret-config", owner_id: "private-owner", lock_token: "private-lease", group_code: "private-group" } as any);
    expect(JSON.stringify(safe)).not.toMatch(/secret-config|private-|config_id|group_code|owner_id|lock_token/);
  });
  it("never returns encrypted credentials in admin settings", () => {
    const output = redactedExperiment({ id: "e", revision: 1, created_at: "", settings: defaultExperiment(),
      encrypted_keys: { deepseek: "private-d", chatgpt: "private-c" } }, true);
    expect(output.has_api_keys).toEqual({ deepseek: true, chatgpt: true });
    expect(JSON.stringify(output)).not.toMatch(/private-|encrypted_keys/);
  });
});
