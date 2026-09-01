type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  event?: string;
  [key: string]: unknown;
}

export function createLogger(component: string) {
  function log(level: LogLevel, message: string, fields?: LogFields) {
    const entry = {
      level,
      component,
      message,
      ...fields,
      timestamp: new Date().toISOString(),
    };
    const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    output(JSON.stringify(entry));
  }

  return {
    debug: (msg: string, fields?: LogFields) => log("debug", msg, fields),
    info: (msg: string, fields?: LogFields) => log("info", msg, fields),
    warn: (msg: string, fields?: LogFields) => log("warn", msg, fields),
    error: (msg: string, fields?: LogFields) => log("error", msg, fields),
  };
}
