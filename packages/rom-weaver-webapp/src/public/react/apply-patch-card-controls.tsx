import { ArrowDown, ArrowUp, Check, EllipsisVertical, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useListReorder } from "./components/ds/use-list-reorder.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept.ts";
import { useUiLocalizer } from "./settings-context.tsx";

export type ReorderHandleProps = ReturnType<ReturnType<typeof useListReorder>["handleProps"]>;

/** Numbered drag target that turns into a position editor on click. */
export const PatchDragHandle = ({
  disabled,
  handleProps,
  index,
  onReorder,
  position,
  total,
}: {
  disabled: boolean;
  handleProps: ReorderHandleProps;
  index: number;
  onReorder: (from: number, to: number) => void;
  position: number;
  total: number;
}) => {
  const localizer = useUiLocalizer();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(position));
  const cancelEditRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.select();

    const keepInputVisible = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const rect = input.getBoundingClientRect();
      const margin = 24;
      if (rect.top < viewportTop + margin || rect.bottom > viewportBottom - margin) {
        input.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      }
    };
    const frame = window.requestAnimationFrame(keepInputVisible);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", keepInputVisible);
    viewport?.addEventListener("scroll", keepInputVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", keepInputVisible);
      viewport?.removeEventListener("scroll", keepInputVisible);
    };
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      return;
    }
    const position = Number.parseInt(draft, 10);
    if (!Number.isInteger(position)) return;
    const target = Math.max(1, Math.min(total, position)) - 1;
    if (target !== index) onReorder(index, target);
  };

  if (editing) {
    return (
      <input
        aria-label={localizer.message("ui.patch.editPosition", { position, total })}
        className="handle phandle phandle-input mono"
        max={total}
        min={1}
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelEditRef.current = true;
            event.currentTarget.blur();
          }
        }}
        ref={inputRef}
        type="number"
        value={draft}
      />
    );
  }

  return (
    <button
      aria-label={
        disabled
          ? localizer.message("ui.patch.reorderUnavailable", { position, total })
          : localizer.message("ui.patch.reorderHelp", { position, total })
      }
      className="handle phandle"
      {...handleProps}
      disabled={disabled}
      onClick={(event) => {
        handleProps.onClick?.(event);
        if (event.defaultPrevented) return;
        setDraft(String(position));
        setEditing(true);
      }}
      title={localizer.message(disabled ? "ui.patch.position" : "ui.patch.reorderTitle")}
      type="button"
    >
      <span aria-hidden="true" className="phandle-number mono">
        {position}
      </span>
    </button>
  );
};

/** The loom On/Off switch leading a patch card's meta line. */
export const PatchEnableToggle = ({
  disabled,
  fileName,
  onToggle,
}: {
  disabled: boolean;
  fileName: string;
  onToggle: () => void;
}) => {
  const localizer = useUiLocalizer();
  return (
    <label className="patch-enable">
      <input
        aria-label={localizer.message("ui.patch.include", { name: fileName.replace(/\.[^.]+$/, "") })}
        checked={!disabled}
        onChange={onToggle}
        type="checkbox"
      />
      <span aria-hidden="true" className="switch-state">
        <b className="on">{localizer.message("ui.patch.on")}</b>
        <b className="off">{localizer.message("ui.patch.off")}</b>
      </span>
    </label>
  );
};

/** The check that closes the patch-details form; it takes the menu's slot in
 * the action column while editing (commit happens on each field's blur; the
 * check just closes the form). Carries the same id as the menu's Edit item so
 * open/close drive one control identity. */
export const PatchMetaDoneButton = ({ index, onToggle }: { index: number; onToggle: () => void }) => {
  const localizer = useUiLocalizer();
  return (
    <button
      aria-expanded
      aria-label={localizer.message("ui.patch.doneEditing")}
      className="rm patch-menu-btn is-editing"
      id={`rom-weaver-patch-meta-edit-${index}`}
      onClick={onToggle}
      title={localizer.message("ui.patch.done")}
      type="button"
    >
      <Check aria-hidden="true" />
    </button>
  );
};

export const PatchActionsMenu = ({
  canMoveDown,
  canMoveUp,
  index,
  onMoveDown,
  onMoveUp,
  onReplace,
  onOpenChange,
  onEdit,
  onRemove,
  open,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  index: number;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onReplace: (file: File) => void;
  onOpenChange: (open: boolean) => void;
  /** Absent while the details form cannot be edited (no bundle meta channel). */
  onEdit?: () => void;
  onRemove: () => void;
  open: boolean;
}) => {
  const localizer = useUiLocalizer();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    onOpenChange(false);
    buttonRef.current?.focus();
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onOpenChange, open]);
  return (
    <div className="patch-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={localizer.message("ui.patch.actions")}
        className={open ? "rm patch-menu-btn is-open" : "rm patch-menu-btn"}
        id={`rom-weaver-patch-menu-${index}`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        ref={buttonRef}
        title={localizer.message("ui.patch.actions")}
        type="button"
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      <div
        aria-label={localizer.message("ui.patch.actions")}
        className="patch-menu-list"
        hidden={!open}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        role="menu"
      >
        <button
          className="patch-menu-item"
          disabled={!canMoveUp}
          id={`rom-weaver-patch-move-up-${index}`}
          onClick={() => {
            close();
            onMoveUp();
          }}
          role="menuitem"
          type="button"
        >
          <ArrowUp aria-hidden="true" />
          {localizer.message("ui.patch.moveUp")}
        </button>
        <button
          className="patch-menu-item"
          disabled={!canMoveDown}
          id={`rom-weaver-patch-move-down-${index}`}
          onClick={() => {
            close();
            onMoveDown();
          }}
          role="menuitem"
          type="button"
        >
          <ArrowDown aria-hidden="true" />
          {localizer.message("ui.patch.moveDown")}
        </button>
        <button
          className="patch-menu-item"
          id={`rom-weaver-patch-replace-${index}`}
          onClick={() => fileRef.current?.click()}
          title={localizer.message("ui.patch.replaceHelp")}
          role="menuitem"
          type="button"
        >
          <RefreshCw aria-hidden="true" />
          {localizer.message("ui.patch.replace")}
        </button>
        {onEdit ? (
          <button
            className="patch-menu-item"
            id={`rom-weaver-patch-meta-edit-${index}`}
            onClick={() => {
              onOpenChange(false);
              onEdit();
            }}
            role="menuitem"
            type="button"
          >
            <Pencil aria-hidden="true" />
            {localizer.message("ui.patch.editDetails")}
          </button>
        ) : null}
        <button
          aria-label={localizer.message("ui.patch.remove")}
          className="patch-menu-item is-danger"
          id={`rom-weaver-patch-menu-remove-${index}`}
          onClick={() => {
            onOpenChange(false);
            onRemove();
          }}
          role="menuitem"
          type="button"
        >
          <Trash2 aria-hidden="true" />
          {localizer.message("ui.patch.remove")}
        </button>
      </div>
      <input
        accept={getFileInputAcceptAttributes().patchReplace}
        aria-label={localizer.message("ui.patch.replacementInput")}
        className="sr-only"
        id={`rom-weaver-patch-replace-input-${index}`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          close();
          if (file) onReplace(file);
        }}
        ref={fileRef}
        tabIndex={-1}
        type="file"
      />
    </div>
  );
};
