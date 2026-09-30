type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const visible = (element: Element) => {
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  const details = element.closest("details:not([open])");
  if (details && !details.querySelector(":scope > summary")?.contains(element)) return false;
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
};
const label = (element: HTMLElement) => {
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const labels = "labels" in element ? (element as Control).labels : null;
  return (
    element.getAttribute("aria-label") ||
    labelledText ||
    Array.from(labels ?? [])
      .map((item) => item.textContent)
      .join(" ") ||
    element.getAttribute("placeholder") ||
    element.textContent ||
    element.id
  ).trim();
};

function getWorkflowSurfaces(view: string) {
  const panel = document.getElementById(`panel-${view}`);
  if (!panel || panel.hidden) return [];
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('.rw-app [role="dialog"], .rw-app dialog[open]'),
  ).filter(visible);
  const dialog = dialogs.findLast((item) => !item.inert) ?? dialogs.at(-1);
  if (dialog) return [dialog];
  const listboxes = Array.from(panel.querySelectorAll("[aria-controls]"))
    .flatMap((control) => (control.getAttribute("aria-controls") ?? "").split(/\s+/))
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement =>
      Boolean(element && element.getAttribute("role") === "listbox" && visible(element)),
    );
  return [panel, ...listboxes.filter((element) => !panel.contains(element))];
}

export function getWorkflowControls(view: string) {
  const surfaces = getWorkflowSurfaces(view);
  const fields = Array.from(
    new Set(surfaces.flatMap((surface) => Array.from(surface.querySelectorAll<Control>("input,select,textarea")))),
  ).filter(
    (control) =>
      visible(control) && !(control instanceof HTMLInputElement && ["hidden", "password"].includes(control.type)),
  );
  const buttons = Array.from(
    new Set(
      surfaces.flatMap((surface) =>
        Array.from(surface.querySelectorAll<HTMLElement>('button,summary,[role="option"],a[download]')),
      ),
    ),
  ).filter(
    (element) => visible(element) && !(element.getAttribute("role") === "option" && element.querySelector("button")),
  );
  return {
    modalOpen: surfaces.some((surface) => surface.matches('[role="dialog"],dialog')),
    fields: fields.map((control, index) => {
      const checkbox = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type);
      const file = control instanceof HTMLInputElement && control.type === "file";
      const options =
        control instanceof HTMLSelectElement
          ? Array.from(control.options).map((option) => ({
              value: option.value,
              label: option.text,
              disabled: option.matches(":disabled"),
            }))
          : undefined;
      return {
        element: control,
        key: `field-${index}`,
        label: label(control),
        type: checkbox ? "boolean" : "string",
        inputType: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
        value: checkbox ? control.checked : control.value,
        editable: !(file || control.matches(":disabled") || ("readOnly" in control && control.readOnly)),
        options,
        min: control.getAttribute("min"),
        max: control.getAttribute("max"),
        step: control.getAttribute("step"),
        maxLength: "maxLength" in control && control.maxLength >= 0 ? control.maxLength : undefined,
        files: file ? Array.from(control.files ?? []).map(({ name, size }) => ({ name, size })) : undefined,
      };
    }),
    buttons: buttons.map((element, index) => ({
      element,
      key: `control-${index}`,
      description: label(element),
      enabled: !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
    })),
  };
}

export function configureWorkflowControl(view: string, key: string, value: unknown) {
  const field = getWorkflowControls(view).fields.find((item) => item.key === key);
  if (!(field && field.editable)) throw new Error("The field is unavailable or read-only");
  const element = field.element;
  if (field.type === "boolean") {
    if (typeof value !== "boolean" || !(element instanceof HTMLInputElement))
      throw new Error("Expected a boolean field value");
    if (element.type === "radio" && !value && element.checked) throw new Error("Select another radio option instead");
    if (element.checked !== value) element.click();
    return;
  }
  if (typeof value !== "string" || value.length > 100000)
    throw new Error("Expected a string field value of at most 100000 characters");
  if (
    element instanceof HTMLSelectElement &&
    !field.options?.some((option) => option.value === value && !option.disabled)
  )
    throw new Error("Unknown or disabled option");
  if (field.maxLength !== undefined && value.length > field.maxLength)
    throw new Error("Field value exceeds its maximum length");
  const candidate = element.cloneNode(true) as Control;
  candidate.value = value;
  if (candidate.value !== value || !candidate.checkValidity())
    throw new Error(candidate.validationMessage || "Invalid field value");
  // React's value tracker MUST observe the event after the native setter changes the value.
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) throw new Error("This field does not support configuration");
  descriptor.set.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function executeWorkflowControl(view: string, key: string) {
  const action = getWorkflowControls(view).buttons.find((item) => item.key === key);
  if (!action?.enabled) throw new Error("The workflow control is unavailable or disabled");
  if (action.element.getAttribute("role") === "option") {
    action.element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  }
  action.element.click();
}
