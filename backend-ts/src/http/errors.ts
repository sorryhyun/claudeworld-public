/**
 * The HTTP error shape.
 *
 * Port of the way `backend/routers/game/` signals failure. Python raises
 * `fastapi.HTTPException(status_code, detail=...)` and FastAPI's built-in
 * handler renders it as `{"detail": ...}`; `domain/exceptions.py` subclasses
 * that same class, so every failure in the game surface reaches the client in
 * one shape. `HttpError` is that class, and `app.onError` renders it.
 *
 * Handlers therefore keep Python's shape — `throw new HttpError(404, 'World
 * not found')` where the original writes `raise HTTPException(404, "World not
 * found")` — instead of threading result objects back up through helpers that
 * are several calls deep.
 */

/** `detail` is a string for handler-raised errors and an array for 422s. */
export type ErrorDetail = string | ValidationErrorItem[]

/**
 * One entry of FastAPI's 422 body.
 *
 * Pydantic emits `{loc, msg, type}` per failure and the frontend never reads
 * the contents — `gameService` does `error.detail || '<fallback>'`, which
 * stringifies the array. The shape is reproduced so anything inspecting a 422
 * (a test, a future client) sees what it saw before, not so the strings match
 * Pydantic's wording exactly.
 */
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

/**
 * A 422 matching FastAPI's request-validation response.
 *
 * Separate from the `HttpError` constructor because the status and the body
 * shape travel together: a 422 always carries the array, and nothing else
 * does.
 */
export function validationError(items: ValidationErrorItem[]): HttpError {
  return new HttpError(422, items)
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError
}
