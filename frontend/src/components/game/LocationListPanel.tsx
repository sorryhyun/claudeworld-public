import { useState } from 'react';
import { useGame, Location } from '../../contexts/GameContext';
import { Input } from '../ui/input';

export function LocationListPanel() {
  const {
    locations,
    currentLocation,
    travelTo,
    updateLocationLabel,
    actionInProgress,
  } = useGame();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const discoveredLocations = locations.filter(l => l.is_discovered);
  const adjacentIds = currentLocation?.adjacent_locations || [];

  const handleLabelEdit = (location: Location) => {
    setEditingId(location.id);
    setEditLabel(location.label || '');
  };

  const saveLabel = async (locationId: number) => {
    if (editLabel.trim()) {
      await updateLocationLabel(locationId, editLabel.trim());
    }
    setEditingId(null);
  };

  const handleTravel = async (location: Location) => {
    if (location.id === currentLocation?.id) return;
    if (!adjacentIds.includes(location.id)) return;
    if (actionInProgress) return;
    await travelTo(location.id);
  };

  if (discoveredLocations.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm p-4 text-center">
        <div>
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p>No locations discovered yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {discoveredLocations.map((location) => {
        const isCurrent = location.id === currentLocation?.id;
        const isAdjacent = adjacentIds.includes(location.id);
        const canTravel = !isCurrent && isAdjacent && !actionInProgress;

        return (
          <div
            key={location.id}
            className={`border-b border-slate-200 transition-colors
              ${isCurrent ? 'bg-slate-100' : canTravel ? 'hover:bg-slate-50 cursor-pointer' : ''}
            `}
            onClick={() => canTravel && handleTravel(location)}
          >
            <div className="p-3">
              <div className="flex items-center justify-between gap-2">
                {editingId === location.id ? (
                  <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      onBlur={() => saveLabel(location.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveLabel(location.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="text-sm h-8"
                      autoFocus
                      placeholder="Location label..."
                    />
                  </div>
                ) : (
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-800 truncate">
                      {location.label || location.name}
                    </p>
                    {location.label && (
                      <p className="text-xs text-slate-500 truncate">{location.name}</p>
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
                    <span className="text-slate-600" title="Current location">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                      </svg>
                    </span>
                  )}

                  {/* Edit Label Button */}
                  {!editingId && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLabelEdit(location);
                      }}
                      className="p-1.5 hover:bg-slate-200 rounded-md text-slate-400 hover:text-slate-600 transition-colors"
                      title="Edit label"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Travel indicator */}
              {canTravel && (
                <p className="text-xs text-blue-600 mt-1.5 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                  Click to travel
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
