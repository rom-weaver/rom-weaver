import type { CommandResultDetails } from "../../wasm/generated/rom-weaver-rust-types.d.ts";

/** Keeps parsed field reads tied to generated Rust keys while leaving runtime values untrusted. */
type WireRecord<T> = { [K in keyof T]?: unknown };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** A command's result in a terminal event's `details`, found by its generated key. */
const getCommandResult = <K extends keyof CommandResultDetails>(details: unknown, key: K) =>
  asRecord(asRecord(details)?.[key]) as WireRecord<NonNullable<CommandResultDetails[K]>> | undefined;

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const toNumberValue = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  return undefined;
};

export type { WireRecord };
export { asRecord, getCommandResult, toNumberValue, toStringValue };
