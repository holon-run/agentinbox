export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const LOG_LEVELS = new Set<LogLevel>(["error", "warn", "info", "debug", "trace"]);
const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface Logger {
  level: LogLevel;
  enabled(level: LogLevel): boolean;
  child(component: string): Logger;
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  trace(event: string, fields?: Record<string, unknown>): void;
}

export class NoopLogger implements Logger {
  constructor(public readonly level: LogLevel = DEFAULT_LOG_LEVEL) {}

  enabled(_level: LogLevel): boolean {
    return false;
  }

  child(_component: string): Logger {
    return this;
  }

  error(_event: string, _fields?: Record<string, unknown>): void {}
  warn(_event: string, _fields?: Record<string, unknown>): void {}
  info(_event: string, _fields?: Record<string, unknown>): void {}
  debug(_event: string, _fields?: Record<string, unknown>): void {}
  trace(_event: string, _fields?: Record<string, unknown>): void {}
}

export class JsonLogger implements Logger {
  constructor(
    public readonly level: LogLevel,
    private readonly component: string,
    private readonly writeLine: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  enabled(level: LogLevel): boolean {
    return LOG_LEVEL_RANK[level] <= LOG_LEVEL_RANK[this.level];
  }

  child(component: string): Logger {
    return new JsonLogger(this.level, `${this.component}.${component}`, this.writeLine);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  trace(event: string, fields?: Record<string, unknown>): void {
    this.log("trace", event, fields);
  }

  private log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (!this.enabled(level)) {
      return;
    }
    this.writeLine(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      event,
      ...(fields ? serializeFields(fields) : {}),
    }));
  }
}

export function parseLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (LOG_LEVELS.has(normalized as LogLevel)) {
    return normalized as LogLevel;
  }
  return fallback;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.has(value as LogLevel);
}

export function defaultLogLevel(): LogLevel {
  return DEFAULT_LOG_LEVEL;
}

function serializeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeValue(value)]),
  );
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, serializeValue(nested)]),
    );
  }
  return value;
}
