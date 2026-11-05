import { describe, expect, it } from "vitest";
import { describeError, readWorkerErrorContext } from "../../src/workers/shared/error-description.ts";

const describeWorkerCrash = (error: unknown) => describeError(error, { serialize: true, stack: true });

describe("describeError", () => {
  it("returns a string error trimmed", () => {
    expect(describeError("  boom ")).toBe("boom");
  });

  it("uses an Error's message, or its stack when asked", () => {
    const error = new Error("failed");
    error.stack = "Error: failed\n    at worker";
    expect(describeError(error)).toBe("failed");
    expect(describeWorkerCrash(error)).toBe("Error: failed\n    at worker");
    error.stack = "";
    expect(describeWorkerCrash(error)).toBe("failed");
  });

  it("reads message then stack off an error-like object", () => {
    expect(describeWorkerCrash({ message: "plain message" })).toBe("plain message");
    expect(describeWorkerCrash({ message: 42, stack: "stack only" })).toBe("stack only");
  });

  it("appends a reported error's command and stage when asked", () => {
    const record = { context: { command: "extract", stage: "list" }, message: "bad entry" };
    expect(describeError(record)).toBe("bad entry");
    expect(describeError(record, { context: true })).toBe("bad entry (command=extract, stage=list)");
    expect(describeError({ kind: "validation" }, { context: true })).toBe("rom-weaver error (validation)");
  });

  it("describes an ErrnoError by its errno", () => {
    expect(describeWorkerCrash({ errno: 2, name: "ErrnoError" })).toBe(
      "Worker filesystem file not found while preparing disc output.",
    );
    expect(describeWorkerCrash({ errno: "13", name: "ErrnoError" })).toBe(
      "Worker filesystem error 13 while preparing disc output.",
    );
  });

  it("serializes an unrecognized object only when asked", () => {
    expect(describeWorkerCrash({ code: 7, name: "ErrnoError" })).toBe('{"code":7,"name":"ErrnoError"}');
    expect(describeWorkerCrash({ detail: "unstructured" })).toBe('{"detail":"unstructured"}');
    expect(describeError({ detail: "unstructured" })).toBe("");
  });

  it("falls back to String() when the object cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeWorkerCrash(circular)).toBe("[object Object]");
  });

  it("returns nothing for falsy throws and stringifies truthy primitives", () => {
    expect(describeWorkerCrash(null)).toBe("");
    expect(describeWorkerCrash(undefined)).toBe("");
    expect(describeWorkerCrash(0)).toBe("");
    expect(describeWorkerCrash(404)).toBe("404");
    expect(describeWorkerCrash(true)).toBe("true");
  });
});

describe("readWorkerErrorContext", () => {
  it("prefers the nested context and falls back to the record's own fields", () => {
    expect(readWorkerErrorContext({ command: "trim", context: { stage: "probe" }, format: null })).toEqual({
      command: "trim",
      family: undefined,
      format: null,
      stage: "probe",
    });
    expect(readWorkerErrorContext({ message: "x" })).toBeUndefined();
    expect(readWorkerErrorContext("x")).toBeUndefined();
  });
});
