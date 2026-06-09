import { type CSSProperties, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type CompressionCodecOption,
  validateCompressionCodecValue,
} from "../../../../lib/compression/codec-fields.ts";

type CodecComboboxProps = {
  ariaLabel?: string;
  disabled?: boolean;
  forceInvalid?: boolean;
  id?: string;
  inputClassName?: string;
  label?: string;
  multiple?: boolean;
  onChange: (value: string) => void;
  options: readonly CompressionCodecOption[];
  placeholder?: string;
  suggestions?: readonly CompressionCodecOption[];
  value: string;
};

type ActiveToken = {
  end: number;
  query: string;
  start: number;
  token: string;
};
type DropdownPlacement = "above" | "below";
type DropdownFrame = {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
};

const DROPDOWN_GAP = 4;
const DROPDOWN_MARGIN = 8;
const DROPDOWN_MAX_HEIGHT = 178;
const DROPDOWN_MIN_HEIGHT = 84;
const KEYBOARD_TOP_MARGIN_RATIO = 0.16;
const KEYBOARD_BOTTOM_MARGIN_RATIO = 0.56;
const ACTION_BLOCKER_SELECTOR = ".rw-app .run, .rw-modal .btn.primary, .rw-modal .btn.danger";
const OPTION_ROW_HEIGHT = 28;
const OPTION_LIST_CHROME_HEIGHT = 10;

const getActiveToken = (value: string, cursor: number | null | undefined, multiple: boolean): ActiveToken => {
  const position = Math.max(0, Math.min(value.length, cursor ?? value.length));
  const start = multiple ? value.slice(0, position).lastIndexOf(",") + 1 : 0;
  const remaining = value.slice(position);
  const nextComma = multiple ? remaining.indexOf(",") : -1;
  const end = nextComma === -1 ? value.length : position + nextComma;
  const token = value.slice(start, end).trim().toLowerCase();
  return {
    end,
    query: token.split(":")[0] || "",
    start,
    token,
  };
};

const getLevelSuffix = (token: string): string => token.match(/:(\d*)$/)?.[0] || "";

const applyCodecSelection = (
  value: string,
  cursor: number | null | undefined,
  multiple: boolean,
  codec: string,
): { cursor: number; value: string } => {
  const active = getActiveToken(value, cursor, multiple);
  const selectedValue = `${codec}${getLevelSuffix(active.token)}`;
  const prefix = value.slice(0, active.start).replace(/\s+$/, "");
  const suffix = value.slice(active.end).replace(/^\s+/, "");
  const nextValue = `${prefix}${selectedValue}${suffix}`;
  return {
    cursor: prefix.length + selectedValue.length,
    value: nextValue,
  };
};

const getSuggestionValue = (option: CompressionCodecOption): string => option.value;
const getSuggestionSearchText = (option: CompressionCodecOption): string =>
  `${option.label} ${option.value} ${option.searchText || ""}`.toLowerCase();

const CodecCombobox = ({
  ariaLabel,
  disabled,
  forceInvalid,
  id,
  inputClassName = "input",
  label,
  multiple = false,
  onChange,
  options,
  placeholder,
  suggestions,
  value,
}: CodecComboboxProps) => {
  const generatedId = useId();
  const inputId = id || generatedId;
  const listboxId = `${inputId}-options`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cursor, setCursor] = useState(value.length);
  const [filtering, setFiltering] = useState(false);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<DropdownPlacement>("below");
  const [dropdownFrame, setDropdownFrame] = useState<DropdownFrame | null>(null);
  const activeToken = getActiveToken(value, cursor, multiple);
  const validation = validateCompressionCodecValue(value, options, {
    allowMultiple: multiple,
    label: label || "Codec",
  });
  const invalid = !!forceInvalid || !validation.valid;
  const suggestionOptions = suggestions || options;

  const filteredSuggestions = useMemo(() => {
    if (!filtering) return [...suggestionOptions];
    const query = activeToken.query;
    if (!query) return [...suggestionOptions];
    return suggestionOptions.filter((option) => getSuggestionSearchText(option).includes(query));
  }, [activeToken.query, filtering, suggestionOptions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [activeToken.query, suggestionOptions]);

  const updateDropdownFrame = (measuredHeight?: number) => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = globalThis.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportHeight = viewport?.height ?? globalThis.innerHeight;
    const viewportWidth = viewport?.width ?? globalThis.innerWidth;
    let belowBoundary = viewportHeight - DROPDOWN_MARGIN;
    if (typeof document !== "undefined") {
      for (const blocker of document.querySelectorAll(ACTION_BLOCKER_SELECTOR)) {
        const blockerRect = blocker.getBoundingClientRect();
        const overlapsHorizontally = blockerRect.right > rect.left && blockerRect.left < rect.right;
        if (overlapsHorizontally && blockerRect.top >= rect.bottom && blockerRect.top < belowBoundary) {
          belowBoundary = blockerRect.top - DROPDOWN_MARGIN;
        }
      }
    }
    const spaceBelow = belowBoundary - rect.bottom;
    const spaceAbove = rect.top - DROPDOWN_MARGIN;
    const nextPlacement = spaceBelow < DROPDOWN_MIN_HEIGHT && spaceAbove > spaceBelow ? "above" : "below";
    const availableSpace = Math.max(
      DROPDOWN_MIN_HEIGHT,
      nextPlacement === "above" ? spaceAbove - DROPDOWN_GAP : spaceBelow - DROPDOWN_GAP,
    );
    const maxHeight = Math.min(DROPDOWN_MAX_HEIGHT, availableSpace);
    const estimatedContentHeight = Math.max(
      OPTION_ROW_HEIGHT + OPTION_LIST_CHROME_HEIGHT,
      filteredSuggestions.length * OPTION_ROW_HEIGHT + OPTION_LIST_CHROME_HEIGHT,
    );
    const contentHeight = Math.min(DROPDOWN_MAX_HEIGHT, measuredHeight ?? estimatedContentHeight);
    const placementHeight = Math.min(maxHeight, contentHeight);
    const top =
      nextPlacement === "above"
        ? viewportTop + Math.max(DROPDOWN_MARGIN, rect.top - DROPDOWN_GAP - placementHeight)
        : viewportTop + Math.min(rect.bottom + DROPDOWN_GAP, belowBoundary - placementHeight);
    const left =
      viewportLeft + Math.max(DROPDOWN_MARGIN, Math.min(rect.left, viewportWidth - DROPDOWN_MARGIN - rect.width));
    setPlacement(nextPlacement);
    setDropdownFrame({
      left: Math.round(left),
      maxHeight: Math.round(maxHeight),
      top: Math.round(top),
      width: Math.round(rect.width),
    });
  };

  const keepInputVisible = () => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = globalThis.visualViewport;
    const viewportHeight = viewport?.height ?? globalThis.innerHeight;
    const keyboardLikelyOpen = !!viewport && viewport.height < globalThis.innerHeight - 80;
    const topLimit = keyboardLikelyOpen
      ? Math.max(DROPDOWN_MARGIN, viewportHeight * KEYBOARD_TOP_MARGIN_RATIO)
      : DROPDOWN_MARGIN;
    const bottomLimit = keyboardLikelyOpen
      ? Math.min(viewportHeight - DROPDOWN_MARGIN, viewportHeight * KEYBOARD_BOTTOM_MARGIN_RATIO)
      : viewportHeight - DROPDOWN_MARGIN;
    if (rect.bottom > bottomLimit) {
      globalThis.scrollBy(0, rect.bottom - bottomLimit);
      return;
    }
    if (rect.top < topLimit) {
      globalThis.scrollBy(0, rect.top - topLimit);
    }
  };

  const getRenderedDropdownHeight = (): number | undefined => {
    const measuredHeight = listRef.current?.getBoundingClientRect().height;
    return measuredHeight && Number.isFinite(measuredHeight) ? measuredHeight : undefined;
  };

  const syncViewportPosition = () => {
    keepInputVisible();
    updateDropdownFrame(getRenderedDropdownHeight());
    requestAnimationFrame(() => updateDropdownFrame(getRenderedDropdownHeight()));
  };

  const focusInputIntoView = () => {
    inputRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    for (const delay of [80, 220, 420]) {
      globalThis.setTimeout(syncViewportPosition, delay);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(updateDropdownFrame);
    return () => cancelAnimationFrame(frame);
  }, [open, filteredSuggestions.length]);

  useEffect(() => {
    if (!open) return undefined;
    const viewport = globalThis.visualViewport;
    const handleViewportChange = () => {
      requestAnimationFrame(syncViewportPosition);
    };
    syncViewportPosition();
    viewport?.addEventListener("resize", handleViewportChange);
    viewport?.addEventListener("scroll", handleViewportChange);
    globalThis.addEventListener("scroll", handleViewportChange, { passive: true });
    globalThis.addEventListener("resize", handleViewportChange);
    return () => {
      viewport?.removeEventListener("resize", handleViewportChange);
      viewport?.removeEventListener("scroll", handleViewportChange);
      globalThis.removeEventListener("scroll", handleViewportChange);
      globalThis.removeEventListener("resize", handleViewportChange);
    };
  }, [open]);

  const selectOption = (option: CompressionCodecOption) => {
    const selectedValue = getSuggestionValue(option);
    const next = option.replaceValue
      ? { cursor: selectedValue.length, value: selectedValue }
      : applyCodecSelection(value, cursor, multiple, selectedValue);
    onChange(next.value);
    setCursor(next.cursor);
    setFiltering(false);
    setOpen(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!filteredSuggestions.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(filteredSuggestions.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      selectOption(
        filteredSuggestions[
          Math.max(0, Math.min(activeIndex, filteredSuggestions.length - 1))
        ] as CompressionCodecOption,
      );
    }
  };

  const visible = open && !disabled && filteredSuggestions.length > 0;
  const clampedActiveIndex = Math.max(0, Math.min(activeIndex, filteredSuggestions.length - 1));

  useEffect(() => {
    if (!visible) return undefined;
    const frame = requestAnimationFrame(() => {
      const measuredHeight = listRef.current?.getBoundingClientRect().height;
      if (measuredHeight) updateDropdownFrame(measuredHeight);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, filteredSuggestions.length]);

  const dropdownStyle: CSSProperties | undefined = dropdownFrame
    ? {
        left: dropdownFrame.left,
        maxHeight: dropdownFrame.maxHeight,
        position: "fixed",
        top: dropdownFrame.top,
        width: dropdownFrame.width,
        zIndex: 10000,
      }
    : undefined;
  const dropdown = visible ? (
    <div
      className={placement === "above" ? "codec-combobox-list above" : "codec-combobox-list"}
      id={listboxId}
      ref={listRef}
      role="listbox"
      style={dropdownStyle}
    >
      {filteredSuggestions.map((option, index) => (
        <div
          aria-selected={index === clampedActiveIndex}
          className={index === clampedActiveIndex ? "codec-combobox-option active" : "codec-combobox-option"}
          id={`${listboxId}-${index}`}
          key={`${option.label}-${option.value}`}
          onMouseDown={(event) => {
            event.preventDefault();
            selectOption(option);
          }}
          onMouseEnter={() => setActiveIndex(index)}
          role="option"
          tabIndex={-1}
        >
          {option.label}
        </div>
      ))}
    </div>
  ) : null;
  const portalTarget = typeof document === "undefined" ? null : document.body;

  return (
    <div className="codec-combobox">
      <input
        aria-activedescendant={visible ? `${listboxId}-${clampedActiveIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={visible ? listboxId : undefined}
        aria-expanded={visible}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel || label}
        className={inputClassName}
        disabled={disabled}
        id={inputId}
        onBlur={() => {
          globalThis.setTimeout(() => setOpen(false), 100);
        }}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
          setFiltering(true);
          setOpen(true);
          updateDropdownFrame();
        }}
        onClick={(event) => {
          setCursor(event.currentTarget.selectionStart ?? value.length);
          setFiltering(false);
          updateDropdownFrame();
        }}
        onFocus={(event) => {
          setCursor(event.currentTarget.selectionStart ?? value.length);
          setFiltering(false);
          setOpen(true);
          focusInputIntoView();
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => setCursor(event.currentTarget.selectionStart ?? value.length)}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart ?? value.length)}
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        title={invalid ? validation.message : undefined}
        value={value}
      />
      {portalTarget && dropdown ? createPortal(dropdown, portalTarget) : dropdown}
    </div>
  );
};

export type { CodecComboboxProps };
export { applyCodecSelection, CodecCombobox, getActiveToken };
