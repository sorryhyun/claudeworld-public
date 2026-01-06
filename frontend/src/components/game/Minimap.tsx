import { Location } from "../../contexts/GameContext";
import { useGame } from "../../contexts/GameContext";

interface MinimapProps {
  locations: Location[];
  currentLocationId: number | null;
}

export function Minimap({ locations, currentLocationId }: MinimapProps) {
  const { travelTo, actionInProgress } = useGame();

  const discoveredLocations = locations.filter((l) => l.is_discovered);

  if (discoveredLocations.length === 0) {
    return (
      <div className="text-center py-6">
        <svg
          className="w-10 h-10 mx-auto mb-2 text-slate-300"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
          />
        </svg>
        <p className="text-sm text-slate-500">No locations discovered</p>
        <p className="text-xs text-slate-400 mt-1">
          Explore the world to reveal the map
        </p>
      </div>
    );
  }

  // Calculate bounds for grid
  const xs = discoveredLocations.map((l) => l.position_x);
  const ys = discoveredLocations.map((l) => l.position_y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  // Create grid
  const grid: (Location | null)[][] = Array(height)
    .fill(null)
    .map(() => Array(width).fill(null));

  discoveredLocations.forEach((loc) => {
    const x = loc.position_x - minX;
    const y = loc.position_y - minY;
    if (y >= 0 && y < height && x >= 0 && x < width) {
      grid[y][x] = loc;
    }
  });

  // Find current location for adjacent highlighting
  const currentLoc = discoveredLocations.find(
    (l) => l.id === currentLocationId,
  );
  const adjacentIds = currentLoc?.adjacent_locations || [];

  const handleLocationClick = (location: Location) => {
    if (actionInProgress) return;
    if (location.id === currentLocationId) return;
    if (!adjacentIds.includes(location.id)) return;
    travelTo(location.id);
  };

  // Calculate cell size based on grid dimensions
  const maxCellSize = Math.min(48, Math.floor(200 / Math.max(width, height)));
  const cellSize = Math.max(28, maxCellSize);

  return (
    <div className="space-y-3">
      {/* Grid Map */}
      <div className="flex justify-center">
        <div
          className="grid gap-1 p-2 bg-slate-100 rounded-lg"
          style={{
            gridTemplateColumns: `repeat(${width}, ${cellSize}px)`,
          }}
        >
          {grid.map((row, y) =>
            row.map((loc, x) => {
              const isCurrent = loc?.id === currentLocationId;
              const isAdjacent = loc && adjacentIds.includes(loc.id);
              const canTravel = isAdjacent && !isCurrent && !actionInProgress;

              return (
                <div
                  key={`${x}-${y}`}
                  className={`
                    aspect-square rounded-md flex items-center justify-center text-xs font-medium transition-all
                    ${
                      loc
                        ? isCurrent
                          ? "bg-slate-700 text-white cursor-default shadow-md"
                          : canTravel
                            ? "bg-blue-100 text-blue-700 cursor-pointer hover:bg-blue-200 hover:scale-105 border border-blue-300"
                            : "bg-slate-200 text-slate-500 cursor-not-allowed"
                        : "bg-transparent"
                    }
                  `}
                  style={{ width: cellSize, height: cellSize }}
                  onClick={() => loc && canTravel && handleLocationClick(loc)}
                  title={loc ? loc.label || loc.name : undefined}
                >
                  {loc && (
                    <span className="truncate w-full text-center px-0.5">
                      {loc.label?.[0] || loc.name[0]}
                    </span>
                  )}
                </div>
              );
            }),
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex justify-center gap-4 text-xs text-slate-500">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-slate-700 rounded" />
          <span>Current</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-blue-100 border border-blue-300 rounded" />
          <span>Can travel</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-slate-200 rounded" />
          <span>Discovered</span>
        </div>
      </div>

      {/* Location list */}
      <div className="border-t border-slate-200 pt-3 mt-3">
        <p className="text-xs font-medium text-slate-500 mb-2">
          Discovered Locations
        </p>
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {discoveredLocations.map((loc) => {
            const isCurrent = loc.id === currentLocationId;
            const isAdjacent = adjacentIds.includes(loc.id);
            const canTravel = isAdjacent && !isCurrent && !actionInProgress;

            return (
              <button
                key={loc.id}
                onClick={() => canTravel && handleLocationClick(loc)}
                disabled={!canTravel}
                className={`
                  w-full text-xs p-2 rounded-md flex items-center justify-between transition-all text-left
                  ${
                    isCurrent
                      ? "bg-slate-100 font-medium"
                      : canTravel
                        ? "hover:bg-blue-50 cursor-pointer"
                        : "opacity-60 cursor-not-allowed"
                  }
                `}
              >
                <span
                  className={isCurrent ? "text-slate-800" : "text-slate-600"}
                >
                  {loc.label || loc.name}
                </span>
                <div className="flex items-center gap-1">
                  {isCurrent && (
                    <svg
                      className="w-3.5 h-3.5 text-slate-600"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                  {canTravel && (
                    <svg
                      className="w-3.5 h-3.5 text-blue-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
