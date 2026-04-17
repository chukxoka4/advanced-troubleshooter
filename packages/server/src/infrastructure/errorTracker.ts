import * as Sentry from "@sentry/node";
import { rootLogger } from "./logger.js";

/**
 * Sentry wrapper. `SENTRY_DSN` controls activation: unset in prototype means
 * every method here is a no-op; set in production means errors flow to Sentry.
 * Callers never branch on environment — they just call captureException().
 */

let initialized = false;

export function initErrorTracker(): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    rootLogger.info({ sentry: "disabled" }, "error tracker: SENTRY_DSN unset, running as no-op");
    initialized = true;
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.APP_MODE ?? "unknown",
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  rootLogger.info({ sentry: "enabled" }, "error tracker initialised");
  initialized = true;
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export function captureMessage(message: string, context?: Record<string, unknown>): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureMessage(message, context ? { extra: context } : undefined);
}

/**
 * Test-only hook that resets initialization state so `initErrorTracker` can
 * run multiple times under different env in a single process.
 */
export function _resetForTests(): void {
  initialized = false;
}
