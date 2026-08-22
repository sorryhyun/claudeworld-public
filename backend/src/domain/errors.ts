/**
 * Error types for the whole backend. `HttpError` lives here, not in `http/`,
 * so that services and domain code can throw one without depending on the
 * transport layer: every failure reaches the client as `{"detail": ...}`,
 * rendered by `app.onError`. Handlers throw `HttpError` from wherever they are
 * rather than threading result objects up through layers of helper.
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

/** 409. Room names are unique per owner. */
export class RoomAlreadyExistsError extends HttpError {
  constructor(roomName: string) {
    super(409, `Room with name '${roomName}' already exists`)
    this.name = 'RoomAlreadyExistsError'
  }
}

export class RoomNotFoundError extends HttpError {
  constructor(roomId: number) {
    super(404, `Room with id ${roomId} not found`)
    this.name = 'RoomNotFoundError'
  }
}

/**
 * Plain `Error`, not `HttpError`: raised on startup and hot-reload paths where
 * there is no request to answer, so reaching `onError` as a 500 is correct.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`)
    this.name = 'ConfigurationError'
  }
}
