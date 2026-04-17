import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const initMock = vi.fn();
const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();

vi.mock("@sentry/node", () => ({
  init: initMock,
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

const {
  _resetForTests,
  captureException,
  captureMessage,
  initErrorTracker,
} = await import("./errorTracker.js");

describe("errorTracker", () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    _resetForTests();
    initMock.mockReset();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
  });

  it("skips Sentry.init when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;

    initErrorTracker();

    expect(initMock).not.toHaveBeenCalled();
  });

  it("calls Sentry.init exactly once when SENTRY_DSN is set, even across repeat init calls", () => {
    process.env.SENTRY_DSN = "https://public@sentry.example/1";

    initErrorTracker();
    initErrorTracker();

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@sentry.example/1",
        sendDefaultPii: false,
      }),
    );
  });

  it("does not forward to Sentry when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;

    captureException(new Error("boom"));
    captureMessage("hello");

    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("forwards to Sentry when SENTRY_DSN is set", () => {
    process.env.SENTRY_DSN = "https://public@sentry.example/1";

    captureException(new Error("boom"), { route: "/chat" });
    captureMessage("hello", { route: "/chat" });

    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      { extra: { route: "/chat" } },
    );
    expect(captureMessageMock).toHaveBeenCalledWith(
      "hello",
      { extra: { route: "/chat" } },
    );
  });
});
