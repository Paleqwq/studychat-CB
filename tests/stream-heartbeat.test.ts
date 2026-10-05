import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialEnglishProgress, advanceEnglishProgress } from "@/lib/english-assistant";
import { defaultSettings } from "@/lib/types";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ db: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/server/provider", () => ({ generateReply: mocks.generate }));
vi.mock("@/lib/server/crypto", () => ({ decryptSecret: () => "private-model-test-key" }));
vi.mock("@/lib/server/conversation-connection", () => ({ currentConversationConnection: vi.fn() }));
import { englishChat } from "@/lib/server/english-chat";

const decoder = new TextDecoder();
const state = initialEnglishProgress();
let releaseModel: () => void;
const input = { conversation_id: "session", turn_id: "turn", content: "学生证据", english_version: state.version };

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.from.mockImplementation(() => {
    const query: any = { then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve) };
    for (const method of ["select", "eq", "order"]) query[method] = () => query;
    return query;
  });
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === "begin_english_turn") return { error: null, data: { state: "acquired", lock_token: "private-lease",
      english_progress: state, user: { role: "user", content: input.content }, assistant: { role: "assistant", content: "", status: "pending" } } };
    if (name === "save_english_reply") return { error: null, data: {
      message: { role: "assistant", content: args.p_content, status: args.p_status },
      english_progress: advanceEnglishProgress(state, args.p_assessment?.achieved ?? false)
    } };
    throw new Error("Unexpected RPC");
  });
});
afterEach(() => vi.useRealTimers());

it("sends heartbeats during an actual English model wait without spending another turn or committing progress", async () => {
  mocks.generate.mockImplementation(async function* () {
    await new Promise<void>(resolve => { releaseModel = resolve; });
    yield JSON.stringify({ achieved: true, evidence: "学生证据", feedback: "当前作答已收到。" });
  });
  const response = await englishChat(new Request("https://study.example/api/english-assistant/chat"), "owner",
    input, defaultSettings, "encrypted-model-fixture");
  const reader = response.body!.getReader();
  expect(decoder.decode((await reader.read()).value)).toContain('"type":"accepted"');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(decoder.decode((await reader.read()).value)).toBe(": heartbeat\n\n");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["begin_english_turn"]);
  releaseModel();
  let received = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value);
  }
  expect(received).toContain('"type":"delta"');
  expect(received).toContain('"type":"done"');
  expect(received).not.toMatch(/private-model-test-key|private-lease|"achieved"|"evidence"/);
  expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["begin_english_turn", "save_english_reply"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops the heartbeat immediately on reader cancellation and records an interrupted turn when the model exits", async () => {
  let modelSignal!: AbortSignal;
  mocks.generate.mockImplementation(async function* (_settings, _history, signal: AbortSignal) {
    modelSignal = signal;
    await new Promise<void>(resolve => { releaseModel = resolve; });
    // This gateway ignores cancellation, so the caller must still guard the commit.
    yield JSON.stringify({ achieved: true, evidence: "学生证据", feedback: "不要提交这条回复" });
  });
  const response = await englishChat(new Request("https://study.example/api/english-assistant/chat"), "owner",
    input, defaultSettings, "encrypted-model-fixture");
  const reader = response.body!.getReader();
  await reader.read();
  await vi.advanceTimersByTimeAsync(0);
  expect(modelSignal.aborted).toBe(false);
  await reader.cancel();
  expect(modelSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  releaseModel();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_status: "failed", p_error: "interrupted", p_content: "" });
  expect(mocks.rpc.mock.calls.filter(call => call[1].p_status === "complete")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
