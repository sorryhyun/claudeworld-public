/**
 * Zod port of `backend/schemas/` — the wire contract, plus the row → response
 * mappers that produce it.
 *
 * Two things to know before using anything here.
 *
 * **The field names are snake_case on purpose.** Everything else in this backend
 * is camelCase, including the Drizzle rows these mappers read. These objects are
 * the JSON the React app parses, and the parity contract freezes that JSON — so
 * the case change happens exactly once, in a mapper, rather than leaking a
 * `snake_case` convention into the service layer or a `camelCase` one onto the
 * wire.
 *
 * **Request schemas are not just "the same fields".** Pydantic validates request
 * bodies in lax mode, which accepts `"5"` for an `int` and `"yes"` for a `bool`;
 * `src/schemas/common.ts` reproduces those rules so no client that works today
 * starts getting a 422 at cutover.
 *
 * Name collisions to be aware of when importing this barrel alongside others:
 * `src/crud/` already exports `RoomCreate`, `WorldCreate`, `LocationCreate`,
 * `MessageCreate`, `AgentCreate` and `AgentUpdate` as camelCase *service-input*
 * interfaces, and `src/db/schema.ts` exports `Agent`, `Room`, `World`,
 * `Location`, `Message` and `PlayerState` as row types. They are different
 * things with the same names — the wire shape and the internal shape — so a
 * module that needs both should import at least one of them namespaced.
 */

export * from './agents'
export * from './common'
export * from './game'
export * from './mcp-tools'
export * from './messages'
export * from './rooms'
