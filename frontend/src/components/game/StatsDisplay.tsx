import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  StatDefinition,
  InventoryItem,
  PropertyValue,
} from "../../contexts/GameContext";

interface StatsDisplayProps {
  definitions: StatDefinition[];
  current: Record<string, number>;
  inventory?: InventoryItem[];
  equipment?: Record<string, string | null> | null;
}

// Type guard to check if a property value is normalized (has value/higher_is_better)
function isNormalizedProperty(prop: unknown): prop is PropertyValue {
  return (
    typeof prop === "object" &&
    prop !== null &&
    "value" in prop &&
    "higher_is_better" in prop
  );
}

// Extract display value and higher_is_better from a property
function extractPropertyInfo(prop: unknown): {
  value: unknown;
  higherIsBetter: boolean;
} {
  if (isNormalizedProperty(prop)) {
    return { value: prop.value, higherIsBetter: prop.higher_is_better };
  }
  return { value: prop, higherIsBetter: true };
}

export function StatsDisplay({
  definitions,
  current,
  inventory = [],
  equipment = {},
}: StatsDisplayProps) {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Get set of equipped item IDs
  const equippedItemIds = new Set(
    Object.values(equipment || {}).filter((id): id is string => id !== null),
  );

  // Split inventory into equipped and unequipped
  const equippedItems = inventory.filter((item) =>
    equippedItemIds.has(item.id),
  );
  const unequippedItems = inventory.filter(
    (item) => !equippedItemIds.has(item.id),
  );

  return (
    <div className="space-y-6">
      {/* Stats Section */}
      {definitions.length > 0 && (
        <div className="space-y-4">
          {definitions.map((stat) => {
            const value = current[stat.name] ?? stat.default;
            const percentage = stat.max ? (value / stat.max) * 100 : null;

            return (
              <div key={stat.name} className="group">
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="font-medium text-slate-700">
                    {stat.display}
                  </span>
                  <span className="text-slate-500 tabular-nums">
                    {value}
                    {stat.max && (
                      <span className="text-slate-400"> / {stat.max}</span>
                    )}
                  </span>
                </div>

                {stat.max && percentage !== null && (
                  <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                    <div
                      className={`h-full transition-all duration-500 ease-out ${getStatColor(stat.name, percentage)}`}
                      style={{
                        width: `${Math.min(100, Math.max(0, percentage))}%`,
                      }}
                    />
                  </div>
                )}

                {percentage !== null && percentage < 25 && (
                  <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                    <svg
                      className="w-3 h-3"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t("stats.low", "Low!")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {definitions.length === 0 && inventory.length === 0 && (
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
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <p className="text-sm text-slate-500">
            {t("stats.noStats", "No stats defined yet")}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {t("stats.noStatsHint", "Stats will appear after world setup")}
          </p>
        </div>
      )}

      {/* Inventory Section */}
      {inventory.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              {t("stats.inventory", "Inventory")}
            </h3>
            <span className="text-xs text-slate-400">
              {inventory.length} {t("stats.items", "items")}
            </span>
          </div>

          {/* Equipped Items */}
          {equippedItems.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                <svg
                  className="w-3 h-3"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
                {t("stats.equipped", "Equipped")}
              </p>
              {equippedItems.map((item) => (
                <InventoryItemCard
                  key={item.id}
                  item={item}
                  isEquipped={true}
                  isExpanded={expandedId === item.id}
                  onToggle={() =>
                    setExpandedId(expandedId === item.id ? null : item.id)
                  }
                />
              ))}
            </div>
          )}

          {/* Unequipped Items */}
          {unequippedItems.length > 0 && (
            <div className="space-y-1.5">
              {equippedItems.length > 0 && (
                <p className="text-xs text-slate-400 font-medium">
                  {t("stats.unequipped", "Unequipped")}
                </p>
              )}
              {unequippedItems.map((item) => (
                <InventoryItemCard
                  key={item.id}
                  item={item}
                  isEquipped={false}
                  isExpanded={expandedId === item.id}
                  onToggle={() =>
                    setExpandedId(expandedId === item.id ? null : item.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface InventoryItemCardProps {
  item: InventoryItem;
  isEquipped: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

function InventoryItemCard({
  item,
  isEquipped,
  isExpanded,
  onToggle,
}: InventoryItemCardProps) {
  return (
    <div
      className={`rounded-lg border transition-all overflow-hidden ${
        isEquipped
          ? "bg-emerald-50 border-emerald-200 hover:border-emerald-300"
          : "bg-white border-slate-200 hover:border-slate-300"
      }`}
    >
      <button onClick={onToggle} className="w-full p-2.5 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isEquipped && (
                <span className="shrink-0 text-emerald-500">
                  <svg
                    className="w-3.5 h-3.5"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              )}
              <span className="font-medium text-sm text-slate-800 truncate">
                {item.name}
              </span>
              {item.quantity > 1 && (
                <span className="shrink-0 text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
                  x{item.quantity}
                </span>
              )}
            </div>
            {item.description && !isExpanded && (
              <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                {item.description}
              </p>
            )}
          </div>
          <svg
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
              isExpanded ? "rotate-180" : ""
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="px-2.5 pb-2.5 border-t border-slate-100">
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
                const isNumeric = typeof value === "number";
                return (
                  <div key={key} className="flex justify-between text-xs">
                    <span className="text-slate-500 capitalize">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span
                      className={`font-medium flex items-center gap-0.5 ${
                        isNumeric
                          ? higherIsBetter
                            ? "text-emerald-600"
                            : "text-amber-600"
                          : "text-slate-700"
                      }`}
                    >
                      {String(value)}
                      {isNumeric && (
                        <span className="text-[10px] opacity-70">
                          {higherIsBetter ? "↑" : "↓"}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getStatColor(statName: string, percentage: number): string {
  const lowerName = statName.toLowerCase();

  // Health-like stats
  if (
    ["health", "hp", "vitality", "life", "hitpoints"].some((s) =>
      lowerName.includes(s),
    )
  ) {
    if (percentage < 25) return "bg-red-500";
    if (percentage < 50) return "bg-yellow-500";
    return "bg-green-500";
  }

  // Mana/Energy-like stats
  if (
    ["mana", "mp", "magic", "energy", "stamina", "sp"].some((s) =>
      lowerName.includes(s),
    )
  ) {
    return "bg-blue-500";
  }

  // Mental stats
  if (
    ["sanity", "stress", "fear", "morale", "willpower"].some((s) =>
      lowerName.includes(s),
    )
  ) {
    if (percentage < 25) return "bg-purple-700";
    if (percentage < 50) return "bg-purple-500";
    return "bg-purple-300";
  }

  // Currency/Resources
  if (
    ["gold", "money", "coins", "currency"].some((s) => lowerName.includes(s))
  ) {
    return "bg-amber-500";
  }

  // Experience
  if (["exp", "experience", "xp"].some((s) => lowerName.includes(s))) {
    return "bg-emerald-500";
  }

  // Default
  return "bg-slate-500";
}
