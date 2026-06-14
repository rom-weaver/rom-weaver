let sharedWorkerIdSequence = 0;

const createWorkerRequestId = (prefix = "request") => `${prefix}-${++sharedWorkerIdSequence}`;

export { createWorkerRequestId };
