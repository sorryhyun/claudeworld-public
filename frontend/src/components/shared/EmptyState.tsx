import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Icon components for different variants
const icons = {
  inventory: (
    <svg
      className="w-12 h-12"
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
  ),
  locations: (
    <svg
      className="w-12 h-12"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
      />
    </svg>
  ),
  messages: (
    <svg
      className="w-12 h-12"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  ),
  agents: (
    <svg
      className="w-12 h-12"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
      />
    </svg>
  ),
  stats: (
    <svg
      className="w-12 h-12"
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
  ),
  adventure: (
    <svg
      className="w-12 h-12"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
      />
    </svg>
  ),
  search: (
    <svg
      className="w-12 h-12"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  ),
  generic: (
    <svg
      className="w-12 h-12"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
      />
    </svg>
  ),
};

export type EmptyStateVariant = keyof typeof icons;

interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title?: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  icon?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeClasses = {
  sm: {
    container: "py-6 px-4",
    icon: "w-10 h-10",
    title: "text-sm",
    description: "text-xs",
    button: "px-3 py-1.5 text-xs",
  },
  md: {
    container: "py-8 px-4",
    icon: "w-12 h-12",
    title: "text-base",
    description: "text-sm",
    button: "px-4 py-2 text-sm",
  },
  lg: {
    container: "py-12 px-6",
    icon: "w-16 h-16",
    title: "text-lg",
    description: "text-base",
    button: "px-5 py-2.5 text-sm",
  },
};

// Default content for each variant
const defaultContent: Record<
  EmptyStateVariant,
  { titleKey: string; descriptionKey: string }
> = {
  inventory: {
    titleKey: "emptyState.inventory.title",
    descriptionKey: "emptyState.inventory.description",
  },
  locations: {
    titleKey: "emptyState.locations.title",
    descriptionKey: "emptyState.locations.description",
  },
  messages: {
    titleKey: "emptyState.messages.title",
    descriptionKey: "emptyState.messages.description",
  },
  agents: {
    titleKey: "emptyState.agents.title",
    descriptionKey: "emptyState.agents.description",
  },
  stats: {
    titleKey: "emptyState.stats.title",
    descriptionKey: "emptyState.stats.description",
  },
  adventure: {
    titleKey: "emptyState.adventure.title",
    descriptionKey: "emptyState.adventure.description",
  },
  search: {
    titleKey: "emptyState.search.title",
    descriptionKey: "emptyState.search.description",
  },
  generic: {
    titleKey: "emptyState.generic.title",
    descriptionKey: "emptyState.generic.description",
  },
};

// Fallback content when translation keys are missing
const fallbackContent: Record<
  EmptyStateVariant,
  { title: string; description: string }
> = {
  inventory: {
    title: "Your inventory is empty",
    description: "Items you collect during your adventure will appear here",
  },
  locations: {
    title: "No locations discovered",
    description: "Explore the world to discover new places to visit",
  },
  messages: {
    title: "No messages yet",
    description: "Start your adventure by describing what you want to do",
  },
  agents: {
    title: "No characters nearby",
    description: "Characters will appear as you explore different locations",
  },
  stats: {
    title: "No stats defined",
    description: "Your character stats will appear after world setup",
  },
  adventure: {
    title: "Your adventure begins",
    description: "Describe your ideal world to get started",
  },
  search: {
    title: "No results found",
    description: "Try adjusting your search or explore other options",
  },
  generic: {
    title: "Nothing here yet",
    description: "Content will appear as you progress",
  },
};

export const EmptyState = memo(function EmptyState({
  variant = "generic",
  title,
  description,
  action,
  icon,
  className = "",
  size = "md",
}: EmptyStateProps) {
  const { t } = useTranslation();
  const sizes = sizeClasses[size];
  const defaults = defaultContent[variant];
  const fallback = fallbackContent[variant];

  // Use provided values, or try translation, or fallback
  const displayTitle = title || t(defaults.titleKey, fallback.title);
  const displayDescription =
    description || t(defaults.descriptionKey, fallback.description);
  const displayIcon = icon || (
    <div
      className={`text-slate-300 ${size === "sm" ? "[&>svg]:w-10 [&>svg]:h-10" : size === "lg" ? "[&>svg]:w-16 [&>svg]:h-16" : ""}`}
    >
      {icons[variant]}
    </div>
  );

  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${sizes.container} ${className}`}
      role="status"
      aria-label={displayTitle}
    >
      {/* Icon */}
      <div className="mb-4 opacity-60">{displayIcon}</div>

      {/* Title */}
      <h3 className={`font-medium text-slate-600 mb-1 ${sizes.title}`}>
        {displayTitle}
      </h3>

      {/* Description */}
      <p className={`text-slate-400 max-w-xs ${sizes.description}`}>
        {displayDescription}
      </p>

      {/* Action button */}
      {action && (
        <button
          onClick={action.onClick}
          className={`mt-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors ${sizes.button}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
});

// Preset components for common use cases
export const EmptyInventory = memo(function EmptyInventory() {
  return <EmptyState variant="inventory" size="sm" />;
});

export const EmptyLocations = memo(function EmptyLocations() {
  return <EmptyState variant="locations" size="sm" />;
});

export const EmptyAgents = memo(function EmptyAgents() {
  return <EmptyState variant="agents" size="sm" />;
});

export const EmptyStats = memo(function EmptyStats() {
  return <EmptyState variant="stats" size="sm" />;
});

export const EmptyMessages = memo(function EmptyMessages({
  onGetStarted,
}: {
  onGetStarted?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <EmptyState
      variant="adventure"
      size="lg"
      action={
        onGetStarted
          ? {
              label: t("emptyState.getStarted", "Get Started"),
              onClick: onGetStarted,
            }
          : undefined
      }
    />
  );
});
