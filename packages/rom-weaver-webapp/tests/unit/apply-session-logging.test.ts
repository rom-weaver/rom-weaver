import { afterEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));
vi.mock("../../src/lib/logging.ts", () => ({ createLogger: () => logger }));

import { logUiError } from "../../src/public/react/apply-session-logging.ts";

const codedError = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe("logUiError", () => {
  afterEach(() => vi.clearAllMocks());

  it("logs real failures as errors", () => {
    logUiError("Input staging failed", codedError("boom", "INVALID_INPUT"));
    expect(logger.error).toHaveBeenCalledWith(
      "Input staging failed",
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("logs a cancelled picker selection at debug level", () => {
    logUiError("Patch staging failed", codedError("Selection skipped", "WORKFLOW_SELECTION_SKIPPED"));
    expect(logger.debug).toHaveBeenCalledWith(
      "Patch staging failed",
      expect.objectContaining({ code: "WORKFLOW_SELECTION_SKIPPED" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
