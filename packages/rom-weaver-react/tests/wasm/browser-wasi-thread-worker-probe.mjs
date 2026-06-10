const PROBE_CHANNEL_NAME = "rom-weaver-thread-worker-probe-channel";
const MAX_PROBE_PAYLOAD_EVENTS = 16;

let payloadEventCount = 0;
self.addEventListener("message", (event) => {
  if (typeof BroadcastChannel !== "function") return;
  const payload = event?.data ?? {};
  if (payload.mode !== "pool-command") return;
  if (payloadEventCount >= MAX_PROBE_PAYLOAD_EVENTS) return;
  payloadEventCount += 1;
  const channel = new BroadcastChannel(PROBE_CHANNEL_NAME);
  channel.postMessage({
    commandId: Number.isInteger(payload.commandId) ? payload.commandId : null,
    envList: Array.isArray(payload.envList) ? payload.envList.map((entry) => String(entry)) : [],
    mode: payload.mode,
    type: "thread-worker-payload",
    url: self.location.href,
  });
  channel.close();
});

import "../../src/wasm/workers/browser-wasi-thread-worker.ts";

if (typeof BroadcastChannel === "function") {
  const channel = new BroadcastChannel(PROBE_CHANNEL_NAME);
  channel.postMessage({
    type: "thread-worker-spawned",
    url: self.location.href,
  });
  channel.close();
}
