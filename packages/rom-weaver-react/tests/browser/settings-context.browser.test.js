import { expect, test, vi } from "vitest";
import { toApplyWorkflowSettings, toCreateWorkflowSettings } from "../../src/public/react/settings-context.tsx";

test("apply settings provide a default logging sink when one is not configured", () => {
  const settings = toApplyWorkflowSettings({
    logging: {
      level: "trace",
    },
  });

  expect(settings.logging?.level).toBe("trace");
  expect(typeof settings.logging?.sink).toBe("function");
  expect(() =>
    settings.logging?.sink?.({
      level: "trace",
      message: "trace-check",
      namespace: "runtime:test",
      timestamp: new Date().toISOString(),
    }),
  ).not.toThrow();
});

test("create settings keep an explicit logging sink", () => {
  const sink = vi.fn();
  const settings = toCreateWorkflowSettings(
    {
      logging: {
        level: "debug",
        sink,
      },
    },
    "output.ips",
  );

  expect(settings.logging?.level).toBe("debug");
  expect(settings.logging?.sink).toBe(sink);
});

test("apply settings preserve worker threads auto mode", () => {
  const settings = toApplyWorkflowSettings({
    workers: {
      threads: "auto",
    },
  });

  expect(settings.workers?.threads).toBe("auto");
});

test("apply settings let flat output codec overrides refresh normalized container settings", () => {
  const settings = toApplyWorkflowSettings({
    compressionProfile: "max",
    output: {
      container: {
        profile: "min",
        rvzCodec: "zstd:3",
        zipCodec: "deflate",
        zipLevel: 1,
      },
    },
    rvzCodec: "zstd:22",
    zipCodec: "zstd",
  });

  expect(settings.output?.container?.profile).toBe("max");
  expect(settings.output?.container?.rvzCodec).toBe("zstd");
  expect(settings.output?.container?.rvzCompressionLevel).toBe(22);
  expect(settings.output?.container?.zipCodec).toBe("zstd");
  expect(settings.output?.container?.zipLevel).toBe(22);
});
