import "server-only";

// SSE comments keep idle model/commit waits alive without becoming student events.
export function createSseWriter<Event>(controller: ReadableStreamDefaultController<Uint8Array>,
  { signal, onDisconnect, heartbeatMs = 10_000 }: {
    signal: AbortSignal; onDisconnect: () => void; heartbeatMs?: number;
  }) {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopHeartbeat = () => {
    clearTimeout(timer);
    timer = undefined;
    signal.removeEventListener("abort", stopHeartbeat);
  };
  const disconnect = () => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    onDisconnect();
  };
  const write = (text: string) => {
    if (closed) return false;
    try { controller.enqueue(encoder.encode(text)); return true; }
    catch { disconnect(); return false; }
  };
  const scheduleHeartbeat = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!signal.aborted && write(": heartbeat\n\n")) scheduleHeartbeat();
    }, heartbeatMs);
    timer.unref?.();
  };
  if (!signal.aborted) signal.addEventListener("abort", stopHeartbeat, { once: true });
  scheduleHeartbeat();
  return {
    emit(event: Event) {
      if (write("data: " + JSON.stringify(event) + "\n\n")) scheduleHeartbeat();
    },
    close() {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      try { controller.close(); } catch { /* A cancelled reader already closed it. */ }
    },
    cancel: disconnect
  };
}
