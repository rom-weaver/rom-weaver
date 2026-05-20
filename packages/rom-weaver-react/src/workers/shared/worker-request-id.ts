let sharedWorkerIdSequence = 0;

const createWorkerRequestId = (prefix = "request") => `${prefix}-${++sharedWorkerIdSequence}`;

const createWorkId = (prefix: string) => createWorkerRequestId(prefix);

export { createWorkerRequestId, createWorkId };
