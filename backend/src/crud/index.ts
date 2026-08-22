/**
 * The CRUD surface — the TypeScript side of `backend/crud/`.
 *
 * Each module below is a port of its Python namesake. Two of Python's files
 * have no counterpart here on purpose:
 *
 * - `crud/helpers.py` holds one function, `get_room_with_relationships`, which
 *   `crud/rooms.py::get_room` merely delegates to. It is `getRoom` in
 *   `./rooms`; a second exported name for the same query would only give the
 *   two something to drift apart on.
 * - `crud/room_agents.py` is split by concern rather than by file: its
 *   membership half lives in `./rooms` next to the room it mutates, and its
 *   location-membership half in `./locations`.
 *
 * A name missing from this surface means "not yet ported", not "does not
 * exist"; the remaining gap is tracked in `docs/ts-migration-plan.md`.
 */

export * from './agents'
export * from './cached'
export * from './locations'
export * from './messages'
export * from './player-state'
export * from './rooms'
export * from './sessions'
export * from './worlds'
