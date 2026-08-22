/**
 * Named domain errors. The room errors extend `HttpError`, which `app.onError`
 * renders, so a service can throw one below the router without the handler
 * translating it. The strings here are what the frontend shows.
 */

import { HttpError } from '../http/errors'

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
