import Check from "lucide-react/dist/esm/icons/check.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Design-system modal primitives. A generic overlay (header + scrollable body)
 * and a confirmation dialog. Both portal into the `.rw-app` root (falling back to
 * <body>) so the design system's `.rw-app`-scoped control styles (.input/.select/
 * .btn/…) reach the modal content; `.rw-modal` is `position: fixed`, so stacking
 * and overflow are unaffected by where it sits in the tree. Shared by settings,
 * candidate selection, and every confirm flow.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

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
  children,
}: {
  open: boolean;
  onBackdrop?: () => void;
  variant?: string;
  card?: string;
  children: ReactNode;
}) => {
  useEscapeKey(open && !!onBackdrop, () => onBackdrop?.());
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div aria-modal="true" className={join("rw-modal", variant)} role="dialog">
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
  headerActions,
  variant,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  variant?: string;
  children: ReactNode;
}) => (
  <ModalShell onBackdrop={onClose} open={open} variant={variant}>
    {title ? (
      <div className="modal-head">
        <div>
          <div className="modal-title">{title}</div>
          {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
        </div>
        {headerActions ? <span className="mh-sp" /> : null}
        {headerActions}
        <button aria-label="Close" className="iconbtn" onClick={onClose} type="button">
          <X aria-hidden="true" />
        </button>
      </div>
    ) : null}
    <div className="modal-body">{children}</div>
  </ModalShell>
);

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
}) => (
  <ModalShell card="confirm-card" onBackdrop={onCancel} open={open}>
    <div className="c-title">
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

export { ConfirmDialog, Modal, ModalShell };
