import { useState, memo, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface ThinkingPreviewProps {
  thinking: string;
  isExpanded?: boolean;
  onToggle?: () => void;
  maxPreviewLength?: number;
  showPreviewByDefault?: boolean;
}

export const ThinkingPreview = memo(function ThinkingPreview({
  thinking,
  isExpanded: controlledExpanded,
  onToggle,
  maxPreviewLength = 100,
  showPreviewByDefault = true,
}: ThinkingPreviewProps) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Support both controlled and uncontrolled modes
  const isExpanded = controlledExpanded ?? internalExpanded;
  const handleToggle = onToggle ?? (() => setInternalExpanded((prev) => !prev));

  // Generate preview text
  const previewText =
    thinking.length > maxPreviewLength
      ? thinking.slice(0, maxPreviewLength).trim() + "..."
      : thinking;

  // Scroll to make expanded content visible
  useEffect(() => {
    if (isExpanded && contentRef.current) {
      contentRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [isExpanded]);

  return (
    <div className="mb-2">
      {/* Toggle button */}
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-800 transition-colors group"
        aria-expanded={isExpanded}
        aria-label={
          isExpanded
            ? t("thinking.hideThinking", "Hide thinking")
            : t("thinking.showThinking", "Show thinking")
        }
      >
        {/* Chevron icon */}
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>

        {/* Brain icon */}
        <svg
          className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>

        <span className="font-medium">{t("thinking.label", "Thinking")}</span>

        {/* Preview text (shown when collapsed and showPreviewByDefault is true) */}
        {!isExpanded && showPreviewByDefault && (
          <span className="text-slate-400 ml-1 truncate max-w-[200px] sm:max-w-[300px] font-normal">
            {previewText}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div
          ref={contentRef}
          className="mt-2 p-3 bg-slate-100 rounded-lg text-xs text-slate-700 whitespace-pre-wrap border border-slate-200 animate-in slide-in-from-top-1 duration-200"
        >
          <div className="italic font-mono leading-relaxed max-h-64 overflow-y-auto">
            {thinking}
          </div>

          {/* Character count */}
          <div className="mt-2 pt-2 border-t border-slate-200 flex items-center justify-between">
            <span className="text-[10px] text-slate-400">
              {thinking.length.toLocaleString()}{" "}
              {t("thinking.characters", "characters")}
            </span>
            <button
              onClick={handleToggle}
              className="text-[10px] text-slate-500 hover:text-slate-700 transition-colors"
            >
              {t("thinking.collapse", "Collapse")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// Streaming thinking indicator - shows animated preview during generation
export const ThinkingStream = memo(function ThinkingStream({
  thinking,
  agentName,
}: {
  thinking: string;
  agentName?: string;
}) {
  const { t } = useTranslation();
  const previewLength = 80;

  // Get last few characters for streaming effect
  const displayText =
    thinking.length > previewLength
      ? "..." + thinking.slice(-previewLength)
      : thinking;

  return (
    <div className="px-3 py-2 bg-slate-50/80 rounded-lg border border-slate-200">
      <div className="flex items-center gap-2 mb-1.5">
        {/* Animated brain icon */}
        <div className="relative">
          <svg
            className="w-4 h-4 text-indigo-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
        </div>

        <span className="text-xs font-medium text-indigo-600">
          {agentName || t("thinking.narrator", "Narrator")}{" "}
          {t("thinking.isThinking", "is thinking...")}
        </span>
      </div>

      {/* Streaming text preview */}
      <div className="text-[11px] text-slate-600 italic font-mono leading-relaxed truncate">
        {displayText}
        <span className="inline-block w-1.5 h-3 bg-slate-500 ml-0.5 animate-pulse" />
      </div>
    </div>
  );
});
