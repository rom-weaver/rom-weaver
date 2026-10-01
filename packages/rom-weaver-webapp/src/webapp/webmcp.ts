import { getAgentWorkflow } from "./agent/workflow-registry.ts";
import { configureWorkflowControl, executeWorkflowControl, getWorkflowControls } from "./agent/workflow-controls.ts";
import { createLogger } from "../lib/logging.ts";
import { ROM_WEAVER_FORMAT_METADATA } from "../wasm/generated/rom-weaver-format-metadata.ts";
import { DOC_SOURCES } from "./docs-routing.mjs";
import { WORKFLOW_SEO_ROUTES } from "./workflow-seo.mjs";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => unknown;
};
type ModelContext = {
  registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void>;
  unregisterTool?: (name: string) => void;
};
const logger = createLogger("webmcp");
const progressKeys = new Set(["progress", "percent", "timingText", "throughputText"]);
const approvalSnapshotReplacer = (key: string, value: unknown) => (progressKeys.has(key) ? undefined : value);
const workflowPages = {
  patcher: "apply-patches",
  creator: "create-patch",
  bundle: "bundle-patches",
  compress: "compress",
  extract: "extract",
  checksum: "checksum",
  identify: "identify-rom",
  trim: "trim-rom",
  "ppf-undo": "ppf-undo",
  "save-editor": "save-editor",
  test: "test-rom",
};
const routes = [
  ...["trim-rom", "ppf-undo", "save-editor"].map((slug) => ({
    slug,
    title: slug,
    description: "Beta browser workflow",
  })),
  ...Object.values(WORKFLOW_SEO_ROUTES).map(({ slug, title, description }) => ({ slug, title, description })),
  ...DOC_SOURCES.map(({ slug, label }) => ({ slug, title: label, description: label })),
];
const stringArgument = (input: unknown, key: string): string => {
  if (typeof input !== "object" || input === null || !(key in input)) throw new Error(`Missing ${key}`);
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length > 500) throw new Error(`Invalid ${key}`);
  return value;
};

type WorkflowActions = {
  getState: () => { currentView: string; patcherSession: { pendingDownloadFileName: string | null } };
  confirmAction?: (description: string) => Promise<boolean>;
  openBetaWorkflow?: (view: string) => void;
  getRevision?: () => string;
};

export function installWebMcp(actions?: WorkflowActions) {
  const context =
    (document as Document & { modelContext?: ModelContext }).modelContext ??
    (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
  if (!context?.registerTool) return () => undefined;
  const controller = new AbortController();
  const tools: Tool[] = [
    {
      name: "search_site",
      description: "Search rom-weaver workflow and documentation titles. Returns matching page URLs and descriptions.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 500 } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: (input) => {
        const query = stringArgument(input, "query").trim().toLowerCase();
        return routes
          .filter((route) => `${route.title} ${route.description}`.toLowerCase().includes(query))
          .slice(0, 20)
          .map((route) => ({ ...route, url: new URL(`/${route.slug}`, location.origin).href }));
      },
    },
    {
      name: "navigate_site",
      description:
        "Open a rom-weaver workflow or documentation page by slug. Uses the site's normal navigation and preserves local files.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string", enum: routes.map((route) => route.slug) } },
        required: ["slug"],
        additionalProperties: false,
      },
      execute: (input) => {
        const slug = stringArgument(input, "slug");
        if (!routes.some((route) => route.slug === slug)) throw new Error("Unknown page slug");
        const betaView = Object.entries(workflowPages).find(
          ([view, route]) => ["trim", "ppf-undo", "save-editor"].includes(view) && route === slug,
        )?.[0];
        if (betaView && actions?.openBetaWorkflow) {
          actions.openBetaWorkflow(betaView);
          return { url: location.href };
        }
        const anchor = document.createElement("a");
        anchor.href = `/${slug}`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        return { url: location.href };
      },
    },
    {
      name: "get_supported_formats",
      description: "Retrieve rom-weaver's supported format metadata for patches, archives, and ROM containers.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ROM_WEAVER_FORMAT_METADATA,
    },
  ];
  if (actions)
    tools.push({
      name: "get_workflow_state",
      description: "Read the active workflow and staged Apply summary. Does not return file bytes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => actions.getState(),
    });
  if (actions?.confirmAction) {
    let revision = 0;
    let previousSnapshot = "";
    let approvalPending = false;
    const activeWorkflow = () => {
      const view = actions.getState().currentView;
      const adapter = getAgentWorkflow(view);
      if (!adapter) throw new Error("Open a workflow and wait for its form to load first");
      return { view, adapter };
    };
    const readState = () => {
      const { view, adapter } = activeWorkflow();
      const controls = getWorkflowControls(view);
      const fields = controls.fields.map(({ element: _element, ...field }) => field);
      const availableActions = [
        ...Object.entries(adapter.actions).map(([key, action]) => ({
          key,
          description: action.description,
          enabled: action.enabled && !controls.modalOpen,
        })),
        ...controls.buttons.map(({ element: _element, ...action }) => action),
      ];
      const state = adapter.getState();
      const snapshot = JSON.stringify(
        {
          view,
          state,
          fields,
          actions: availableActions.map(({ key, enabled }) => ({ key, enabled })),
          settings: actions.getRevision?.(),
        },
        approvalSnapshotReplacer,
      );
      if (snapshot !== previousSnapshot) {
        previousSnapshot = snapshot;
        revision += 1;
      }
      return { workflow: view, revision: String(revision), state, fields, actions: availableActions };
    };
    const checkRevision = (input: unknown) => {
      const expected = stringArgument(input, "revision");
      const state = readState();
      if (state.revision !== expected) throw new Error("The workflow changed; read its state and try again");
      return state;
    };
    const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    tools.push(
      {
        name: "list_workflows",
        description:
          "List all eleven browser file workflows, including beta tools. Navigate to a workflow before reading or configuring it. Files must be selected by the user and stay on this device.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () =>
          Object.entries(workflowPages).map(([workflow, slug]) => ({
            workflow,
            slug,
            url: new URL(`/${slug}`, location.origin).href,
          })),
      },
      {
        name: "configure_workflow",
        description:
          "Set one editable field in the active browser workflow through its existing form handler. Read get_workflow_state for field keys, types, constraints and options. User-selected files cannot be supplied through JSON. Re-read state after each change.",
        inputSchema: {
          type: "object",
          properties: {
            revision: { type: "string" },
            field: { type: "string" },
            value: { anyOf: [{ type: "string", maxLength: 100000 }, { type: "boolean" }] },
          },
          required: ["revision", "field", "value"],
          additionalProperties: false,
        },
        execute: async (input) => {
          if (controller.signal.aborted) throw new Error("Tool registration was cancelled");
          if (approvalPending) throw new Error("Wait for the pending approval first");
          const state = checkRevision(input);
          if (typeof input !== "object" || input === null || !("value" in input)) throw new Error("Missing value");
          configureWorkflowControl(state.workflow, stringArgument(input, "field"), input.value);
          await settle();
          return readState();
        },
      },
      {
        name: "request_workflow_action",
        description:
          "Ask the user to approve an action in the active browser workflow, including run, download, cancel, selections and existing safety dialogs. Read get_workflow_state for action keys and readiness. Returns dispatched or declined; read state for progress, errors and output readiness.",
        inputSchema: {
          type: "object",
          properties: { revision: { type: "string" }, action: { type: "string" } },
          required: ["revision", "action"],
          additionalProperties: false,
        },
        execute: async (input) => {
          if (controller.signal.aborted) throw new Error("Tool registration was cancelled");
          if (approvalPending) throw new Error("Wait for the pending approval first");
          const state = checkRevision(input);
          const key = stringArgument(input, "action");
          const action = state.actions.find((item) => item.key === key);
          if (!action?.enabled) throw new Error("The workflow action is unavailable or disabled");
          const { adapter } = activeWorkflow();
          approvalPending = true;
          try {
            if (!(await actions.confirmAction?.(action.description))) return { status: "declined" };
            await settle();
            if (controller.signal.aborted) throw new Error("Tool registration was cancelled");
            if (readState().revision !== state.revision || activeWorkflow().adapter !== adapter)
              throw new Error("The workflow changed; read its state and request approval again");
            const callback = adapter.actions[key];
            if (callback) {
              if (!callback.enabled) throw new Error("The workflow action is no longer ready");
              void Promise.resolve(callback.execute()).catch((error: unknown) =>
                logger.warn("Workflow action failed", {
                  workflow: state.workflow,
                  action: key,
                  message: String(error),
                }),
              );
            } else executeWorkflowControl(state.workflow, key);
            await settle();
            return { status: "dispatched", workflow: state.workflow };
          } finally {
            approvalPending = false;
          }
        },
      },
    );
    const stateTool = tools.find((tool) => tool.name === "get_workflow_state");
    if (stateTool) {
      stateTool.description =
        "Read the active browser workflow's source identities, configuration fields, constraints, available actions, progress, errors and results without file bytes. Use its revision for configuration and action requests. Gameplay inside EmulatorJS is controlled by the user.";
      stateTool.execute = () => readState();
    }
  }
  for (const tool of tools) {
    try {
      void Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch((error: unknown) => {
        logger.warn("Tool registration failed", { name: tool.name, message: String(error) });
      });
    } catch (error) {
      logger.warn("Tool registration failed", { name: tool.name, message: String(error) });
    }
  }
  // Older navigator implementations MUST unregister explicitly because they ignore registration signals.
  controller.signal.addEventListener(
    "abort",
    () => {
      for (const tool of tools) {
        try {
          context.unregisterTool?.(tool.name);
        } catch (error) {
          logger.debug("Tool cleanup failed", { name: tool.name, message: String(error) });
        }
      }
    },
    { once: true },
  );
  let restoredCleanup: (() => void) | undefined;
  const suspend = () => controller.abort();
  const cleanup = () => {
    controller.abort();
    window.removeEventListener("pagehide", suspend);
    window.removeEventListener("pageshow", restore);
    restoredCleanup?.();
    restoredCleanup = undefined;
  };
  const restore = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    cleanup();
    restoredCleanup = installWebMcp(actions);
  };
  window.addEventListener("pagehide", suspend, { once: true });
  window.addEventListener("pageshow", restore);
  return cleanup;
}
