/** Structured JSON-lines logger (stderr). Never pass secrets as fields. */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.COLAB_LOG_LEVEL as Level) ?? "info"] ?? 20;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (f) => createLogger({ ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = createLogger({}, () => {});
