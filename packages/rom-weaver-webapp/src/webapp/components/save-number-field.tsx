import { Minus, Plus } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  normalizeSaveNumberText,
  parseSaveNumber,
  saveNumberFraction,
  saveNumberKeyTarget,
  snapSaveNumber,
} from "../../lib/runtime/save-number.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { join } from "../../public/react/components/ds/cx.ts";
import type { SaveField } from "../../wasm/generated/rom-weaver-rust-types.d.ts";

/** Holding a step button waits this long, then repeats at this interval, stepping faster the longer it is held. */
const HOLD_DELAY_MS = 450;
const HOLD_INTERVAL_MS = 70;
const holdMultiplier = (repeats: number) => (repeats > 24 ? 100 : repeats > 12 ? 10 : 1);

type DragState = { grabbed: boolean; id: number; moved: boolean; offset: number; touch: boolean; x: number; y: number };

/**
 * A number box with the value, step buttons and, when the field has a range,
 * a slider joined in one frame. The slider bar is the whole control surface:
 * press or drag anywhere on it. Typed text accepts `50k` and `1.5m`.
 */
export const SaveNumberField = ({
  describedBy,
  disabled,
  error,
  field,
  id,
  localizer,
  onChange,
  text,
}: {
  describedBy?: string;
  disabled: boolean;
  error?: string;
  field: SaveField;
  id: string;
  localizer: Localizer;
  onChange: (value: string) => void;
  text: string;
}) => {
  const { max, min } = field.constraints;
  /* An unsigned field never goes below zero, even when its schema gives no minimum. */
  const floor = min ?? (field.kind === "unsigned_integer" ? 0 : null);
  const step = field.step && field.step > 0 ? field.step : 1;
  const integer = field.kind === "unsigned_integer" || field.kind === "signed_integer";
  const bounded = integer && min !== null && max !== null && max > min;
  const current = parseSaveNumber(text);
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(current ?? min ?? 0);
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  /* `tap` is the direction of a touch press that has not stepped yet: it steps on release, or once held, but never when the browser takes the touch to scroll. */
  const hold = useRef<{
    interval?: ReturnType<typeof setInterval>;
    tap: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  useEffect(() => {
    latest.current = current ?? min ?? 0;
  }, [current, min]);
  useEffect(
    () => () => {
      if (!hold.current) return;
      clearTimeout(hold.current.timer);
      clearInterval(hold.current.interval);
    },
    [],
  );

  const format = (value: number) => value.toLocaleString(localizer.locale);
  /* Typed text stays on screen while the box has focus or its value is invalid; otherwise the formatted value shows. */
  const shown = draft !== null && (focused || error) ? draft : current === null ? text : format(current);
  const stepLabel = format(step);
  const fitToRange = (value: number) => {
    const low = floor ?? Number.NEGATIVE_INFINITY;
    const high = max ?? Number.POSITIVE_INFINITY;
    if (min !== null && max !== null) return snapSaveNumber(value, min, max, step);
    return Math.max(low, Math.min(high, value));
  };
  const commit = (value: number) => {
    const next = fitToRange(Math.round(value));
    /* A press that lands on the value already stored must not reach the editor, which would drop its preview and output. */
    const unchanged = next === latest.current && draft === null && !error;
    latest.current = next;
    setDraft(null);
    if (!unchanged) onChange(String(next));
    return next;
  };
  const stepBy = (direction: number, multiplier = 1) => {
    const before = latest.current;
    const after = commit(before + direction * step * multiplier);
    return after !== before;
  };

  const stopHold = () => {
    if (!hold.current) return;
    clearTimeout(hold.current.timer);
    clearInterval(hold.current.interval);
    hold.current = null;
  };
  const startHold = (event: PointerEvent<HTMLButtonElement>, direction: number) => {
    if (event.button !== 0 || disabled) return;
    stopHold();
    /* Capture keeps the release with this button even when the pointer has left it. */
    event.currentTarget.setPointerCapture(event.pointerId);
    let repeats = 0;
    const press = () => {
      const moved = stepBy(direction, holdMultiplier(repeats++));
      if (!moved) stopHold();
      return moved;
    };
    const deferred = event.pointerType !== "mouse";
    if (!(deferred || press())) return;
    const timer = setTimeout(() => {
      if (!hold.current) return;
      if (deferred) {
        hold.current.tap = 0;
        if (!press()) return;
      }
      if (hold.current) hold.current.interval = setInterval(press, HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
    hold.current = { tap: deferred ? direction : 0, timer };
  };
  const endPress = (released: boolean) => {
    const tap = hold.current?.tap ?? 0;
    stopHold();
    if (released && tap) stepBy(tap);
  };
  /* Pointer presses are handled on press; a keyboard activation arrives as a click with no pointer. */
  const keyboardStep = (direction: number) => (event: { detail: number }) => {
    if (event.detail === 0) stepBy(direction);
  };

  const setFromX = (x: number) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box || min === null || max === null || box.width <= 0) return;
    const at = x - (drag.current?.offset ?? 0);
    commit(min + Math.max(0, Math.min(1, (at - box.left) / box.width)) * (max - min));
  };
  const onTrackDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.focus({ preventScroll: true });
    const touch = event.pointerType === "touch";
    /* Pressing the handle itself grabs it where it is, so the value does not jump to the pointer. */
    const knob = event.target instanceof Element ? event.target.closest(".save-number-knob") : null;
    const knobBox = knob?.getBoundingClientRect();
    const offset = knobBox ? event.clientX - (knobBox.left + knobBox.width / 2) : 0;
    drag.current = {
      grabbed: Boolean(knob),
      id: event.pointerId,
      moved: !touch,
      offset,
      touch,
      x: event.clientX,
      y: event.clientY,
    };
    if (touch) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    if (!knob) setFromX(event.clientX);
  };
  const onTrackMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.moved) {
      const dx = Math.abs(event.clientX - state.x);
      const dy = Math.abs(event.clientY - state.y);
      if (dx < 4 || dx < dy) return;
      state.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    setFromX(event.clientX);
  };
  const onTrackEnd = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    if (!(state.moved || state.grabbed) && event.type === "pointerup") setFromX(event.clientX);
    drag.current = null;
    setDragging(false);
  };
  const onTrackKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || min === null || max === null) return;
    const target = saveNumberKeyTarget(event.key, event.shiftKey, latest.current, { max, min, step });
    if (target === null) return;
    event.preventDefault();
    commit(target);
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    setDraft(raw);
    onChange(normalizeSaveNumberText(raw, localizer.locale));
  };
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    stepBy(event.key === "ArrowUp" ? 1 : -1, event.shiftKey ? 10 : 1);
  };

  const atMin = floor !== null && current !== null && current <= floor;
  const atMax = max !== null && current !== null && current >= max;
  const fraction = bounded && current !== null ? saveNumberFraction(current, min, max) : 0;
  const style = { "--fraction": fraction } as CSSProperties;
  return (
    <div
      className={join("save-number", bounded && "has-slider", dragging && "is-dragging", error && "is-invalid")}
      style={style}
    >
      <div className="save-number-row">
        <button
          aria-label={localizer.message("ui.saves.editor.lower", { label: field.label, step: stepLabel })}
          className="save-number-step"
          aria-disabled={atMin || undefined}
          disabled={disabled}
          onClick={keyboardStep(-1)}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={() => endPress(false)}
          onPointerDown={(event) => startHold(event, -1)}
          onPointerUp={() => endPress(true)}
          title={localizer.message("ui.saves.editor.lower", { label: field.label, step: stepLabel })}
          type="button"
        >
          <Minus aria-hidden="true" />
        </button>
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? "true" : undefined}
          autoComplete="off"
          className="save-number-value mono"
          disabled={disabled}
          id={id}
          inputMode={min !== null && min < 0 ? "text" : "numeric"}
          onBlur={() => {
            setFocused(false);
            if (!error) setDraft(null);
          }}
          onChange={onInput}
          onFocus={() => {
            setFocused(true);
            if (!error) setDraft(null);
          }}
          onKeyDown={onInputKey}
          spellCheck={false}
          type="text"
          value={shown}
        />
        <button
          aria-label={localizer.message("ui.saves.editor.raise", { label: field.label, step: stepLabel })}
          className="save-number-step"
          aria-disabled={atMax || undefined}
          disabled={disabled}
          onClick={keyboardStep(1)}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={() => endPress(false)}
          onPointerDown={(event) => startHold(event, 1)}
          onPointerUp={() => endPress(true)}
          title={localizer.message("ui.saves.editor.raise", { label: field.label, step: stepLabel })}
          type="button"
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      {bounded ? (
        <div className="save-number-strip">
          <span className="save-number-limit mono">{format(min)}</span>
          <div
            aria-disabled={disabled || undefined}
            aria-label={localizer.message("ui.saves.editor.slider", { label: field.label })}
            aria-orientation="horizontal"
            aria-valuemax={max}
            aria-valuemin={min}
            aria-valuenow={current ?? min}
            aria-valuetext={format(current ?? min)}
            className="save-number-track"
            onKeyDown={onTrackKey}
            onPointerCancel={onTrackEnd}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onPointerUp={onTrackEnd}
            role="slider"
            tabIndex={disabled ? -1 : 0}
          >
            <div className="save-number-groove" />
            <div className="save-number-rail" ref={rail}>
              <i className="save-number-fill" />
              <b className="save-number-knob" />
            </div>
          </div>
          <span className="save-number-limit mono">{format(max)}</span>
        </div>
      ) : null}
    </div>
  );
};
