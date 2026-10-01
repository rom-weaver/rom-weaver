import { useLayoutEffect, useRef } from "react";

export type AgentWorkflow = {
  getState: () => Record<string, unknown>;
  actions: Record<string, { description: string; enabled: boolean; execute: () => unknown }>;
};
const workflows = new Map<string, AgentWorkflow>();
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;

export function describeAgentSource(source: unknown) {
  if (source === null || typeof source !== "object") return null;
  let id = sourceIds.get(source);
  if (id === undefined) {
    id = ++nextSourceId;
    sourceIds.set(source, id);
  }
  const value = source as Record<string, unknown>;
  return {
    id,
    name: typeof value.name === "string" ? value.name : value.fileName,
    size: typeof value.size === "number" ? value.size : value.byteLength,
  };
}

export function getAgentWorkflow(view: string) {
  return workflows.get(view);
}

export function useAgentWorkflow(view: string, workflow: AgentWorkflow) {
  const current = useRef(workflow);
  current.current = workflow;
  useLayoutEffect(() => {
    const adapter: AgentWorkflow = {
      getState: () => current.current.getState(),
      get actions() {
        return current.current.actions;
      },
    };
    workflows.set(view, adapter);
    return () => {
      if (workflows.get(view) === adapter) workflows.delete(view);
    };
  }, [view]);
}
