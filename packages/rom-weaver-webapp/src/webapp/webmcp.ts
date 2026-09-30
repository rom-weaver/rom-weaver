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
const routes = [
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
  confirmApply: () => Promise<boolean>;
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
    tools.push(
      {
        name: "get_workflow_state",
        description: "Read the active workflow and staged Apply summary. Does not return file bytes.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => actions.getState(),
      },
      {
        name: "request_apply_patches",
        description:
          "Ask the user to approve applying the staged patches and downloading the result locally. Uses existing checksum validation. Returns whether the action started; inspect workflow state for completion.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const state = actions.getState();
          if (!["home", "patcher"].includes(state.currentView)) throw new Error("Open the Apply workflow first");
          if (state.patcherSession.pendingDownloadFileName) throw new Error("An output is already ready for download");
          const button = document.getElementById("rom-weaver-button-apply");
          if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error("Apply is not ready");
          const panel = button.closest(".workflow");
          const readSnapshot = () =>
            JSON.stringify({
              state: actions.getState(),
              revision: actions.getRevision?.(),

              controls: Array.from(panel?.querySelectorAll("input, select, textarea") ?? []).map((control) => {
                if (control instanceof HTMLInputElement) return [control.id, control.value, control.checked];
                if (control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)
                  return [control.id, control.value];
                return [];
              }),
            });
          const snapshot = readSnapshot();
          if (!(await actions.confirmApply())) return { status: "declined" };
          if (controller.signal.aborted) throw new Error("Tool registration was cancelled");
          if (readSnapshot() !== snapshot || !button.isConnected || button.disabled) {
            throw new Error("The workflow changed; review it and request approval again");
          }
          button.click();
          return { status: "started" };
        },
      },
    );
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
