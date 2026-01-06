import { useState, useId, KeyboardEvent } from "react";

/**
 * Custom hook for accessible collapsible/expandable sections.
 * Provides keyboard navigation (Enter/Space to toggle, Escape to close)
 * and proper ARIA attributes for screen readers.
 *
 * @param defaultExpanded - Initial expanded state (default: false)
 * @returns Object containing state and props for trigger and content elements
 */
export function useCollapsible(defaultExpanded = false) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const triggerId = useId();
  const contentId = useId();

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        setExpanded(!expanded);
        break;
      case "Escape":
        if (expanded) {
          e.preventDefault();
          setExpanded(false);
        }
        break;
    }
  };

  return {
    expanded,
    setExpanded,
    toggle: () => setExpanded(!expanded),
    triggerProps: {
      id: triggerId,
      "aria-expanded": expanded,
      "aria-controls": contentId,
      onKeyDown: handleKeyDown,
      tabIndex: 0,
      role: "button" as const,
    },
    contentProps: {
      id: contentId,
      "aria-labelledby": triggerId,
      role: "region" as const,
      hidden: !expanded,
    },
  };
}
