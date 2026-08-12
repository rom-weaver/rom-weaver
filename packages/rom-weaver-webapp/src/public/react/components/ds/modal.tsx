import { Check, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { join } from "./cx.ts";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const getFocusableElements = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.tabIndex === -1 || element.matches(":disabled") || element.closest('[aria-hidden="true"]'))
      return false;
    if (element.hidden || element.closest("[hidden]")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });

/**
 * Design-system modal primitives. A generic overlay (header + scrollable body)
 * and a confirmation dialog. Both portal into the `.rw-app` root (falling back to
 * <body>) so the design system's `.rw-app`-scoped control styles (.input/.select/
 * .btn/…) reach the modal content; `.rw-modal` is `position: fixed`, so stacking
 * and overflow are unaffected by where it sits in the tree. Shared by settings,
 * candidate selection, and every confirm flow.
 */

/** The styled app root the design system scopes its rules under; modals portal here so controls inherit it. */
const getModalPortalTarget = (): Element =>
  (typeof document === "undefined" ? null : document.querySelector(".rw-app")) ?? document.body;

const useEscapeKey = (active: boolean, onEscape: () => void) => {
  useEffect(() => {
    if (!active) return undefined;
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [active, onEscape]);
};

const ModalShell = ({
  open,
  onBackdrop,
  variant,
  card,
  labelledBy,
  children,
}: {
  open: boolean;
  onBackdrop?: () => void;
  variant?: string;
  card?: string;
  labelledBy?: string;
  children: ReactNode;
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEscapeKey(open && !!onBackdrop, () => onBackdrop?.());
  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previousInert = new Map<HTMLElement, boolean>();
    for (const sibling of Array.from(dialog.parentElement?.children ?? [])) {
      if (sibling === dialog || !(sibling instanceof HTMLElement)) continue;
      previousInert.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      dialog.focus();
    };
    const wrapTabFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined) return;
      if (last === undefined) return;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    document.addEventListener("keydown", wrapTabFocus);
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", keepFocusInside);
      document.removeEventListener("keydown", wrapTabFocus);
      for (const [sibling, inert] of previousInert) sibling.inert = inert;
      previousFocus?.focus();
    };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-labelledby={labelledBy}
      aria-modal="true"
      className={join("rw-modal", variant)}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <button aria-label="Close" className="rw-modal-backdrop" onClick={onBackdrop} tabIndex={-1} type="button" />
      <div className={join("rw-modal-card", card)}>{children}</div>
    </div>,
    getModalPortalTarget(),
  );
};

/** Generic titled overlay with a close button, optional header actions, and a scrollable body. */
const Modal = ({
  open,
  onClose,
  title,
  subtitle,
  footer,
  headerActions,
  showCloseButton = true,
  variant,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  showCloseButton?: boolean;
  variant?: string;
  children: ReactNode;
}) => {
  const titleId = useId();
  return (
    <ModalShell labelledBy={title ? titleId : undefined} onBackdrop={onClose} open={open} variant={variant}>
      {title ? (
        <div className="modal-head">
          <div>
            <div className="modal-title" id={titleId}>
              {title}
            </div>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          {headerActions ? <span className="mh-sp" /> : null}
          {headerActions}
          {showCloseButton ? (
            <button aria-label="Close" className="dlg-x" onClick={onClose} type="button">
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-foot">{footer}</div> : null}
    </ModalShell>
  );
};

/** Confirmation dialog with a warning title, body copy, and cancel/confirm actions. */
const ConfirmDialog = ({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const titleId = useId();
  return (
    <ModalShell card="confirm-card" labelledBy={titleId} onBackdrop={onCancel} open={open}>
      <div className="c-title" id={titleId}>
        <TriangleAlert aria-hidden="true" />
        {title}
      </div>
      <div className="c-body">{body}</div>
      <div className="c-actions">
        <button className="btn ghost" onClick={onCancel} type="button">
          <X aria-hidden="true" />
          {cancelLabel}
        </button>
        <button className={join("btn", danger ? "danger" : "primary")} onClick={onConfirm} type="button">
          <Check aria-hidden="true" />
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
};

export { ConfirmDialog, Modal };
