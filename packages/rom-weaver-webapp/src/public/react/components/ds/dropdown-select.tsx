import { ChevronDown } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { join } from "./cx.ts";

type DropdownSelectProps = ComponentPropsWithoutRef<"select">;

const DropdownArrow = ({ className, disabled }: { className?: string; disabled?: boolean }) => (
  <ChevronDown
    aria-hidden="true"
    className={join("dropdown-arrow", className)}
    opacity={disabled ? 0.5 : undefined}
    size={12}
    strokeWidth={2.4}
  />
);

/** Native select with the same visible arrow as the codec combobox. */
const DropdownSelect = ({ children, className, disabled, ...props }: DropdownSelectProps) => (
  <span className="dropdown-select">
    <select {...props} className={className} disabled={disabled}>
      {children}
    </select>
    <DropdownArrow disabled={disabled} />
  </span>
);

export { DropdownArrow, DropdownSelect };
