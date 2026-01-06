import { memo, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { GameMessage } from "../../contexts/GameContext";

interface HistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: GameMessage[];
  renderMessage: (message: GameMessage, index: number) => React.ReactNode;
  totalCount: number;
}

export const HistoryDrawer = memo(function HistoryDrawer({
  isOpen,
  onClose,
  messages,
  renderMessage,
  totalCount,
}: HistoryDrawerProps) {
  const { t } = useTranslation();
  const drawerRef = useFocusTrap<HTMLDivElement>(isOpen);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  const itemContent = useCallback(
    (index: number) => renderMessage(messages[index], index),
    [messages, renderMessage],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer - slides in from right on mobile, modal on desktop */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-drawer-title"
        className={`
          absolute bg-white shadow-2xl flex flex-col overflow-hidden
          transition-transform duration-300 ease-out

          /* Mobile: Full-height drawer from right */
          inset-y-0 right-0 w-full max-w-md
          translate-x-0 animate-in slide-in-from-right duration-300

          /* Desktop: Centered modal */
          lg:inset-auto lg:top-1/2 lg:left-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2
          lg:w-full lg:max-w-3xl lg:max-h-[80vh] lg:rounded-xl
          lg:animate-in lg:fade-in lg:zoom-in-95 lg:slide-in-from-bottom-0 lg:duration-200
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 lg:px-6 py-4 border-b border-slate-200 bg-white">
          <div>
            <h2
              id="history-drawer-title"
              className="text-lg font-semibold text-slate-800"
            >
              {t("gameRoom.conversationHistory", "Conversation History")}
            </h2>
            <p className="text-sm text-slate-500">
              {t("gameRoom.messagesTotal", "{{count}} messages total", {
                count: totalCount,
              })}
            </p>
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            aria-label={t("common.close", "Close")}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Virtualized message list */}
        <div className="flex-1 overflow-hidden">
          <Virtuoso
            ref={virtuosoRef}
            data={messages}
            totalCount={messages.length}
            itemContent={itemContent}
            overscan={100}
            className="h-full"
          />
        </div>

        {/* Footer */}
        <div className="px-4 lg:px-6 py-3 border-t border-slate-200 bg-slate-50">
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors min-h-[44px]"
          >
            {t("gameRoom.close", "Close")}
          </button>
        </div>

        {/* Swipe indicator for mobile */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 bg-slate-300 rounded-full lg:hidden" />
      </div>
    </div>
  );
});

// Compact history button component
export const HistoryButton = memo(function HistoryButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  if (count === 0) return null;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors min-h-[44px]"
      aria-label={t("gameRoom.history", "History")}
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
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span>{t("gameRoom.history", "History")}</span>
      <span
        className="px-1.5 py-0.5 bg-slate-200 text-slate-600 text-xs font-medium rounded-full"
        aria-label={`${count} messages`}
      >
        {count}
      </span>
    </button>
  );
});
