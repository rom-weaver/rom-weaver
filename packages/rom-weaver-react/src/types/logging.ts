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

type Logger = {
  debug: (message: string, details?: LogDetails) => void;
  error: (message: string, details?: LogDetails) => void;
  info: (message: string, details?: LogDetails) => void;
  trace: (message: string, details?: LogDetails) => void;
  warn: (message: string, details?: LogDetails) => void;
};

type LoggingSettings = {
  level?: LogLevel;
  namespace?: string;
  sink?: LogSink;
};

export type { LogDetails, Logger, LoggingSettings, LogLevel, LogRecord, LogSink };
export { LOG_LEVELS };
