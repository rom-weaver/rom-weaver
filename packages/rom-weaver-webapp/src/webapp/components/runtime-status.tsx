import { Cloud, CloudOff, LoaderCircle, MonitorCheck, MonitorOff, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Localizer } from "../../presentation/localization/index.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";
import { join } from "./shell-common.tsx";

/**
 * The prerendered shells ship a placeholder runtime status that the parser-time
 * resolver in `index.html` rewrites before React loads - that is what stops the
 * value visibly changing at hydration. The resolver decides synchronously, from
 * the isolation flag and `navigator.serviceWorker.controller`; the store's
 * status arrives from an async registration and reads "off" until it lands.
 *
 * So the first render has to answer the way the resolver already did, or React
 * hydrates "sw off" against the DOM's "sw", throws, and discards the server
 * HTML for the whole page. Keep this in step with the resolver in `index.html`.
 */
const readResolvedServiceWorkerStatus = (): ServiceWorkerStatus | null => {
  if (typeof document === "undefined" || typeof navigator === "undefined") return null;
  const enabled = document.documentElement.dataset.serviceWorkerEnabled === "true";
  const serviceWorker = navigator.serviceWorker;
  if (!(enabled && serviceWorker)) return "off";
  // A controller alone is not "ready" any more: the offline copy also needs the
  // background warm-up (EmulatorJS + identify packs). The warm-up client
  // persists completion under this key; the resolver in `index.html` reads the
  // same key and MUST stay in step.
  let warmupReady = false;
  try {
    warmupReady = localStorage.getItem("rom-weaver-offline-ready") === "true";
  } catch {
    warmupReady = false;
  }
  if (serviceWorker.controller && warmupReady) return typeof MessageChannel === "function" ? "active" : "ready";
  return null;
};

const useHydratedServiceWorkerStatus = (status: ServiceWorkerStatus | null | undefined) => {
  const [resolved] = useState(readResolvedServiceWorkerStatus);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? status : resolved;
};

/**
 * The runtime status control and its dialog share these states in display order.
 * A controlling worker or a ready cache does not prove that this document was served from cache.
 */
type RuntimeState = "active" | "ready" | "update" | "installing" | "disabled" | "online";

const RUNTIME_STATES: readonly RuntimeState[] = ["active", "ready", "update", "installing", "online", "disabled"];

const RUNTIME_MESSAGES: Record<RuntimeState, { label: MessageId; description: MessageId }> = {
  active: { description: "ui.runtime.activeDesc", label: "ui.runtime.active" },
  disabled: { description: "ui.runtime.disabledDesc", label: "ui.runtime.disabled" },
  installing: { description: "ui.runtime.installingDesc", label: "ui.runtime.installing" },
  online: { description: "ui.runtime.offlineDisabledDetail", label: "ui.runtime.offlineDisabled" },
  ready: { description: "ui.runtime.readyDesc", label: "ui.runtime.ready" },
  update: { description: "ui.runtime.updateDesc", label: "ui.runtime.update" },
};
const HEADER_RUNTIME_MESSAGES: Record<RuntimeState, MessageId> = {
  active: "ui.runtime.headerReady",
  ready: "ui.runtime.headerReady",
  update: "ui.runtime.headerUpdate",
  installing: "ui.runtime.headerDownloading",
  online: "ui.runtime.headerDisabled",
  disabled: "ui.runtime.headerUnsupported",
};

/** Byte progress of the background offline warm-up, when the page knows it. */
type OfflineWarmupDisplayProgress = {
  cachedBytes: number;
  /** Files already cached (EmulatorJS files and identify packs counted individually). */
  cachedFiles?: number;
  /** Human description of the unit the progress event is about. */
  detail?: { kind: string; name: string } | null;
  /**
   * The install stage that emitted these combined precache and warm-up totals.
   */
  phase?: "precache" | "warmup";
  ready: boolean;
  totalBytes: number;
  totalFiles?: number;
  /** Measured encoded bytes transferred for cached offline target files. */
  transferredBytes?: number;
  /** One or more cached target files have no measured encoded size. */
  transferBytesIncomplete?: boolean;
  /** Warm-up unit label, e.g. "emulatorjs:loader.js" or "identify-group:<id>". */
  unit?: string | null;
  /** Bytes of the in-flight unit downloaded so far; null/absent outside a download. */
  unitLoadedBytes?: number | null;
  unitTotalBytes?: number | null;
};

/**
 * Whole percent for an incomplete install; null when no total is known yet.
 * Both install stages report the same combined byte totals - the app's own
 * precache plus the warm-up set - so one percentage covers the whole install.
 * Entry counts are the fallback for a build with no precache size map (dev, or
 * a host still serving an older bundle).
 */
const offlineWarmupPercent = (progress: OfflineWarmupDisplayProgress | null): number | null => {
  if (!progress || progress.ready) return null;
  const wholePercent = (done: number, total: number) => Math.min(99, Math.floor((done / total) * 100));
  if (progress.totalBytes > 0) return wholePercent(progress.cachedBytes, progress.totalBytes);
  if (typeof progress.totalFiles === "number" && progress.totalFiles > 0) {
    return wholePercent(progress.cachedFiles ?? 0, progress.totalFiles);
  }
  return null;
};

/**
 * Human wording for a warm-up unit, for the status detail line. Prefers the
 * structured detail (which carries a group's display label); falls back to
 * parsing the internal unit label.
 */
const describeWarmupUnit = (
  localizer: { message: (id: MessageId, values?: Record<string, unknown>) => string },
  progress: Pick<OfflineWarmupDisplayProgress, "detail" | "unit"> | null | undefined,
): string | null => {
  let kind = progress?.detail?.kind;
  let name = progress?.detail?.name;
  if (!(kind && name)) {
    const unit = progress?.unit;
    if (typeof unit !== "string" || !unit) return null;
    const separator = unit.indexOf(":");
    if (separator < 0) return null;
    kind = unit.slice(0, separator);
    name = unit.slice(separator + 1);
  }
  if (!name) return null;
  if (kind === "emulatorjs") return localizer.message("ui.runtime.detailEmulatorFile", { name });
  if (kind === "identify-group") return localizer.message("ui.runtime.detailIdentifyGroup", { name });
  return null;
};

/**
 * A pending update takes priority over cache readiness.
 * Offline readiness also requires EmulatorJS and the required or selected identify groups to finish caching.
 */
const resolveRuntimeState = (
  status: ServiceWorkerStatus | null | undefined,
  updateReady: boolean,
  offlineProgress: OfflineWarmupDisplayProgress | null = null,
  offlineCopyEnabled = true,
): RuntimeState => {
  if (updateReady) return "update";
  if (status === "off") return "disabled";
  if (!offlineCopyEnabled) return "online";
  if ((status === "active" || status === "ready") && !offlineProgress?.ready) return "installing";
  if (status === "active") return "active";
  if (status === "ready") return "ready";
  return "installing";
};

/**
 * The install wording on its own. Callers that print the percent in their own
 * element MUST use this rather than {@link installingRuntimeLabel}, or the page
 * states the same percentage twice.
 */
const installingRuntimeWording = (
  localizer: { message: (id: MessageId, values?: Record<string, unknown>) => string },
  offlineProgress: OfflineWarmupDisplayProgress | null,
) => localizer.message(offlineProgress?.phase === "precache" ? "ui.runtime.installingApp" : "ui.runtime.installing");

/** The install wording with the percent folded in, for a single-string caller. */
const installingRuntimeLabel = (
  localizer: { message: (id: MessageId, values?: Record<string, unknown>) => string },
  offlineProgress: OfflineWarmupDisplayProgress | null,
) => {
  const percent = offlineWarmupPercent(offlineProgress);
  if (percent === null) return installingRuntimeWording(localizer, offlineProgress);
  return localizer.message(
    offlineProgress?.phase === "precache" ? "ui.runtime.installingAppProgress" : "ui.runtime.installingProgress",
    { percent },
  );
};

const RUNTIME_ICONS = {
  active: MonitorCheck,
  disabled: MonitorOff,
  installing: LoaderCircle,
  online: CloudOff,
  ready: MonitorCheck,
  update: RefreshCw,
} satisfies Record<RuntimeState, typeof Cloud>;

const PROGRESS_RING_RADIUS = 10;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

/** Determinate ring on the Lucide 24-box: the arc fills clockwise from 12 o'clock. */
const ProgressRingGlyph = ({ percent }: { percent: number }) => {
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * PROGRESS_RING_CIRCUMFERENCE;
  return (
    <svg
      aria-hidden="true"
      className="sw-progress-ring"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" opacity="0.5" r={PROGRESS_RING_RADIUS} />
      <circle
        cx="12"
        cy="12"
        r={PROGRESS_RING_RADIUS}
        strokeDasharray={`${filled} ${PROGRESS_RING_CIRCUMFERENCE - filled}`}
        strokeDashoffset={PROGRESS_RING_CIRCUMFERENCE / 4}
        strokeLinecap="round"
      />
      <text
        className="sw-progress-ring-text"
        dominantBaseline="central"
        fontFamily="inherit"
        fontSize="8.5"
        fontWeight="800"
        textAnchor="middle"
        x="12"
        y="12"
      >
        {Math.round(percent)}
      </text>
    </svg>
  );
};

const RuntimeGlyph = ({ state, percent = null }: { state: RuntimeState; percent?: number | null }) => {
  if (state === "installing" && typeof percent === "number") {
    return <ProgressRingGlyph percent={percent} />;
  }
  const Icon = RUNTIME_ICONS[state];
  return <Icon aria-hidden="true" strokeWidth={2.4} />;
};

/** The parser-time resolver MUST keep the status and text hooks in sync before hydration. */
const StatusChip = ({
  iconOnly = false,
  label,
  onOpenStatus,
  percent,
  state,
  title,
}: {
  iconOnly?: boolean;
  label: string;
  onOpenStatus: () => void;
  percent: number | null;
  state: RuntimeState;
  title: string;
}) => (
  <button
    aria-haspopup="dialog"
    aria-label={title}
    className={join("sub-chip sub-status", iconOnly && "tool")}
    data-sw={state}
    onClick={onOpenStatus}
    title={title}
    type="button"
  >
    <RuntimeGlyph percent={percent} state={state} />
    <span className="sub-status-text">{label}</span>
    {percent === null ? null : <span className="sub-status-percent">{`${percent}%`}</span>}
  </button>
);

const guardExternalClick = (
  event: { preventDefault: () => void },
  href: string,
  confirmExternalNavigation?: (href: string) => Promise<boolean>,
) => {
  if (!confirmExternalNavigation) return;
  event.preventDefault();
  void confirmExternalNavigation(href).then((accepted) => {
    if (accepted) window.open(href, "_blank", "noopener,noreferrer");
  });
};

/**
 * Version and channel merge into one build tag: a plain dotted link on stable
 * that opens the changelog, and a compact channel label everywhere else. A PR
 * preview is the exception - the number IS the useful identity, so it links
 * straight to the pull request.
 */
const CHANNEL_SUFFIXES: Record<string, string> = { beta: "b", dev: "d", nightly: "n" };
const CHANNEL_MESSAGES: Record<string, MessageId> = {
  beta: "ui.channel.beta",
  dev: "ui.channel.dev",
  nightly: "ui.channel.nightly",
  preview: "ui.channel.preview",
};

const BuildTag = ({
  channelBadge,
  commitDistance,
  confirmExternalNavigation,
  dirty,
  githubBaseHref,
  localizer,
  onOpenWhatsNew,
  version,
  versionTitle,
}: {
  channelBadge?: string;
  commitDistance: number;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  dirty?: boolean;
  githubBaseHref?: string;
  localizer: Localizer;
  onOpenWhatsNew: () => void;
  version: string;
  versionTitle?: string;
}) => {
  const suffix = CHANNEL_SUFFIXES[channelBadge?.toLowerCase() ?? ""] ?? "";
  const versionText = `v${version}${suffix}${commitDistance ? `+${commitDistance}` : ""}${dirty ? "*" : ""}`;
  const prNumber = channelBadge?.match(/^pr-(\d+)$/i)?.[1];
  if (prNumber) {
    const prHref = githubBaseHref ? `${githubBaseHref}pull/${prNumber}` : undefined;
    const prLabel = `${localizer.message("ui.channel.prPreview")}, PR #${prNumber}, ${versionText}`;
    return (
      <span className="build-tag">
        <a
          aria-label={prLabel}
          className="sub-chip channel-badge"
          data-channel="pr"
          href={prHref ?? "#"}
          onClick={(event) => (prHref ? guardExternalClick(event, prHref, confirmExternalNavigation) : undefined)}
          rel="noreferrer"
          target="_blank"
        >
          <span className="tag-pr">{`PR-#${prNumber}`}</span>
          <span className="tag-extra">
            <span aria-hidden="true" className="tag-separator">
              {" / "}
            </span>
            <span className="tag-version">{versionText}</span>
          </span>
        </a>
      </span>
    );
  }
  if (channelBadge) {
    const key = channelBadge.toLowerCase();
    const letter = channelBadge.slice(0, 1).toUpperCase();
    const nameId = CHANNEL_MESSAGES[key];
    const name = nameId ? localizer.message(nameId) : channelBadge;
    let channelText: ReactNode = null;
    if (!suffix) channelText = <b className="tag-letter">{letter}</b>;
    return (
      <span className="build-tag">
        <button
          aria-haspopup="dialog"
          aria-label={`${name}, ${versionText}`}
          className="sub-chip channel-badge"
          data-channel={key}
          onClick={onOpenWhatsNew}
          type="button"
        >
          {channelText}
          {suffix ? null : (
            <span aria-hidden="true" className="tag-separator">
              {" / "}
            </span>
          )}
          <span className="tag-version">{versionText}</span>
        </button>
      </span>
    );
  }
  return (
    <span className="build-tag">
      <button
        aria-haspopup="dialog"
        className="sub-chip sub-link"
        onClick={onOpenWhatsNew}
        title={versionTitle}
        type="button"
      >
        {versionText}
      </button>
    </span>
  );
};

export type { OfflineWarmupDisplayProgress, RuntimeState };
export {
  BuildTag,
  HEADER_RUNTIME_MESSAGES,
  RUNTIME_MESSAGES,
  RUNTIME_STATES,
  RuntimeGlyph,
  StatusChip,
  describeWarmupUnit,
  guardExternalClick,
  installingRuntimeLabel,
  installingRuntimeWording,
  offlineWarmupPercent,
  resolveRuntimeState,
  useHydratedServiceWorkerStatus,
};
