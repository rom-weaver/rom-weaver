// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { describeAgentSource, useAgentWorkflow } from "../../src/webapp/agent/workflow-registry.ts";
import { installWebMcp } from "../../src/webapp/webmcp.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  Reflect.deleteProperty(navigator, "modelContext");
  document.body.replaceChildren();
});

function setup(
  confirmAction = vi.fn().mockResolvedValue(true),
  view = "compress",
  confirmApply: () => Promise<boolean> = async () => false,
) {
  const tools = new Map<string, { execute: (input: unknown) => unknown }>();
  Object.defineProperty(navigator, "modelContext", {
    configurable: true,
    value: {
      registerTool: (tool: { name: string; execute: (input: unknown) => unknown }) => tools.set(tool.name, tool),
    },
  });
  cleanups.push(
    installWebMcp({
      getState: () => ({ currentView: view, patcherSession: { pendingDownloadFileName: null } }),
      confirmApply,
      confirmAction,
    }),
  );
  return {
    call: (name: string, input: unknown = {}) => tools.get(name)?.execute(input),
    state: () =>
      tools.get("get_workflow_state")?.execute({}) as {
        revision: string;
        fields: { key: string; label: string; value: unknown }[];
      },
    confirmAction,
  };
}

test("lists all workflows and rejects same-name source replacement during approval", async () => {
  let source = new File(["first"], "game.bin");
  const execute = vi.fn();
  const confirm = vi.fn(async () => {
    source = new File(["other"], "game.bin");
    return true;
  });
  const { unmount } = renderHook(() =>
    useAgentWorkflow("compress", {
      getState: () => ({ source: describeAgentSource(source) }),
      actions: { run: { description: "Compress", enabled: true, execute } },
    }),
  );
  cleanups.push(unmount);
  const tools = setup(confirm);
  expect(tools.call("list_workflows")).toHaveLength(11);
  await expect(
    tools.call("request_workflow_action", { revision: tools.state().revision, action: "run" }),
  ).rejects.toThrow("workflow changed");
  expect(execute).not.toHaveBeenCalled();
});

test("declined and concurrent approvals never dispatch an action", async () => {
  const execute = vi.fn();
  const { unmount } = renderHook(() =>
    useAgentWorkflow("compress", {
      getState: () => ({ source: null }),
      actions: { run: { description: "Compress", enabled: true, execute } },
    }),
  );
  cleanups.push(unmount);
  let resolveApproval: (approved: boolean) => void = () => undefined;
  const tools = setup(
    vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveApproval = resolve;
        }),
    ),
  );
  const request = { revision: tools.state().revision, action: "run" };
  const pending = tools.call("request_workflow_action", request);
  await expect(tools.call("request_workflow_action", request)).rejects.toThrow("pending approval");
  resolveApproval(false);
  expect(await pending).toEqual({ status: "declined" });
  expect(execute).not.toHaveBeenCalled();
});

test("configures native fields, enforces constraints and rejects stale field keys", async () => {
  const { unmount } = renderHook(() => useAgentWorkflow("compress", { getState: () => ({}), actions: {} }));
  cleanups.push(unmount);
  document.body.innerHTML = `<section id="panel-compress"><label>Name<input maxlength="8" value="old"></label><label>Format<select><option value="zip">ZIP</option><option value="7z" disabled>7z</option></select></label><label>Verify<input type="checkbox"></label><input type="file"></section><section id="panel-trim" hidden><input value="inactive"></section>`;
  const inputEvent = vi.fn();
  document.querySelector("input")?.addEventListener("input", inputEvent);
  const tools = setup();
  const first = tools.state();
  expect(first.fields).toHaveLength(4);
  await tools.call("configure_workflow", { revision: first.revision, field: "field-0", value: "next" });
  expect(inputEvent).toHaveBeenCalledOnce();
  expect(tools.state().fields[0].value).toBe("next");
  await expect(
    tools.call("configure_workflow", { revision: first.revision, field: "field-0", value: "stale" }),
  ).rejects.toThrow("workflow changed");
  await expect(
    tools.call("configure_workflow", { revision: tools.state().revision, field: "field-0", value: "too long name" }),
  ).rejects.toThrow("maximum length");
  await expect(
    tools.call("configure_workflow", { revision: tools.state().revision, field: "field-1", value: "7z" }),
  ).rejects.toThrow("disabled option");
  await tools.call("configure_workflow", { revision: tools.state().revision, field: "field-2", value: true });
  expect(tools.state().fields[2].value).toBe(true);
  await expect(
    tools.call("configure_workflow", { revision: tools.state().revision, field: "field-3", value: "/private/file" }),
  ).rejects.toThrow("read-only");
});

test("dispatches existing portal choice handlers after approval and unregisters adapters", async () => {
  const { unmount } = renderHook(() => useAgentWorkflow("compress", { getState: () => ({}), actions: {} }));
  document.body.innerHTML = `<div class="rw-app"><section id="panel-compress"></section><div role="dialog"><div role="option">Choose codec</div></div></div>`;
  const option = document.querySelector('[role="option"]');
  const selected = vi.fn();
  option?.addEventListener("mousedown", selected);
  const tools = setup();
  expect(
    await tools.call("request_workflow_action", { revision: tools.state().revision, action: "control-0" }),
  ).toEqual({ status: "dispatched", workflow: "compress" });
  expect(selected).toHaveBeenCalledOnce();
  act(unmount);
  expect(() => tools.state()).toThrow("wait for its form");
});

test("progress updates do not invalidate approval to cancel the same operation", async () => {
  let percent = 10;
  const execute = vi.fn();
  const { unmount } = renderHook(() =>
    useAgentWorkflow("compress", {
      getState: () => ({ busy: true, pendingArchives: [{ id: "archive", percent }], progress: { percent } }),
      actions: { cancel: { description: "Cancel", enabled: true, execute } },
    }),
  );
  cleanups.push(unmount);
  const tools = setup(
    vi.fn(async () => {
      percent = 30;
      return true;
    }),
  );
  expect(await tools.call("request_workflow_action", { revision: tools.state().revision, action: "cancel" })).toEqual({
    status: "dispatched",
    workflow: "compress",
  });
  expect(execute).toHaveBeenCalledOnce();
});

test("legacy Apply rejects same-name source replacement during approval", async () => {
  let source = new File(["first"], "game.bin");
  const { unmount } = renderHook(() =>
    useAgentWorkflow("patcher", {
      getState: () => ({ source: describeAgentSource(source) }),
      actions: {},
    }),
  );
  cleanups.push(unmount);
  document.body.innerHTML = '<section class="workflow"><button id="rom-weaver-button-apply">Apply</button></section>';
  const clicked = vi.fn();
  document.querySelector("button")?.addEventListener("click", clicked);
  const tools = setup(vi.fn(), "patcher", async () => {
    source = new File(["other"], "game.bin");
    return true;
  });
  await expect(tools.call("request_apply_patches")).rejects.toThrow("workflow changed");
  expect(clicked).not.toHaveBeenCalled();
});
