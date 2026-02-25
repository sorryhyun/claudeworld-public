# Backend Cleanup Plan - Remaining Items

Items identified during backend audit but deferred from the initial cleanup pass.
Initial pass removed ~450 lines (write_queue, AgentNotFoundError, delete_agents_by_world, Agent.from_db_model, lock_key parameter, LocationService facade).

---

## Medium Priority

### WorldFacade passthrough removal
- **File**: `backend/services/facades/world_facade.py` (~486 lines)
- **Issue**: Most methods are thin orchestration wrappers (sync_from_fs, enter_world, delete_world) that could be inlined into router handlers
- **Approach**: Move orchestration logic directly into `routers/game/worlds.py`; delete facade
- **Risk**: Low — methods are sequential calls with no complex logic

### TransientStateService consolidation
- **File**: `backend/services/transient_state_service.py` (~181 lines)
- **Issue**: Wrapper around `_state.json` I/O. Most methods are one-liners delegating to file read/write. Already tightly coupled with RoomMappingService.
- **Approach**: Merge into RoomMappingService (which already imports and uses TransientStateService)
- **Risk**: Low — functional merge, no behavior change

---

## Low Priority

### CatalogService (Phase 2 speculative code)
- **File**: `backend/services/catalog_service.py` (~80 lines)
- **Issue**: Loads equipment slots, time domains, recharge events — zero current usage in gameplay loop
- **Approach**: Delete or move to `backend/future/` until Phase 2 begins

### PlayerFacade Phase 2 equipment methods
- **File**: `backend/services/facades/player_facade.py` (~180 lines of equipment code)
- **Issue**: `equip_item_to_slot()`, `unequip_from_slot()`, `use_item_affordance()`, `get_equipment()` — premature abstraction for future equipment system
- **Approach**: Remove equipment methods, keep core stat/inventory methods

### LocationStorage verbosity
- **File**: `backend/services/location_storage.py` (~268 lines)
- **Issue**: Some internal helper methods could be consolidated (~80-100 lines reducible)
- **Approach**: Inline small helpers, reduce method count
- **Risk**: Very low but also low impact

---

## Verified as Justified (Keep)

- **PlayerService** — mtime-based caching provides real performance benefit
- **WorldService** — essential FS-primary architecture cornerstone
- **RoomMappingService** — fuzzy location matching justifies dedicated service
- **All routers** — no dead endpoints found (44 endpoints, all active)
- **All schemas** — all actively used
- **services/__init__.py** — all 7 re-exports are used
