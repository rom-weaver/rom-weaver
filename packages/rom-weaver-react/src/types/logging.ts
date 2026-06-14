const LOG_LEVELS = ["off", "error", "warn", "info", "debug", "trace"] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

type LogDetails = Record<string, unknown>;

type LogRecord = {
  details?: LogDetails;
  level: Exclude<LogLevel, "off">;
  message: string;
  namespace: string;
  timestamp: string;
};

type LogSink = (record: LogRecord) => void;

export type { LogDetails, LogLevel, LogRecord, LogSink };
export { LOG_LEVELS };
