import { getEmulatorJsCore } from "./components/emulatorjs.ts";

// Keep browser test copies bounded so a large disc does not consume the session's OPFS quota twice.
const EMULATOR_RETENTION_MAX_BYTES = 128 * 1024 * 1024;

const shouldRetainEmulatorOutput = ({
  fileName,
  platform,
  size,
}: {
  fileName: string;
  platform?: string;
  size: number;
}): boolean => size <= EMULATOR_RETENTION_MAX_BYTES && !!getEmulatorJsCore(platform, fileName);

export { shouldRetainEmulatorOutput };
