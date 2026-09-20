import { Search } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Localizer } from "../../presentation/localization/index.ts";
import type { FindAction, FindEntry, FindIndex, FindKind, FindResult, FindSources } from "../find-index.ts";
import { createFindIndex, loadGuideRoutes, loadIdentifyFindEntries, searchFind } from "../find-index.ts";

const KIND_MESSAGE: Record<
  FindKind,
  "ui.find.kindApp" | "ui.find.kindGuide" | "ui.find.kindSetting" | "ui.find.kindTool"
> = {
  app: "ui.find.kindApp",
  guide: "ui.find.kindGuide",
  setting: "ui.find.kindSetting",
  tool: "ui.find.kindTool",
};

/** The key shown beside Find. `/` is the web's search key; ⌘K / Ctrl+K stays a silent alias. */
const FIND_SHORTCUT_HINT = "/";

const isPlainActivation = (event: React.MouseEvent) =>
  event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

/**
 * Find: one box that reaches every tool, setting, app surface and guide.
 * Desktop drops it under the masthead; the phone layout pins it above the
 * dock with the input at the bottom edge and the best match right above it
 * (see find.css). The result list is a listbox driven from the input, so
 * focus never leaves the box: arrows move the active option, Enter opens it.
 */
const FindPalette = ({
  localizer,
  onAction,
  onClose,
  open,
  sources,
  triggerRef,
}: {
  localizer: Localizer;
  onAction: (action: FindAction, entry: FindEntry) => void;
  onClose: () => void;
  open: boolean;
  sources: Omit<FindSources, "localizer">;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => {
  const inputId = useId();
  const listId = `${inputId}-options`;
  const statusId = `${inputId}-status`;
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [index, setIndex] = useState<FindIndex>(() => createFindIndex({ ...sources, localizer }));
  const [identifyEntries, setIdentifyEntries] = useState<FindEntry[]>([]);
  const results: FindResult[] = useMemo(
    () => [...identifyEntries.map((entry) => ({ entry, score: Number.MAX_SAFE_INTEGER })), ...searchFind(index, query)],
    [identifyEntries, index, query],
  );
  const selectedResultIndex = activeEntryId ? results.findIndex((result) => result.entry.id === activeEntryId) : -1;
  const activeIndex = Math.max(0, selectedResultIndex);

  // The static index is rebuilt when the entries it derives from change; the
  // guides join it once their chunks land, which the first search triggers.
  useEffect(() => {
    setIndex((current) => createFindIndex({ ...sources, localizer }, current.guides));
  }, [localizer, sources]);
  const hasQuery = query.trim().length > 0;
  useEffect(() => {
    if (!(open && hasQuery) || index.guides.length > 0) return undefined;
    let live = true;
    void loadGuideRoutes().then((guides) => {
      if (live && guides.length > 0) setIndex((current) => ({ ...current, guides }));
    });
    return () => {
      live = false;
    };
  }, [hasQuery, index.guides.length, open]);

  useEffect(() => {
    setIdentifyEntries([]);
    if (!(open && hasQuery)) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const identifyLabel = index.entries.find((entry) => entry.id === "tool:identify")?.label ?? "Identify ROM";
      void loadIdentifyFindEntries(query, identifyLabel, controller.signal).then(
        (entries) => {
          if (!controller.signal.aborted) setIdentifyEntries(entries);
        },
        () => undefined,
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hasQuery, index.entries, open, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setIdentifyEntries([]);
      setActiveEntryId(null);
      return undefined;
    }
    inputRef.current?.focus();
    const dismiss = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (paletteRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [onClose, open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, open]);

  const close = () => {
    onClose();
    triggerRef.current?.focus();
  };
  const activate = (result: FindResult) => {
    onClose();
    // A guide row is a real link and the document's soft navigation opens it;
    // dispatching a view switch as well would double-route (and on the 404
    // shell would drop the slug).
    if (result.entry.kind !== "guide") onAction(result.entry.action, result.entry);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveEntryId(results[(activeIndex + 1) % results.length]?.entry.id ?? null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveEntryId(results[activeIndex <= 0 ? results.length - 1 : activeIndex - 1]?.entry.id ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeIndex];
      if (result) document.getElementById(`${listId}-${activeIndex}`)?.click();
    }
  };

  if (!open) return null;
  const label = localizer.message("ui.find.label");
  return (
    <div aria-label={label} className="find-palette" id="find-palette" ref={paletteRef} role="dialog">
      <div className="find-box">
        <Search aria-hidden="true" />
        <input
          aria-activedescendant={results.length ? `${listId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-describedby={statusId}
          aria-expanded={results.length > 0}
          aria-label={label}
          autoComplete="off"
          className="find-input"
          id={inputId}
          onChange={(event) => {
            setActiveEntryId(null);
            setQuery(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={localizer.message("ui.find.placeholder")}
          ref={inputRef}
          role="combobox"
          type="search"
          value={query}
        />
        <span aria-hidden="true" className="find-key">
          {FIND_SHORTCUT_HINT}
        </span>
      </div>
      <p aria-live="polite" className="sr-only" id={statusId} role="status">
        {results.length === 0
          ? localizer.message("ui.find.empty")
          : localizer.message("ui.find.resultCount", { count: String(results.length) })}
      </p>
      {results.length === 0 ? (
        <p className="find-empty">{localizer.message("ui.find.empty")}</p>
      ) : (
        <div aria-label={label} className="find-results" id={listId} role="listbox">
          {results.map((result, resultIndex) => {
            const { entry } = result;
            const active = resultIndex === activeIndex;
            const shared = {
              "aria-selected": active,
              className: active ? "find-option is-active" : "find-option",
              id: `${listId}-${resultIndex}`,
              onPointerEnter: () => setActiveEntryId(entry.id),
              role: "option",
              tabIndex: -1,
            } as const;
            const inner = (
              <>
                <span className={`find-kind is-${entry.kind}`}>{localizer.message(KIND_MESSAGE[entry.kind])}</span>
                <span className="find-label">{entry.label}</span>
                {entry.hint ? <span className="find-hint">{entry.hint}</span> : null}
              </>
            );
            if (entry.href)
              return (
                <a
                  {...shared}
                  href={entry.href}
                  key={entry.id}
                  onClick={(event) => {
                    if (!isPlainActivation(event)) return;
                    // Guides ride the app's own soft navigation on the anchor
                    // itself; everything else is dispatched as an action.
                    if (entry.kind !== "guide") event.preventDefault();
                    activate(result);
                  }}
                  rel={entry.action.type === "external" ? "noreferrer" : undefined}
                  target={entry.action.type === "external" ? "_blank" : undefined}
                >
                  {inner}
                </a>
              );
            return (
              <button {...shared} key={entry.id} onClick={() => activate(result)} type="button">
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export { FIND_SHORTCUT_HINT, FindPalette };
