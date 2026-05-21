/* RomWeaver - RVZ conversion worker */

import {
  attachCompressionWorker,
  completeCompressionOperation,
  createStandardCompressionWorkerHandlers,
} from "../shared/rpc/compression-worker-dispatcher.ts";
import { waitForDolphinRvzModule } from "./dolphin-rvz-toolchain.ts";
import { runCreateRvz, runExtractRvz, runListRvz } from "./rvz-operations.ts";

const handlers = {
  ...createStandardCompressionWorkerHandlers({
    cleanupOpfsOutput: true,
    create: runCreateRvz,
    extract: runExtractRvz,
    kind: "dolphin-rvz",
    waitForModule: waitForDolphinRvzModule,
  }),
  list: async (data: Parameters<typeof runListRvz>[0]) => {
    completeCompressionOperation("dolphin-rvz", data, "list", { entries: await runListRvz(data) });
  },
};

attachCompressionWorker({ handlers, kind: "dolphin-rvz" });
