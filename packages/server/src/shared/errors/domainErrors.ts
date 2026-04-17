/**
 * Domain errors. Services throw these; the errorHandler middleware catches
 * them and maps each to its HTTP status. Anything else that reaches the
 * handler is treated as a 500 and reported to Sentry.
 *
 * Keeping the mapping on the class itself (via statusCode) means routes and
 * the error handler never reach for a lookup table — the contract travels
 * with the error.
 */

export abstract class DomainError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends DomainError {
  readonly statusCode = 404;
  readonly code = "not_found";
}

export class ValidationError extends DomainError {
  readonly statusCode = 400;
  readonly code = "validation_error";
}

export class ForbiddenError extends DomainError {
  readonly statusCode = 403;
  readonly code = "forbidden";
}

export class ConflictError extends DomainError {
  readonly statusCode = 409;
  readonly code = "conflict";
}

export class RateLimitError extends DomainError {
  readonly statusCode = 429;
  readonly code = "rate_limited";
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
