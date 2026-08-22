/**
 * Named domain errors. Port of `backend/domain/exceptions.py`.
 *
 * The two room errors subclass `HTTPException` in Python, which means raising
 * one anywhere below the router is enough to produce the right status and the
 * standard `{"detail": ...}` body. `HttpError` from `src/http/errors.ts` is
 * this port's equivalent and `app.onError` renders it, so extending it keeps
 * that property: a service can throw `RoomNotFoundError` without the handler
 * knowing it needs translating.
 *
 * The value over `new HttpError(404, ...)` at each site is that the message
 * text is written once — the strings below are what the frontend shows.
 */

import { HttpError } from '../http/errors'

/** 409. Room names are unique per owner; this is the create-path collision. */
export class RoomAlreadyExistsError extends HttpError {
  constructor(roomName: string) {
    super(409, `Room with name '${roomName}' already exists`)
    this.name = 'RoomAlreadyExistsError'
  }
}

/** 404. */
export class RoomNotFoundError extends HttpError {
  constructor(roomId: number) {
    super(404, `Room with id ${roomId} not found`)
    this.name = 'RoomNotFoundError'
  }
}

/**
 * A malformed or missing config value.
 *
 * Plain `Error`, not `HttpError`: Python subclasses `ValueError`, and it is
 * raised while parsing YAML and agent folders — startup and hot-reload paths
 * where there is no request to answer. Letting it reach `onError` as an
 * unhandled error (a 500) is the correct outcome, and mirrors Python.
 *
 * The `"Configuration error: "` prefix is applied in the constructor, matching
 * `exceptions.py:26`, so callers pass the bare cause.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`)
    this.name = 'ConfigurationError'
  }
}
