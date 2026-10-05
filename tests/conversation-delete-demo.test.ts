import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDemoConversation, demoConfig, demoCounts, demoRecord, demoSession, saveDemoSession, saveDemoConfig } from "@/lib/demo";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

describe("local demonstration conversation deletion", () => {
  it("removes only the selected session and snapshot, leaving settings and authentication intact", () => {
    const session = demoSession("00123")!;
    session.messages.push({ id: "message", role: "user", content: "test", status: "complete", turn_id: "turn", created_at: "" });
    saveDemoSession(session);
    const savedConfig = storage.get("studychat.demo.config.v2");
    storage.set("studychat.participant.auth", "test-only-session"); storage.set("unrelated", "preserve");
    expect(Object.values(demoCounts()).reduce((a, b) => a + b, 0)).toBe(1);
    deleteDemoConversation(session.conversation.id);
    expect(demoRecord()).toBeNull();
    expect(demoSession()).toBeNull();
    expect(Object.values(demoCounts()).reduce((a, b) => a + b, 0)).toBe(0);
    expect(storage.has("studychat.demo.experiment-snapshot." + session.conversation.id)).toBe(false);
    expect(storage.get("studychat.demo.config.v2")).toBe(savedConfig);
    expect(storage.get("studychat.participant.auth")).toBe("test-only-session");
    expect(storage.get("unrelated")).toBe("preserve");
    expect(demoConfig().revision).toBe(1);
    expect(demoSession("00123")!.conversation.id).not.toBe(session.conversation.id);
  });
  it("does not clear a different or missing session", () => {
    const session = demoSession("00123")!;
    const saved = [...storage.entries()];
    expect(() => deleteDemoConversation("wrong-id")).toThrow("未找到");
    expect([...storage.entries()]).toEqual(saved);
    deleteDemoConversation(session.conversation.id);
    expect(() => deleteDemoConversation(session.conversation.id)).toThrow("未找到");
  });
  it("shows the latest demo connection without overwriting the stored enrollment or experimental snapshot", () => {
    const session = demoSession("TEST001")!;
    const before = demoRecord()!;
    const snapshot = storage.get("studychat.demo.experiment-snapshot." + session.conversation.id);
    const next = demoConfig(); next.revision++;
    next.connections[before.conversation.model_factor!] = {
      ...next.connections[before.conversation.model_factor!], protocol: "openai-responses", api_url_mode: "endpoint",
      api_base_url: "https://demo.example/relay/responses/", model: "new-model", temperature: 1, max_tokens: 4096
    };
    next.base_prompt = "new task"; next.personality_prompt = "new personality";
    saveDemoConfig(next);
    const after = demoRecord()!;
    expect(after.conversation).toEqual(before.conversation); expect(after.config).toEqual(before.config);
    expect(after.connection).toMatchObject({ source: "latest", experiment_revision: next.revision,
      endpoint: "https://demo.example/relay/responses/", settings: { protocol: "openai-responses" } });
    expect(storage.get("studychat.demo.experiment-snapshot." + session.conversation.id)).toBe(snapshot);
    expect(JSON.stringify(after)).not.toMatch(/api_key|ciphertext/);
  });
});
