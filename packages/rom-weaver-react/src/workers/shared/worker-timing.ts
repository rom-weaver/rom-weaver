import { createTiming, now, type Timing } from "../../lib/progress/timing.ts";

const createTimingFromStart = (startedAt: number): Timing => createTiming(now() - startedAt);

export { createTimingFromStart, now, type Timing };
