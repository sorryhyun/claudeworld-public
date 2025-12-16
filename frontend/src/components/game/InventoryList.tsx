import { useState } from 'react';
import { InventoryItem, PropertyValue } from '../../contexts/GameContext';

interface InventoryListProps {
  items: InventoryItem[];
}

// Type guard to check if a property value is normalized (has value/higher_is_better)
function isNormalizedProperty(prop: unknown): prop is PropertyValue {
  return (
    typeof prop === 'object' &&
    prop !== null &&
    'value' in prop &&
    'higher_is_better' in prop
  );
}

// Extract display value and higher_is_better from a property
function extractPropertyInfo(prop: unknown): { value: unknown; higherIsBetter: boolean } {
  if (isNormalizedProperty(prop)) {
    return { value: prop.value, higherIsBetter: prop.higher_is_better };
  }
  // Legacy format: assume higher is better by default
  return { value: prop, higherIsBetter: true };
}

export function InventoryList({ items }: InventoryListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className="text-center py-6">
        <svg className="w-10 h-10 mx-auto mb-2 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
        <p className="text-sm text-slate-500">Inventory is empty</p>
        <p className="text-xs text-slate-400 mt-1">Items you collect will appear here</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="bg-white rounded-lg border border-slate-200 hover:border-slate-300 transition-all overflow-hidden"
        >
          <button
            onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
            className="w-full p-3 text-left"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-slate-800 truncate">
                    {item.name}
                  </span>
                  {item.quantity > 1 && (
                    <span className="shrink-0 text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
                      x{item.quantity}
                    </span>
                  )}
                </div>
                {item.description && !expandedId && (
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                    {item.description}
                  </p>
                )}
              </div>
              <svg
                className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
                  expandedId === item.id ? 'rotate-180' : ''
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>

          {/* Expanded content */}
          {expandedId === item.id && (
            <div className="px-3 pb-3 border-t border-slate-100">
              {item.description && (
                <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                  {item.description}
                </p>
              )}
              {item.properties && Object.keys(item.properties).length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-medium text-slate-500">Properties:</p>
                  {Object.entries(item.properties).map(([key, rawValue]) => {
                    const { value, higherIsBetter } = extractPropertyInfo(rawValue);
                    return (
                      <div key={key} className="flex justify-between text-xs">
                        <span className="text-slate-500 capitalize">{key.replace(/_/g, ' ')}</span>
                        <span className={`font-medium flex items-center gap-0.5 ${
                          higherIsBetter ? 'text-emerald-600' : 'text-amber-600'
                        }`}>
                          {String(value)}
                          <span className="text-[10px] opacity-70">
                            {higherIsBetter ? '↑' : '↓'}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Item count */}
      <div className="text-center pt-2">
        <p className="text-xs text-slate-400">
          {items.length} item{items.length !== 1 ? 's' : ''} ({items.reduce((sum, i) => sum + i.quantity, 0)} total)
        </p>
      </div>
    </div>
  );
}
