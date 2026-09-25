import { Check, X } from "lucide-react";
import { useRef, useState } from "react";
import { CHECK_LABELS, type CheckField, isHalfRowField, isHashRowField } from "./components/ds/check-fields.ts";
import { FIT_VALUE_MIN_CHARS } from "./components/ds/checksum-list.tsx";
import { join } from "./components/ds/cx.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { checkErrorMessage } from "./apply-patch-input-checks.ts";

/** An editable expected-check field (user-specified, not built into the patch):
 * commits on blur, removable via the trailing X. A malformed value shows an
 * inline error; a well-formed value that was compared to the real ROM shows a
 * match/mismatch mark.
 *
 * Edit-in-place, and the indirection is load-bearing on iOS: a text field whose
 * text is under 16px makes Safari zoom the page in when it takes focus, and no
 * phone is wide enough to show a 40-character SHA-1 at 16px. At rest the value is
 * therefore a button holding plain text at a read-only row's size and typeface
 * (it keeps the user-check colour, so a user value still reads apart from an
 * embedded one), and tapping it mounts the real field at the 16px floor before
 * focus lands - so the field is never focused while it is small. Sizing the field
 * on `:focus` cannot work: Safari decides whether to zoom as focus arrives, before
 * that style applies. */
const EditableCheckRow = ({
  focusOnMount,
  field,
  id,
  invalid,
  mark,
  onCommit,
  onRemove,
  value,
}: {
  /** A field just opened via "Add check": move focus into it (a user-gesture
   * focus handoff, not a page-load autofocus). */
  focusOnMount?: boolean;
  field: CheckField;
  id: string;
  invalid: boolean;
  /** Verdict of comparing this (valid) value to the real ROM value; undefined
   * when there is nothing to compare against yet. */
  mark?: "bad" | "ok";
  onCommit: (raw: string) => void;
  onRemove: () => void;
  value: string;
}) => {
  const localizer = useUiLocalizer();
  const errorId = `${id}-err`;
  /* The ref callback is a fresh identity every render, so React detaches and
     reattaches it each time. Without this latch the handoff would re-focus on
     every render, and two freshly added rows would then trade focus forever -
     each steal blurs the other, and the blur commits, which renders again. */
  const handedOff = useRef(false);
  if (!focusOnMount) handedOff.current = false;
  /* One-shot: the field mounted because the user just opened it, so it takes focus
     once. Separate from the `focusOnMount` latch above so opening a row by hand
     never re-arms the add-a-check handoff. */
  const openedByUser = useRef(false);
  /* An empty row has no value to display, so it opens as a field either way. */
  const [editing, setEditing] = useState(!!focusOnMount || !value);
  /* A malformed value keeps its field no matter what: collapsing to text would hide
     both the `aria-invalid` state and the only means of correcting it. */
  const showField = editing || invalid;
  const label = CHECK_LABELS[field];
  return (
    <div
      className={join(
        "verification-row",
        showField && "is-editing",
        invalid && "bad",
        isHalfRowField(field) && "ck-half",
        isHashRowField(field) && "ck-hash",
      )}
      key={`${id}:${value}`}
    >
      {showField ? (
        <label className="ofld-l" htmlFor={id}>
          {label}
        </label>
      ) : (
        <span className="ofld-l">{label}</span>
      )}
      {showField ? (
        <input
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          className="input mono popt-input"
          defaultValue={value}
          id={id}
          onBlur={(event) => {
            const raw = event.currentTarget.value;
            /* Keep an unfillable row open rather than collapsing to a blank button. */
            if (raw) setEditing(false);
            onCommit(raw);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          ref={(element) => {
            if (!element) return;
            if (openedByUser.current) {
              openedByUser.current = false;
              element.focus();
              return;
            }
            if (!focusOnMount || handedOff.current) return;
            handedOff.current = true;
            element.focus();
          }}
          spellCheck={false}
          title={invalid ? checkErrorMessage(field, localizer) : value || undefined}
          type="text"
        />
      ) : (
        <button
          aria-describedby={invalid ? errorId : undefined}
          aria-label={localizer.message("ui.patch.editCheck", { check: label })}
          className="ck-open mono"
          /* Derived from the field's own id so either state of the row is addressable. */
          id={`${id}-open`}
          onClick={() => {
            openedByUser.current = true;
            setEditing(true);
          }}
          title={invalid ? checkErrorMessage(field, localizer) : value}
          type="button"
        >
          <span className={join("ck-v", value.length >= FIT_VALUE_MIN_CHARS && "ck-fit")}>{value}</span>
        </button>
      )}
      <span className="vrow-tail">
        {mark && !invalid ? (
          <span
            className={`ck-mark ${mark}`}
            title={localizer.message(mark === "ok" ? "ui.patch.matchesRom" : "ui.patch.doesNotMatchRom")}
          >
            {mark === "ok" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
            <span className="sr-only">
              {localizer.message(mark === "ok" ? "ui.patch.matchesRom" : "ui.patch.doesNotMatchRom")}
            </span>
          </span>
        ) : null}
        <button
          aria-label={localizer.message("ui.patch.removeCheck", { check: CHECK_LABELS[field] })}
          className="ck-remove"
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </span>
      {invalid ? (
        <p className="ck-err" id={errorId}>
          {checkErrorMessage(field, localizer)}
        </p>
      ) : null}
    </div>
  );
};

export { EditableCheckRow };
