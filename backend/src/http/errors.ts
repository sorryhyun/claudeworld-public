/**
 * Every failure reaches the client as `{"detail": ...}`. Handlers throw
 * `HttpError` from wherever they are rather than threading result objects up
 * through layers of helper.
 */

/** `detail` is a string for handler-raised errors and an array for 422s. */
export type ErrorDetail = string | ValidationErrorItem[]

// The frontend never reads the contents: `gameService` stringifies the array.
export interface ValidationErrorItem {
  loc: (string | number)[]
  msg: string
  type: string
}

export class HttpError extends Error {
  readonly status: number
  readonly detail: ErrorDetail

  constructor(status: number, detail: ErrorDetail) {
    super(typeof detail === 'string' ? detail : `Validation failed (${detail.length} error(s))`)
    this.name = 'HttpError'
    this.status = status
    this.detail = detail
  }
}

// Separate from the constructor: status and body shape travel together here.
export function validationError(items: ValidationErrorItem[]): HttpError {
  return new HttpError(422, items)
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError
}
