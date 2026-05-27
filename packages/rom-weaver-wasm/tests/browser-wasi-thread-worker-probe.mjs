import '../src/workers/browser-wasi-thread-worker.mjs';

const PROBE_CHANNEL_NAME = 'rom-weaver-thread-worker-probe-channel';
if (typeof BroadcastChannel === 'function') {
  const channel = new BroadcastChannel(PROBE_CHANNEL_NAME);
  channel.postMessage({
    type: 'thread-worker-spawned',
    url: self.location.href,
  });
  channel.close();
}
