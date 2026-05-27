import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import Github from "lucide-react/dist/esm/icons/github.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { APP_BUILD_VERSION } from "./build-version.ts";
import { ProgressActionButton } from "./components/progress-action-button.tsx";
import {
  buttonClasses,
  cx,
  dialogClasses,
  formClasses,
  layoutClasses,
  noticeClasses,
  rowClasses,
  settingsClasses,
  textClasses,
} from "./tailwind-classes.ts";
import type { ConfirmationDialogState, WebappRootProps } from "./webapp-root-types.ts";

const DEFAULT_WAKE_LOCK_WARNING =
  "Screen wake lock is unavailable. Keep this tab visible and prevent the device from sleeping while processing runs.";

const createEmptyConfirmationDialogState = (): ConfirmationDialogState => ({
  cancelLabel: "Cancel",
  confirmLabel: "Continue",
  level: "warning",
  message: "",
  open: false,
  title: "",
});

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

function ProcessingWakeLockNotice({ active }: { active: boolean }) {
  const [warningMessage, setWarningMessage] = useState("");
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const releaseSentinel = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (!sentinel || sentinel.released) return;
      void sentinel.release().catch(() => undefined);
    };
    if (!active) {
      setWarningMessage("");
      releaseSentinel();
      return;
    }
    if (typeof document === "undefined" || typeof navigator === "undefined") return;
    const wakeLockNavigator = navigator as NavigatorWithWakeLock;
    if (!wakeLockNavigator.wakeLock?.request) {
      setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
      return;
    }

    let disposed = false;
    const handleRelease = () => {
      sentinelRef.current = null;
      if (disposed || !active) return;
      if (document.visibilityState === "visible") void acquireWakeLock();
      else setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
    };
    const acquireWakeLock = async () => {
      if (disposed || sentinelRef.current || document.visibilityState === "hidden") return;
      try {
        const sentinel = await wakeLockNavigator.wakeLock.request("screen");
        if (disposed) {
          void sentinel.release().catch(() => undefined);
          return;
        }
        sentinelRef.current = sentinel;
        setWarningMessage("");
        sentinel.addEventListener?.("release", handleRelease);
      } catch (_err) {
        setWarningMessage(DEFAULT_WAKE_LOCK_WARNING);
      }
    };
    const handleVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "visible") {
        void acquireWakeLock();
        return;
      }
      releaseSentinel();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void acquireWakeLock();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseSentinel();
    };
  }, [active]);

  if (!(active && warningMessage)) return null;
  return <ToolNotice level="warning" message={warningMessage} />;
}

function ToolNotice({ message, level }: { message: string; level?: "error" | "warning" }) {
  if (!message) return null;
  const Icon = level === "warning" ? TriangleAlert : CircleX;
  return (
    <div className={rowClasses.message}>
      <span className={cx(noticeClasses.message, level === "warning" && noticeClasses.warning)}>
        <Icon aria-hidden="true" className={noticeClasses.icon} />
        {message}
      </span>
    </div>
  );
}

function ConfirmationDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmationDialogState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!state.open) return;
    confirmButtonRef.current?.focus();
  }, [state.open]);

  if (!state.open) return null;
  const Icon = state.level === "warning" ? TriangleAlert : CircleX;
  return (
    <>
      <div aria-hidden="true" className={dialogClasses.backdrop} />
      <dialog
        aria-describedby="rom-weaver-confirmation-message"
        aria-labelledby="rom-weaver-confirmation-title"
        className={cx(dialogClasses.panel, "z-50")}
        onCancel={(event) => {
          event.preventDefault();
          onCancel();
        }}
        open
      >
        <div className={dialogClasses.title} id="rom-weaver-confirmation-title">
          {state.title}
        </div>
        <div className={cx(dialogClasses.body, "flex items-start gap-[10px]")} id="rom-weaver-confirmation-message">
          <Icon
            aria-hidden="true"
            className={cx(noticeClasses.icon, state.level === "warning" && noticeClasses.warning)}
          />
          <span>{state.message}</span>
        </div>
        <div className={dialogClasses.actions}>
          <button
            className={cx(buttonClasses.primary, buttonClasses.secondary, "!m-0 !w-auto")}
            onClick={onCancel}
            type="button"
          >
            {state.cancelLabel}
          </button>
          <button
            className={cx(buttonClasses.primary, "!m-0 !w-auto")}
            onClick={onConfirm}
            ref={confirmButtonRef}
            type="button"
          >
            {state.confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

function SettingsTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      aria-label="Open settings"
      className={layoutClasses.settingsTrigger}
      onClick={onClick}
      title="Settings"
      type="button"
    >
      <Settings aria-hidden="true" className={layoutClasses.settingsTriggerIcon} />
    </button>
  );
}

function SettingsDialog({
  open,
  onClose,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "contain";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div aria-hidden="true" className={dialogClasses.backdrop} onClick={onClose} />
      <dialog
        aria-labelledby="rom-weaver-settings-title"
        className={cx(dialogClasses.largePanel, "z-50")}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        open
      >
        <div className={settingsClasses.header}>
          <div className={settingsClasses.title} id="rom-weaver-settings-title">
            Settings
          </div>
          {actions ? <div className={settingsClasses.actions}>{actions}</div> : null}
        </div>
        <div className={settingsClasses.body}>{children}</div>
      </dialog>
    </>
  );
}

function PageUpdateBanner({
  pageUpdate,
  onReloadUpdate,
}: {
  pageUpdate: WebappRootProps["pageUpdate"];
  onReloadUpdate: WebappRootProps["actions"]["onReloadUpdate"];
}) {
  if (!pageUpdate.ready) return null;
  return (
    <div aria-live="polite" className={layoutClasses.updateBanner} id="app-update-banner" role="status">
      <span className={layoutClasses.updateBannerText}>{pageUpdate.title}</span>
      <button
        className={layoutClasses.updateBannerAction}
        id="app-update-reload-button"
        onClick={onReloadUpdate}
        type="button"
      >
        <RefreshCw aria-hidden="true" className={buttonClasses.icon} />
        <span>{pageUpdate.label}</span>
      </button>
    </div>
  );
}

function AppFooter({ serviceWorkerCache }: { serviceWorkerCache: WebappRootProps["serviceWorkerCache"] }) {
  return (
    <footer className={layoutClasses.footer}>
      <div className={layoutClasses.footerLinks}>
        <span className={cx("footer-link-item", layoutClasses.footerLinkItem)} title="Build version">
          <span className={layoutClasses.footerCacheVersion}>{APP_BUILD_VERSION}</span>
        </span>
        <span
          aria-live="polite"
          className={cx("footer-cache-version", layoutClasses.footerCacheVersion)}
          id="service-worker-cache-version"
          title={serviceWorkerCache.title}
        >
          {serviceWorkerCache.label}
        </span>
        <span className={cx("footer-link-item", layoutClasses.footerLinkItem)}>
          <Github aria-hidden="true" className={cx("icon github", layoutClasses.footerIcon)} />
          <a
            className={layoutClasses.footerAnchor}
            href="https://github.com/marcrobledo/rom-weaver/"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </span>
        <span className={cx("footer-link-item", layoutClasses.footerLinkItem)}>
          <Heart aria-hidden="true" className={cx("icon heart", layoutClasses.footerIcon)} />
          <a
            className={layoutClasses.footerAnchor}
            href="https://www.paypal.me/marcrobledo/5"
            rel="noopener nofollow"
            target="_blank"
          >
            Donate
          </a>
        </span>
      </div>
    </footer>
  );
}

export type { ConfirmationDialogState, WebappRootProps };
export {
  AppFooter,
  buttonClasses,
  ConfirmationDialog,
  createEmptyConfirmationDialogState,
  cx,
  formClasses,
  layoutClasses,
  noticeClasses,
  PageUpdateBanner,
  ProcessingWakeLockNotice,
  ProgressActionButton,
  rowClasses,
  SettingsDialog,
  SettingsTrigger,
  ToolNotice,
  textClasses,
};
