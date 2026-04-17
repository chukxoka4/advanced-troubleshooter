import { describe, it, expect } from "vitest";
import { APP_MODES, InvalidAppModeError, parseAppMode } from "./appMode.js";

describe("parseAppMode", () => {
  it("accepts 'prototype'", () => {
    expect(parseAppMode("prototype")).toBe("prototype");
  });

  it("accepts 'production'", () => {
    expect(parseAppMode("production")).toBe("production");
  });

  it("normalises mixed-case input", () => {
    expect(parseAppMode("Prototype")).toBe("prototype");
    expect(parseAppMode("PRODUCTION")).toBe("production");
  });

  it("throws InvalidAppModeError on undefined", () => {
    expect(() => parseAppMode(undefined)).toThrow(InvalidAppModeError);
  });

  it("throws InvalidAppModeError on empty string", () => {
    expect(() => parseAppMode("")).toThrow(InvalidAppModeError);
  });

  it("throws InvalidAppModeError on unknown value", () => {
    expect(() => parseAppMode("staging")).toThrow(InvalidAppModeError);
    expect(() => parseAppMode("dev")).toThrow(InvalidAppModeError);
  });

  it("error message mentions the invalid value and the accepted values", () => {
    try {
      parseAppMode("staging");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAppModeError);
      const msg = (err as Error).message;
      expect(msg).toContain("staging");
      for (const mode of APP_MODES) expect(msg).toContain(mode);
    }
  });
});
