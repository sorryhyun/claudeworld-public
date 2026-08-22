/**
 * Room-key formatting for the `_state.json` room mappings. Keys are
 * `onboarding`, `location:{folder}` or `chat:{agent}`; only the location form
 * is derived from other data, so only it lives here. Pure string functions —
 * `services/room-mapping.ts` owns the state file these keys index.
 */

const LOCATION_PREFIX = 'location:'

export function locationToRoomKey(locationName: string): string {
  return `${LOCATION_PREFIX}${locationName}`
}

/** `null` for any key that is not a `location:` key. */
export function roomKeyToLocation(roomKey: string): string | null {
  return roomKey.startsWith(LOCATION_PREFIX) ? roomKey.slice(LOCATION_PREFIX.length) : null
}

export function isLocationRoomKey(roomKey: string): boolean {
  return roomKey.startsWith(LOCATION_PREFIX)
}
