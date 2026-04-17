import { describe, it, expect } from "vitest";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  isDomainError,
} from "./domainErrors.js";

describe("domain errors", () => {
  const cases: Array<{ Cls: new (msg: string) => DomainError; status: number; code: string }> = [
    { Cls: NotFoundError, status: 404, code: "not_found" },
    { Cls: ValidationError, status: 400, code: "validation_error" },
    { Cls: ForbiddenError, status: 403, code: "forbidden" },
    { Cls: ConflictError, status: 409, code: "conflict" },
    { Cls: RateLimitError, status: 429, code: "rate_limited" },
  ];

  for (const { Cls, status, code } of cases) {
    it(`${Cls.name} has statusCode ${status} and code "${code}"`, () => {
      const err = new Cls("something");
      expect(err).toBeInstanceOf(DomainError);
      expect(err).toBeInstanceOf(Error);
      expect(err.statusCode).toBe(status);
      expect(err.code).toBe(code);
      expect(err.name).toBe(Cls.name);
      expect(err.message).toBe("something");
    });
  }

  it("isDomainError discriminates DomainError subclasses from other errors", () => {
    expect(isDomainError(new NotFoundError("x"))).toBe(true);
    expect(isDomainError(new ValidationError("x"))).toBe(true);
    expect(isDomainError(new Error("generic"))).toBe(false);
    expect(isDomainError("not an error")).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});
