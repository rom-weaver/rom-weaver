import { describe, expect, test } from "vitest";
import { sanitizeUrlText } from "../../src/lib/url-text.ts";
import { formatNoticeError, formatNoticeWarningDetails } from "../../src/presentation/errors.ts";
import { createLocalizer } from "../../src/presentation/localization/index.ts";

describe("Apply notice diagnostics", () => {
  test("keeps friendly copy separate from sanitized technical details", () => {
    const cause = Object.assign(new Error("worker failed for https://user:secret@cdn.example/file.bin?token=abc"), {
      code: "WORKER_FAILED",
      details: { workerName: "bundle-worker" },
      url: "https://user:secret@cdn.example/file.bin?token=abc",
    });
    const notice = formatNoticeError(
      new Error("bundle load failed", { cause }),
      undefined,
      "Check the bundle and retry.",
    );

    expect(notice.message).toBe("Check the bundle and retry.");
    expect(notice.technicalDetails).toContain("code=WORKER_FAILED");
    expect(notice.technicalDetails).toContain("https://cdn.example/file.bin?…");
    expect(notice.technicalDetails).not.toContain("secret");
    expect(notice.technicalDetails).not.toContain("token=abc");
  });

  test("uses the operation-specific next action even for coded failures", () => {
    const error = Object.assign(new Error("bundle source missing"), { code: "INVALID_INPUT" });
    expect(formatNoticeError(error, undefined, "Check the bundle and try again.").message).toBe(
      "Check the bundle and try again.",
    );
  });

  test("formats warning details without exposing URL queries", () => {
    const details = formatNoticeWarningDetails([
      "ignored source https://cdn.example/bundle.json?access_token=secret",
      "member warning",
    ]);

    expect(details).toContain("- ignored source https://cdn.example/bundle.json?…");
    expect(details).toContain("- member warning");
    expect(details).not.toContain("secret");
  });

  test("redacts every scheme and malformed URL payload", () => {
    const details = sanitizeUrlText(
      "javascript:alert(secret-token) data:text/plain,secret-token https://user:pass@example.test/file?token=secret#fragment https://[bad?token=secret http:/token=secret",
    );

    expect(details).not.toContain("secret-token");
    expect(details).not.toContain("pass");
    expect(details).not.toContain("token=secret");
    expect(details).not.toContain("fragment");
    expect(details).toContain("https://example.test/file?…");
    expect(details).toContain("[redacted URL]");
  });

  test("localizes action-first Apply fallback copy", () => {
    const ids = [
      "ui.apply.bundleErrorAction",
      "ui.apply.inputErrorAction",
      "ui.apply.outputErrorAction",
      "ui.apply.patchErrorAction",
    ] as const;
    const english = ids.map((id) => createLocalizer("en").message(id));
    const german = ids.map((id) => createLocalizer("de").message(id));
    const spanish = ids.map((id) => createLocalizer("es").message(id));

    expect(german).not.toEqual(english);
    expect(spanish).not.toEqual(english);
    expect(german.every((message) => message.length > 0)).toBe(true);
    expect(spanish.every((message) => message.length > 0)).toBe(true);
  });
});
