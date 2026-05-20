/* Rom Patcher JS - Z3DS conversion worker */

import {
  attachCompressionWorker,
  completeCompressionOperation,
  createStandardCompressionWorkerHandlers,
} from "../shared/rpc/compression-worker-dispatcher.ts";
import { waitForAzaharZ3dsModule } from "./azahar-z3ds-toolchain.ts";
import { runCreateZ3ds, runExtractZ3ds, runListZ3ds } from "./z3ds-operations.ts";

const handlers = {
  ...createStandardCompressionWorkerHandlers({
    cleanupOpfsOutput: true,
    create: runCreateZ3ds,
    extract: runExtractZ3ds,
    kind: "azahar-z3ds",
    waitForModule: waitForAzaharZ3dsModule,
  }),
  list: async (data: Parameters<typeof runListZ3ds>[0]) => {
    completeCompressionOperation("azahar-z3ds", data, "list", { entries: await runListZ3ds(data) });
  },
};

attachCompressionWorker({ handlers, kind: "azahar-z3ds" });
