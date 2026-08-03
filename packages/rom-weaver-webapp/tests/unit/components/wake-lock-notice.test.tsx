// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScreenWakeLock } from "../../../src/webapp/components/wake-lock-notice.tsx";

type WakeLockNavigator = Navigator & {
  wakeLock?: unknown;
};

const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");

const installWakeLock = () => {
  const sentinel = {
    release: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  };
  const request = vi.fn().mockResolvedValue(sentinel);
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
  return { request, sentinel };
};

afterEach(() => {
  if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
  else delete (navigator as WakeLockNavigator).wakeLock;
});

describe("useScreenWakeLock", () => {
  it("holds the lock until pending work ends", async () => {
    const { request, sentinel } = installWakeLock();
    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    });

    await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    expect(sentinel.release).not.toHaveBeenCalled();

    rerender({ active: false });
    await waitFor(() => expect(sentinel.release).toHaveBeenCalledOnce());
  });
});
