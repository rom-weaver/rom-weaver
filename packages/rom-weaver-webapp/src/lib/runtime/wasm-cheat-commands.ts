import type { LogLevel } from "../../types/logging.ts";
import type { CheatRecord, ClassifiedCheatRecord } from "../cheats/model.ts";
import type { CheatWriteConflict } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import { toRomWeaverOptions } from "./run-options.ts";
import { asRecord, ensureRomWeaverSuccess, getTerminalEvent } from "./run-result-parsing.ts";
import { runRomWeaverJson } from "./wasm-command-shared.ts";
import type { RomWeaverJsonResult } from "./wasm-command-shared.ts";

type RomWeaverCheatResult = {
  conflicts: CheatWriteConflict[];
  records: ClassifiedCheatRecord[];
  patches?: Array<{ bytes: number[]; format: "ips" | "ips32" }>;
};

const parseCheatCommandResult = (result: RomWeaverJsonResult): RomWeaverCheatResult => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : undefined);
  const cheats = asRecord(details?.cheats);
  if (!(cheats && Array.isArray(cheats.records) && Array.isArray(cheats.conflicts))) {
    throw withRomWeaverFailureKind(new Error("Cheat classification result was missing or malformed"), result);
  }
  const patches = cheats.patches;
  if (
    patches !== undefined &&
    (!Array.isArray(patches) ||
      patches.length !== cheats.records.length ||
      patches.some((value) => {
        const patch = asRecord(value);
        return (
          !patch ||
          (patch.format !== "ips" && patch.format !== "ips32") ||
          !Array.isArray(patch.bytes) ||
          !patch.bytes.length ||
          patch.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
        );
      }))
  ) {
    throw withRomWeaverFailureKind(new Error("Cheat patch snapshots were malformed"), result);
  }
  return {
    conflicts: cheats.conflicts as CheatWriteConflict[],
    records: cheats.records as ClassifiedCheatRecord[],
    ...(patches ? { patches: patches as NonNullable<RomWeaverCheatResult["patches"]> } : {}),
  };
};

const invokeRomWeaverCheatWorker = async (input: {
  exportPatches?: boolean;
  inputPath: string;
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  records: CheatRecord[];
  signal?: AbortSignal;
}): Promise<RomWeaverCheatResult> => {
  const command = createRomWeaverCommand("cheat", {
    input: input.inputPath,
    records: input.records,
    ...(input.exportPatches ? { exportPatches: true } : {}),
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Cheat classification failed");
  const parsed = parseCheatCommandResult(result);
  if (input.exportPatches && !parsed.patches) {
    throw new Error("The cheat worker did not return patch snapshots; rebuild the WASM runtime");
  }
  return parsed;
};

export { invokeRomWeaverCheatWorker };
