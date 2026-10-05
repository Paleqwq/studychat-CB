import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseWriter } from "@/lib/server/sse-writer";
import { parseSse } from "@/lib/sse";

const decoder = new TextDecoder();

function channel() {
  const abort = new AbortController();
  const onDisconnect = vi.fn(() => abort.abort());
  let writer!: ReturnType<typeof createSseWriter<{ type: string; text?: string }>>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { writer = createSseWriter(controller, { signal: abort.signal, onDisconnect }); },
    cancel() { writer.cancel(); }
  });
  return { abort, onDisconnect, writer, stream };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SSE transport heartbeat lifecycle", () => {
  it("keeps a silent connection alive every ten seconds with SSE comments", async () => {
    const { writer, stream } = channel();
    const reader = stream.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(decoder.decode((await first).value)).toBe(": heartbeat\n\n");
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decoder.decode((await next).value)).toBe(": heartbeat\n\n");
    writer.close();
    expect(vi.getTimerCount()).toBe(0);
    expect((await reader.read()).done).toBe(true);
  });

  it("waits ten seconds after an application event before the next heartbeat", async () => {
    const { writer, stream } = channel();
    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(9_000);
    writer.emit({ type: "delta", text: "中文" });
    expect(decoder.decode((await reader.read()).value)).toBe('data: {"type":"delta","text":"中文"}\n\n');
    let received = false;
    const pending = reader.read().then(chunk => { received = true; return chunk; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(received).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(decoder.decode((await pending).value)).toBe(": heartbeat\n\n");
    writer.close();
  });

  it("stops on abort while still allowing the existing safe error event and close", async () => {
    const { writer, stream, abort, onDisconnect } = channel();
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
    writer.emit({ type: "error", text: "回复已中断" });
    expect(vi.getTimerCount()).toBe(0);
    writer.close(); writer.close();
    expect(onDisconnect).not.toHaveBeenCalled();
    const response = await new Response(stream).text();
    expect(response).toContain('"type":"error"');
    expect(response).not.toContain("heartbeat");
  });

  it("cleans cancellation immediately even when its producer has not returned", async () => {
    const { writer, stream, abort, onDisconnect } = channel();
    const reader = stream.getReader();
    await reader.cancel();
    expect(abort.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(() => { writer.emit({ type: "done" }); writer.close(); writer.cancel(); }).not.toThrow();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("turns an already closed controller into one disconnect without throwing", async () => {
    const abort = new AbortController();
    const onDisconnect = vi.fn(() => abort.abort());
    let writer!: ReturnType<typeof createSseWriter<{ type: string }>>;
    new ReadableStream<Uint8Array>({ start(controller) {
      writer = createSseWriter(controller, { signal: abort.signal, onDisconnect });
      controller.close();
    } });
    await vi.advanceTimersByTimeAsync(10_000);
    writer.emit({ type: "done" }); writer.close();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never turns heartbeat comments into application data in the existing parser", async () => {
    const { writer, stream } = channel();
    const parsed: string[] = [];
    const reading = (async () => { for await (const data of parseSse(stream)) parsed.push(data); })();
    writer.emit({ type: "accepted" });
    await vi.advanceTimersByTimeAsync(20_000);
    writer.emit({ type: "done", text: "作答已收到。" });
    writer.close();
    await reading;
    expect(parsed.map(data => JSON.parse(data))).toEqual([
      { type: "accepted" }, { type: "done", text: "作答已收到。" }
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
