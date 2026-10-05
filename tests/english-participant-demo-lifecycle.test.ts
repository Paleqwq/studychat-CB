import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParticipantChat } from "@/components/participant-chat";
import { deleteDemoEnglishConversation, demoEnglishCounts, demoEnglishRecord, demoEnglishSession, setDemoEnglishLearningPause } from "@/lib/english-demo";
import { englishPublicSettings } from "@/lib/english-assistant";
import { demoEnglishConfig, saveDemoEnglishConfig } from "@/lib/english-settings";
import type { RuntimeMode, SessionPayload } from "@/lib/types";

// Run the actual composer callback with persistent hook slots. DOM-only effects
// are excluded so this test can exercise asynchronous storage writes in Node.
const hooks = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0
}));
const browser = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/browser", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/browser")>(), authFetch: browser.authFetch
}));
vi.mock("react", async importOriginal => {
  const original = await importOriginal<typeof import("react")>();
  return {
    ...original,
    useEffect: () => undefined,
    useState<T>(initial: T | (() => T)) {
      const index = hooks.stateIndex++;
      if (!(index in hooks.state)) hooks.state[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.state[index], (next: T | ((value: T) => T)) => {
        hooks.state[index] = typeof next === "function" ? (next as (value: T) => T)(hooks.state[index] as T) : next;
      }];
    },
    useRef<T>(initial: T) {
      const index = hooks.refIndex++;
      if (!hooks.refs[index]) hooks.refs[index] = { current: initial };
      return hooks.refs[index];
    }
  };
});

type Node = { props: Record<string, unknown> };
function findNode(value: unknown, matches: (props: Node["props"]) => boolean): Node | undefined {
  if (Array.isArray(value)) {
    for (const child of value) { const found = findNode(child, matches); if (found) return found; }
  } else if (value && typeof value === "object" && "props" in value) {
    const node = value as Node;
    if (matches(node.props)) return node;
    return findNode(node.props.children, matches);
  }
  return undefined;
}

function render(mode: RuntimeMode = "demo") {
  hooks.stateIndex = 0; hooks.refIndex = 0;
  return ParticipantChat({ mode, requireCode: false, initialSettings: englishPublicSettings(), assistantMode: "english" });
}
function readyComposer(session: SessionPayload, text = "这是我的写作困难。", mode: RuntimeMode = "demo") {
  hooks.state[0] = session;
  hooks.state[1] = text;
  hooks.state[3] = false;
  const tree = render(mode);
  hooks.refs[6].current = session;
  const form = findNode(tree, props => typeof props.className === "string" && props.className.startsWith("composer "))!;
  return () => (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}
function pauseButton(mode: RuntimeMode = "demo") {
  return findNode(render(mode), props => props.className === "english-learning-button");
}
function click(node: Node) { (node.props.onClick as () => void)(); }
function controlResult(session: SessionPayload, turnId: string, paused: boolean) {
  const now = new Date().toISOString();
  const user = { id: crypto.randomUUID(), role: "user" as const, content: paused ? "暂停学习" : "继续学习", turn_id: turnId, status: "complete" as const, created_at: now };
  const assistant = { ...user, id: crypto.randomUUID(), role: "assistant" as const, content: paused ? "学习已暂停，当前题目与进度已保留" : "已恢复学习，请继续完成当前题目。" };
  return { user, assistant, english_progress: { ...session.english_progress!, version: session.english_progress!.version + 1 }, english_paused: paused };
}
function completedControlSession(session: SessionPayload, result: ReturnType<typeof controlResult>): SessionPayload {
  return { ...session, messages: [...session.messages, result.user, result.assistant], english_progress: result.english_progress, english_paused: result.english_paused };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
  hooks.state = []; hooks.refs = []; hooks.stateIndex = 0; hooks.refIndex = 0;
  browser.authFetch.mockReset();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});

describe("English participant learning pause lifecycle", () => {
  it("pauses a natural stop request immediately without moving the current activity", async () => {
    const session = demoEnglishSession("PAUSE001")!;
    readyComposer(session, "不想学了")();
    await vi.runAllTimersAsync();
    const paused = demoEnglishSession()!;
    expect(paused.english_paused).toBe(true);
    expect(paused.english_progress).toMatchObject({ ...session.english_progress!, version: session.english_progress!.version + 1 });
    expect(paused.conversation.locked_until).toBeNull();
    expect(paused.messages.at(-1)!.status).toBe("complete");
    const tree = render();
    expect(findNode(tree, props => props["aria-label"] === "输入消息")!.props.disabled).toBe(true);
    expect(findNode(tree, props => props["aria-label"] === "发送消息")!.props.disabled).toBe(true);
    expect(pauseButton()!.props.children).toContain("继续学习");
  });

  it("persists pause and resume buttons while preserving the current activity and the draft", async () => {
    const session = demoEnglishSession("PAUSE002")!;
    readyComposer(session);
    click(pauseButton()!); await vi.runAllTimersAsync();
    const paused = demoEnglishSession()!;
    expect(paused.english_paused).toBe(true);
    expect(paused.messages.at(-2)!.content).toBe("暂停学习");
    expect(hooks.state[1]).toBe("这是我的写作困难。");
    expect(pauseButton()!.props.children).toContain("继续学习");
    click(pauseButton()!); await vi.runAllTimersAsync();
    const resumed = demoEnglishSession()!;
    expect(resumed.english_paused).toBe(false);
    expect(resumed.english_progress).toMatchObject({ ...session.english_progress!, version: session.english_progress!.version + 2 });
    expect(resumed.messages.at(-2)!.content).toBe("继续学习");
    expect(resumed.messages).toHaveLength(session.messages.length + 4);
    expect(findNode(render(), props => props["aria-label"] === "输入消息")!.props.disabled).toBe(false);
    expect(pauseButton()!.props.children).toContain("暂停学习");
  });

  it("blocks pause and resume callbacks while a reply is generating", async () => {
    const session = demoEnglishSession("PAUSE003")!;
    readyComposer(session)();
    const count = (hooks.state[0] as SessionPayload).messages.length;
    const control = pauseButton()!;
    expect(control.props.disabled).toBe(true);
    click(control);
    expect((hooks.state[0] as SessionPayload).messages).toHaveLength(count);
    expect((hooks.state[0] as SessionPayload).english_paused).not.toBe(true);
    await vi.runAllTimersAsync();
    expect(demoEnglishSession()!.english_paused).not.toBe(true);
  });

  it("recovers an authoritative pause instead of overwriting it with a stale demo stream", async () => {
    const session = demoEnglishSession("PAUSE009")!;
    readyComposer(session)();
    vi.setSystemTime(new Date(Date.now() + 150001));
    const expired = demoEnglishSession()!;
    setDemoEnglishLearningPause(expired, true, "暂停学习", crypto.randomUUID());
    await vi.runAllTimersAsync();
    const restored = demoEnglishSession()!;
    expect(restored.english_paused).toBe(true);
    expect(restored.english_progress).toMatchObject({ ...session.english_progress!, version: session.english_progress!.version + 1 });
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(true);
    expect(String(hooks.state[4])).toContain("已恢复最新");
    expect(String(hooks.state[4])).not.toContain("已删除");
    expect(hooks.state[2]).toBe(false);
  });

  it("disables failed-response retries while paused and hides controls after course completion", () => {
    const session = demoEnglishSession("PAUSE004")!;
    session.english_paused = true;
    session.messages.push({ id: crypto.randomUUID(), role: "assistant", content: "部分回复", status: "failed", turn_id: crypto.randomUUID(), created_at: new Date().toISOString() });
    readyComposer(session);
    expect(findNode(render(), props => props.className === "retry-button")!.props.disabled).toBe(true);
    session.english_progress!.completed = true;
    hooks.state[0] = session;
    expect(pauseButton()).toBeUndefined();
  });

  it("retains administrator availability restrictions after an individual resume", async () => {
    const session = demoEnglishSession("PAUSE005")!;
    setDemoEnglishLearningPause(session, true, "暂停学习", crypto.randomUUID());
    const config = demoEnglishConfig(); config.enabled = false; saveDemoEnglishConfig(config);
    readyComposer(demoEnglishSession()!);
    click(pauseButton()!); await vi.runAllTimersAsync();
    const resumed = demoEnglishSession()!;
    expect(resumed.english_paused).toBe(false);
    expect(resumed.enabled).toBe(false);
    const tree = render();
    expect(findNode(tree, props => props["aria-label"] === "输入消息")!.props.disabled).toBe(true);
    expect(findNode(tree, props => props["aria-label"] === "发送消息")!.props.disabled).toBe(true);
    const count = resumed.messages.length;
    readyComposer(resumed)(); await vi.runAllTimersAsync();
    expect(demoEnglishSession()!.messages).toHaveLength(count);
  });

  it("recovers a committed live pause when its response was lost", async () => {
    const session = demoEnglishSession("PAUSE006")!;
    let restored: SessionPayload;
    browser.authFetch.mockImplementation(async (path: string, _identity: string, init: RequestInit = {}) => {
      if (path.endsWith("/pause")) {
        const request = JSON.parse(init.body as string) as { turn_id: string };
        restored = completedControlSession(session, controlResult(session, request.turn_id, true));
        throw new Error("连接中断");
      }
      return Response.json(restored!);
    });
    readyComposer(session, "我的回答", "live");
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(true);
    expect(hooks.state[4]).toBe("");
    expect(hooks.state[15]).toBe(false);
    expect(pauseButton("live")!.props.children).toContain("继续学习");
    expect(findNode(render("live"), props => props["aria-label"] === "发送消息")!.props.disabled).toBe(true);
  });

  it("reuses the same turn and version when a live pause must be retried", async () => {
    const session = demoEnglishSession("PAUSE007")!;
    const requests: { turn_id: string; english_version: number }[] = [];
    let restored = session;
    browser.authFetch.mockImplementation(async (path: string, _identity: string, init: RequestInit = {}) => {
      if (!path.endsWith("/pause")) return Response.json(restored);
      const request = JSON.parse(init.body as string) as { turn_id: string; english_version: number };
      requests.push(request);
      if (requests.length === 1) throw new Error("连接中断");
      const result = controlResult(session, request.turn_id, true);
      restored = completedControlSession(session, result);
      return Response.json(result);
    });
    readyComposer(session, "我的回答", "live");
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect(hooks.state[15]).toBe(true);
    expect(findNode(render("live"), props => props["aria-label"] === "输入消息")!.props.disabled).toBe(true);
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(true);
    expect((hooks.state[0] as SessionPayload).messages).toHaveLength(session.messages.length + 2);
    expect(hooks.state[15]).toBe(false);
  });

  it.each([
    { name: "a stale pause", paused: false, version: 7, error: "英语学习进度已更新，请刷新页面继续。" },
    { name: "a stale resume", paused: true, version: 7, error: "英语学习进度已更新，请刷新页面继续。" },
    { name: "a busy pause", paused: false, version: 0, error: "上一条回复仍在生成，请稍后重试。" }
  ])("unblocks $name after a rejected control is absent from authoritative history", async ({ paused, version, error }) => {
    const session = { ...demoEnglishSession("PAUSE010")!, english_paused: paused };
    const requests: { turn_id: string; english_version: number }[] = [];
    let restored: SessionPayload = { ...session, english_progress: { ...session.english_progress!, version } };
    browser.authFetch.mockImplementation(async (path: string, _identity: string, init: RequestInit = {}) => {
      if (!path.endsWith("/pause")) return Response.json(restored);
      const request = JSON.parse(init.body as string) as { turn_id: string; english_version: number };
      requests.push(request);
      if (requests.length === 1) return Response.json({ error }, { status: 409 });
      const result = controlResult(restored, request.turn_id, !paused);
      restored = completedControlSession(restored, result);
      return Response.json(result);
    });
    readyComposer(session, "我的回答", "live");
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect(hooks.state[15]).toBe(false);
    expect(hooks.refs[8].current).toBeNull();
    expect((hooks.state[0] as SessionPayload).english_progress!.version).toBe(version);
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(paused);
    expect(findNode(render("live"), props => props["aria-label"] === "输入消息")!.props.disabled).toBe(paused);
    expect(hooks.state[4]).toBe(error);
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect(requests).toHaveLength(2);
    expect(requests[1].turn_id).not.toBe(requests[0].turn_id);
    expect(requests[1].english_version).toBe(version);
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(!paused);
    expect(hooks.state[15]).toBe(false);
  });

  it("retains an uncertain server-failure control for an idempotent retry", async () => {
    const session = demoEnglishSession("PAUSE011")!;
    const requests: { turn_id: string; english_version: number }[] = [];
    let restored = session;
    browser.authFetch.mockImplementation(async (path: string, _identity: string, init: RequestInit = {}) => {
      if (!path.endsWith("/pause")) return Response.json(restored);
      const request = JSON.parse(init.body as string) as { turn_id: string; english_version: number };
      requests.push(request);
      if (requests.length === 1) return Response.json({ error: "服务暂不可用" }, { status: 503 });
      const result = controlResult(session, request.turn_id, true);
      restored = completedControlSession(session, result);
      return Response.json(result);
    });
    readyComposer(session, "我的回答", "live");
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect(hooks.state[15]).toBe(true);
    expect(findNode(render("live"), props => props["aria-label"] === "输入消息")!.props.disabled).toBe(true);
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(true);
  });

  it("preserves a live paused state when resume and history recovery both fail", async () => {
    const session = { ...demoEnglishSession("PAUSE008")!, english_paused: true };
    browser.authFetch.mockRejectedValue(new Error("网络不可用"));
    readyComposer(session, "我的回答", "live");
    click(pauseButton("live")!); await vi.runAllTimersAsync();
    expect((hooks.state[0] as SessionPayload).english_paused).toBe(true);
    expect(hooks.state[15]).toBe(true);
    expect(pauseButton("live")!.props.children).toContain("继续学习");
    expect(findNode(render("live"), props => props["aria-label"] === "输入消息")!.props.disabled).toBe(true);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("English demonstration composer leases and stale writes", () => {
  it("persists a lease before the first streamed chunk, blocks deletion during generation, and releases after completion", async () => {
    const session = demoEnglishSession("LEASE001")!;
    readyComposer(session)();
    const pending = demoEnglishRecord(session.conversation.id)!;
    expect(Date.parse(pending.conversation.locked_until!)).toBe(Date.now() + 150000);
    expect(() => deleteDemoEnglishConversation(session.conversation.id)).toThrow("仍在生成回复");
    await vi.runAllTimersAsync();
    const completed = demoEnglishRecord(session.conversation.id)!;
    expect(completed.conversation.locked_until).toBeNull();
    expect(completed.messages.at(-1)!.status).toBe("complete");
    expect(completed.english_progress.stage).toBe("objectives");
    expect(hooks.state[2]).toBe(false);
  });

  it("clears the lease on an interrupted reply while retaining the original turn for retry", async () => {
    const session = demoEnglishSession("LEASE002")!;
    readyComposer(session)();
    const turn = (hooks.state[0] as SessionPayload).messages.at(-1)!.turn_id;
    (hooks.refs[5].current as AbortController).abort();
    await vi.runAllTimersAsync();
    const failed = demoEnglishRecord(session.conversation.id)!;
    expect(failed.conversation.locked_until).toBeNull();
    expect(failed.messages.at(-1)).toMatchObject({ turn_id: turn, status: "failed" });
    expect(failed.english_progress).toEqual(session.english_progress);
    expect(hooks.state[4]).toBe("演示回复已中断。");
    expect(hooks.state[2]).toBe(false);
  });

  it("returns a stale deleted tab to registration without a second rejected write or resurrected record", async () => {
    const session = demoEnglishSession("LEASE003")!;
    const submit = readyComposer(session);
    deleteDemoEnglishConversation(session.conversation.id);
    submit();
    await vi.runAllTimersAsync();
    expect(demoEnglishRecord(session.conversation.id)).toBeNull();
    expect(Object.values(demoEnglishCounts()).reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(hooks.state[0]).toBeNull();
    expect(hooks.refs[6].current).toBeNull();
    expect(hooks.state[5]).toBe(true);
    expect(String(hooks.state[4])).toContain("重新登记");
    expect(hooks.state[2]).toBe(false);
  });

  it("does not revive an expired-lease conversation deleted while an old stream still has a pending chunk", async () => {
    const session = demoEnglishSession("LEASE004")!;
    readyComposer(session)();
    vi.setSystemTime(new Date(Date.now() + 150001));
    deleteDemoEnglishConversation(session.conversation.id);
    await vi.runAllTimersAsync();
    expect(demoEnglishRecord(session.conversation.id)).toBeNull();
    expect(demoEnglishSession()).toBeNull();
    expect(hooks.state[0]).toBeNull();
    expect(hooks.state[5]).toBe(true);
    expect(String(hooks.state[4])).toContain("重新登记");
    expect(hooks.state[2]).toBe(false);
  });
});
