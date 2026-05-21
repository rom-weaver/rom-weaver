/* RomWeaver - disc conversion worker */

import {
  attachCompressionWorker,
  completeCompressionOperation,
  createStandardCompressionWorkerHandlers,
} from "../shared/rpc/compression-worker-dispatcher.ts";
import { waitForChdmanModule } from "./chdman-toolchain.ts";
import { runCreate, runExtract, runList } from "./operations/chd-operations.ts";

const handlers = {
  ...createStandardCompressionWorkerHandlers({
    cleanupOpfsOutput: true,
    create: runCreate,
    extract: runExtract,
    kind: "chdman",
    waitForModule: waitForChdmanModule,
  }),
  list: async (data: Parameters<typeof runList>[0]) => {
    completeCompressionOperation("chdman", data, "list", { entries: await runList(data) });
  },
};

attachCompressionWorker({ handlers, kind: "chdman" });
