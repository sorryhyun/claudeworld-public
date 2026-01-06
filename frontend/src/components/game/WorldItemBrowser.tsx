import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { WorldItem } from "../../contexts/GameContext";

interface WorldItemBrowserProps {
  items: WorldItem[];
  playerInventoryIds?: Set<string>; // IDs of items the player owns
}

// Rarity colors
const RARITY_COLORS: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  common: {
    bg: "bg-slate-50",
    text: "text-slate-600",
    border: "border-slate-200",
  },
  uncommon: {
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
  },
  rare: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },
  epic: {
    bg: "bg-purple-50",
    text: "text-purple-700",
    border: "border-purple-200",
  },
  legendary: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
  },
};

// Category icons
const CATEGORY_ICONS: Record<string, string> = {
  weapon: "M5 12l5 5L20 7",
  armor:
    "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  consumable:
    "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z",
  tool: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
  gift: "M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7",
  key: "M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z",
  default: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
};

export function WorldItemBrowser({
  items,
  playerInventoryIds = new Set(),
}: WorldItemBrowserProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterOwned, setFilterOwned] = useState<"all" | "owned" | "not_owned">(
    "all",
  );

  // Filter and search items
  const filteredItems = useMemo(() => {
    let result = items;

    // Filter by ownership
    if (filterOwned === "owned") {
      result = result.filter((item) => playerInventoryIds.has(item.id));
    } else if (filterOwned === "not_owned") {
      result = result.filter((item) => !playerInventoryIds.has(item.id));
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.description?.toLowerCase().includes(query) ||
          item.category?.toLowerCase().includes(query) ||
          item.tags?.some((tag) => tag.toLowerCase().includes(query)),
      );
    }

    return result;
  }, [items, searchQuery, filterOwned, playerInventoryIds]);

  if (items.length === 0) {
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
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
        <p className="text-sm text-slate-500">
          {t("worldItems.empty", "No items in this world")}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          {t("worldItems.emptyHint", "Items will appear as they are created")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search Input */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("worldItems.search", "Search items...")}
          className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-300 focus:border-transparent"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Filter Buttons */}
      {playerInventoryIds.size > 0 && (
        <div className="flex gap-1">
          <button
            onClick={() => setFilterOwned("all")}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              filterOwned === "all"
                ? "bg-slate-700 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {t("worldItems.filterAll", "All")}
          </button>
          <button
            onClick={() => setFilterOwned("owned")}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              filterOwned === "owned"
                ? "bg-emerald-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {t("worldItems.filterOwned", "Owned")}
          </button>
          <button
            onClick={() => setFilterOwned("not_owned")}
            className={`flex-1 px-2 py-1.5 text-xs rounded-md transition-colors ${
              filterOwned === "not_owned"
                ? "bg-slate-500 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {t("worldItems.filterNotOwned", "Not Owned")}
          </button>
        </div>
      )}

      {/* Results Count */}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {filteredItems.length} / {items.length}{" "}
          {t("worldItems.itemsCount", "items")}
        </span>
        {searchQuery && filteredItems.length === 0 && (
          <span className="text-amber-500">
            {t("worldItems.noResults", "No matches")}
          </span>
        )}
      </div>

      {/* Items List */}
      <div className="space-y-2">
        {filteredItems.map((item) => {
          const isOwned = playerInventoryIds.has(item.id);
          const rarity = item.rarity || "common";
          const rarityColors = RARITY_COLORS[rarity] || RARITY_COLORS.common;
          const categoryIcon =
            CATEGORY_ICONS[item.category || "default"] ||
            CATEGORY_ICONS.default;
          const isExpanded = expandedId === item.id;

          return (
            <div
              key={item.id}
              className={`rounded-lg border transition-all overflow-hidden ${rarityColors.bg} ${rarityColors.border}`}
            >
              <button
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
                className="w-full p-2.5 text-left"
              >
                <div className="flex items-start gap-2">
                  {/* Category Icon */}
                  <div
                    className={`shrink-0 w-8 h-8 rounded-md flex items-center justify-center ${rarityColors.bg} border ${rarityColors.border}`}
                  >
                    <svg
                      className={`w-4 h-4 ${rarityColors.text}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={categoryIcon}
                      />
                    </svg>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-medium text-sm ${rarityColors.text} truncate`}
                      >
                        {item.name}
                      </span>
                      {isOwned && (
                        <span
                          className="shrink-0 text-emerald-500"
                          title={t("worldItems.owned", "In your inventory")}
                        >
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
                      {item.rarity && item.rarity !== "common" && (
                        <span
                          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold ${rarityColors.text} ${rarityColors.bg} border ${rarityColors.border}`}
                        >
                          {item.rarity}
                        </span>
                      )}
                    </div>
                    {item.description && !isExpanded && (
                      <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                        {item.description}
                      </p>
                    )}
                    {/* Tags */}
                    {item.tags && item.tags.length > 0 && !isExpanded && (
                      <div className="flex gap-1 mt-1">
                        {item.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded"
                          >
                            {tag}
                          </span>
                        ))}
                        {item.tags.length > 3 && (
                          <span className="text-[10px] text-slate-400">
                            +{item.tags.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <svg
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
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

              {/* Expanded Content */}
              {isExpanded && (
                <div className="px-2.5 pb-2.5 border-t border-slate-100/50">
                  {item.description && (
                    <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                      {item.description}
                    </p>
                  )}

                  {/* Category */}
                  {item.category && (
                    <div className="mt-2">
                      <span className="text-xs text-slate-400">
                        {t("worldItems.category", "Category")}:{" "}
                      </span>
                      <span className="text-xs font-medium text-slate-600 capitalize">
                        {item.category}
                      </span>
                    </div>
                  )}

                  {/* Tags */}
                  {item.tags && item.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Equippable Info */}
                  {item.equippable && (
                    <div className="mt-2 p-2 bg-white/50 rounded border border-slate-100">
                      <p className="text-xs font-medium text-slate-500 mb-1">
                        {t("worldItems.equippable", "Equippable")} -{" "}
                        {item.equippable.slot}
                      </p>
                      {item.equippable.passive_effects &&
                        Object.keys(item.equippable.passive_effects).length >
                          0 && (
                          <div className="space-y-0.5">
                            {Object.entries(
                              item.equippable.passive_effects,
                            ).map(([stat, value]) => (
                              <div
                                key={stat}
                                className="flex justify-between text-xs"
                              >
                                <span className="text-slate-500 capitalize">
                                  {stat.replace(/_/g, " ")}
                                </span>
                                <span
                                  className={`font-medium ${value > 0 ? "text-emerald-600" : "text-red-600"}`}
                                >
                                  {value > 0 ? "+" : ""}
                                  {value}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  )}

                  {/* Default Properties */}
                  {item.default_properties &&
                    Object.keys(item.default_properties).length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-xs font-medium text-slate-500">
                          {t("worldItems.properties", "Properties")}:
                        </p>
                        {Object.entries(item.default_properties).map(
                          ([key, value]) => (
                            <div
                              key={key}
                              className="flex justify-between text-xs"
                            >
                              <span className="text-slate-500 capitalize">
                                {key.replace(/_/g, " ")}
                              </span>
                              <span className="font-medium text-slate-700">
                                {String(value)}
                              </span>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
