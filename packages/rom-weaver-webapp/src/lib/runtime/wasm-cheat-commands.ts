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
};

const parseCheatCommandResult = (result: RomWeaverJsonResult): RomWeaverCheatResult => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : undefined);
  const cheats = asRecord(details?.cheats);
  if (!(cheats && Array.isArray(cheats.records) && Array.isArray(cheats.conflicts))) {
    throw withRomWeaverFailureKind(new Error("Cheat classification result was missing or malformed"), result);
  }
  return {
    conflicts: cheats.conflicts as CheatWriteConflict[],
    records: cheats.records as ClassifiedCheatRecord[],
  };
};

const invokeRomWeaverCheatWorker = async (input: {
  inputPath: string;
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  records: CheatRecord[];
  signal?: AbortSignal;
}): Promise<RomWeaverCheatResult> => {
  const command = createRomWeaverCommand("cheat", {
    input: input.inputPath,
    records: input.records,
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
  return parseCheatCommandResult(result);
};

export { invokeRomWeaverCheatWorker };
