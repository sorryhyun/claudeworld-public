import { useState, useMemo, useCallback, memo } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import { useGame, Location } from "../../contexts/GameContext";
import { Input } from "../ui/input";

// Virtualization threshold - only virtualize when there are many locations
const VIRTUALIZATION_THRESHOLD = 15;

// Memoized location item component for performance
interface LocationItemProps {
  location: Location;
  isCurrent: boolean;
  isAdjacent: boolean;
  actionInProgress: boolean;
  editingId: number | null;
  editLabel: string;
  onLabelEdit: (location: Location) => void;
  onEditLabelChange: (value: string) => void;
  onSaveLabel: (locationId: number) => void;
  onCancelEdit: () => void;
  onTravel: (location: Location) => void;
  t: (key: string) => string;
}

const LocationItem = memo(function LocationItem({
  location,
  isCurrent,
  isAdjacent,
  actionInProgress,
  editingId,
  editLabel,
  onLabelEdit,
  onEditLabelChange,
  onSaveLabel,
  onCancelEdit,
  onTravel,
  t,
}: LocationItemProps) {
  const canTravel = !isCurrent && isAdjacent && !actionInProgress;
  const isEditing = editingId === location.id;

  return (
    <div
      role="listitem"
      className={`border-b border-slate-200 transition-colors
        ${isCurrent ? "bg-slate-100" : canTravel ? "hover:bg-slate-50 cursor-pointer" : ""}
      `}
      onClick={() => canTravel && onTravel(location)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && canTravel) {
          e.preventDefault();
          onTravel(location);
        }
      }}
      tabIndex={canTravel ? 0 : -1}
      aria-label={`${location.label || location.name}${isCurrent ? ` - ${t("locations.currentLocation")}` : ""}${canTravel ? ` - ${t("locations.clickToTravel")}` : ""}`}
    >
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          {isEditing ? (
            <div className="flex-1" onClick={(e) => e.stopPropagation()}>
              <Input
                value={editLabel}
                onChange={(e) => onEditLabelChange(e.target.value)}
                onBlur={() => onSaveLabel(location.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveLabel(location.id);
                  if (e.key === "Escape") onCancelEdit();
                }}
                className="text-sm h-8"
                autoFocus
                placeholder={t("locations.labelPlaceholder")}
                aria-label={t("accessibility.editLabel")}
              />
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm text-slate-800 truncate">
                {location.label || location.name}
              </p>
              {location.label && (
                <p className="text-xs text-slate-500 truncate">
                  {location.name}
                </p>
              )}
              {location.description && (
                <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                  {location.description}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-1 shrink-0">
            {isCurrent && (
              <span className="text-slate-600" aria-hidden="true">
                <svg
                  className="w-4 h-4"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
            )}

            {/* Edit Label Button */}
            {!editingId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onLabelEdit(location);
                }}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-slate-200 rounded-md text-slate-400 hover:text-slate-600 transition-colors"
                aria-label={t("accessibility.editLabel")}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Travel indicator */}
        {canTravel && (
          <p
            className="text-xs text-blue-600 mt-1.5 flex items-center gap-1"
            aria-hidden="true"
          >
            <svg
              className="w-3 h-3"
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
            {t("locations.clickToTravel")}
          </p>
        )}
      </div>
    </div>
  );
});

export function LocationListPanel() {
  const { t } = useTranslation();
  const {
    locations,
    currentLocation,
    travelTo,
    updateLocationLabel,
    actionInProgress,
  } = useGame();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");

  // Memoize filtered locations
  const discoveredLocations = useMemo(
    () => locations.filter((l) => l.is_discovered),
    [locations],
  );

  // Memoize adjacent IDs set for O(1) lookup
  const adjacentIds = useMemo(
    () => new Set(currentLocation?.adjacent_locations || []),
    [currentLocation?.adjacent_locations],
  );

  const handleLabelEdit = useCallback((location: Location) => {
    setEditingId(location.id);
    setEditLabel(location.label || "");
  }, []);

  const handleEditLabelChange = useCallback((value: string) => {
    setEditLabel(value);
  }, []);

  const saveLabel = useCallback(
    async (locationId: number) => {
      if (editLabel.trim()) {
        await updateLocationLabel(locationId, editLabel.trim());
      }
      setEditingId(null);
    },
    [editLabel, updateLocationLabel],
  );

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleTravel = useCallback(
    async (location: Location) => {
      if (location.id === currentLocation?.id) return;
      if (!adjacentIds.has(location.id)) return;
      if (actionInProgress) return;
      await travelTo(location.id);
    },
    [currentLocation?.id, adjacentIds, actionInProgress, travelTo],
  );

  // Virtualized item renderer
  const itemContent = useCallback(
    (index: number) => {
      const location = discoveredLocations[index];
      return (
        <LocationItem
          key={location.id}
          location={location}
          isCurrent={location.id === currentLocation?.id}
          isAdjacent={adjacentIds.has(location.id)}
          actionInProgress={actionInProgress}
          editingId={editingId}
          editLabel={editLabel}
          onLabelEdit={handleLabelEdit}
          onEditLabelChange={handleEditLabelChange}
          onSaveLabel={saveLabel}
          onCancelEdit={cancelEdit}
          onTravel={handleTravel}
          t={t}
        />
      );
    },
    [
      discoveredLocations,
      currentLocation?.id,
      adjacentIds,
      actionInProgress,
      editingId,
      editLabel,
      handleLabelEdit,
      handleEditLabelChange,
      saveLabel,
      cancelEdit,
      handleTravel,
      t,
    ],
  );

  if (discoveredLocations.length === 0) {
    return (
      <div
        className="flex-1 flex items-center justify-center text-slate-400 text-sm p-4 text-center"
        role="status"
      >
        <div>
          <svg
            className="w-12 h-12 mx-auto mb-3 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          <p>{t("locations.noLocations")}</p>
        </div>
      </div>
    );
  }

  // Use virtualization only for large lists
  const shouldVirtualize =
    discoveredLocations.length >= VIRTUALIZATION_THRESHOLD;

  if (shouldVirtualize) {
    return (
      <div
        className="flex-1 h-full"
        role="list"
        aria-label={t("gameState.tabs.places")}
      >
        <Virtuoso
          data={discoveredLocations}
          totalCount={discoveredLocations.length}
          itemContent={itemContent}
          overscan={50}
          className="h-full"
        />
      </div>
    );
  }

  // Regular rendering for small lists
  return (
    <div
      className="flex-1 overflow-y-auto"
      role="list"
      aria-label={t("gameState.tabs.places")}
    >
      {discoveredLocations.map((location) => (
        <LocationItem
          key={location.id}
          location={location}
          isCurrent={location.id === currentLocation?.id}
          isAdjacent={adjacentIds.has(location.id)}
          actionInProgress={actionInProgress}
          editingId={editingId}
          editLabel={editLabel}
          onLabelEdit={handleLabelEdit}
          onEditLabelChange={handleEditLabelChange}
          onSaveLabel={saveLabel}
          onCancelEdit={cancelEdit}
          onTravel={handleTravel}
          t={t}
        />
      ))}
    </div>
  );
}
