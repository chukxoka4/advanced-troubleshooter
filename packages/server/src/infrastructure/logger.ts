import { pino, type Logger, type LoggerOptions, type DestinationStream } from "pino";

/**
 * Request-scoped context fields included on every log line. Any layer that
 * receives a request should attach these via `createLogger()` so log search
 * can trace a single request end-to-end across services, repositories, and
 * middleware.
 */
export interface LogContext {
  request_id?: string;
  tenant_id?: string;
  session_id?: string;
}

const LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();

const baseOptions: LoggerOptions = {
  level: LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "advanced-troubleshooter-server" },
};

/**
 * Root Pino logger. JSON output to stdout. Individual layers should prefer
 * `createLogger(context)` so request/tenant/session fields appear on every
 * line; the root logger is only for boot-time messages emitted before a
 * request context exists.
 */
export const rootLogger: Logger = pino(baseOptions);

/**
 * Internal factory that accepts an alternative destination stream. Exported
 * purely for tests that need to capture output; production code should use
 * `createLogger`.
 */
export function createLoggerWithDestination(
  context: LogContext,
  destination: DestinationStream,
): Logger {
  return pino(baseOptions, destination).child(context);
}

/**
 * Returns a child logger whose every line includes the supplied context
 * fields. Undefined values are dropped so the output is never noisy with
 * empty keys.
 */
export function createLogger(context: LogContext): Logger {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) clean[key] = value;
  }
  return rootLogger.child(clean);
}
