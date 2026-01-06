import { useState, useEffect, memo } from "react";
import { useTranslation } from "react-i18next";

interface TurnIndicatorProps {
  phase?: "thinking" | "generating" | "finalizing";
  startTime?: number;
}

// Helper hints shown after waiting for a while
const hints = {
  en: [
    "Complex actions may take longer to process...",
    "The narrator is weaving your story...",
    "Great adventures require patience...",
    "Consulting the world state...",
  ],
  ko: [
    "복잡한 행동은 처리에 시간이 더 걸릴 수 있습니다...",
    "나레이터가 스토리를 엮고 있습니다...",
    "위대한 모험에는 인내가 필요합니다...",
    "세계 상태를 확인 중입니다...",
  ],
};

// Phase configurations with progress percentages
const phaseConfig = {
  thinking: { progress: 25, labelEn: "Thinking", labelKo: "생각 중" },
  generating: { progress: 60, labelEn: "Generating", labelKo: "생성 중" },
  finalizing: { progress: 90, labelEn: "Finalizing", labelKo: "마무리 중" },
};

// Format elapsed time as MM:SS
const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }
  return `${secs}s`;
};

// Isolated timer component - re-renders every second without affecting parent
const ElapsedTimer = memo(function ElapsedTimer({
  startTime,
}: {
  startTime: number;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, [startTime]);

  return (
    <div className="flex-shrink-0 text-xs text-slate-400 font-mono tabular-nums">
      {formatTime(elapsedSeconds)}
    </div>
  );
});

// Isolated hint display component - updates every 5 seconds after initial delay
const HintDisplay = memo(function HintDisplay({
  startTime,
  defaultSubtitle,
  hints: hintList,
}: {
  startTime: number;
  defaultSubtitle: string;
  hints: string[];
}) {
  const [hintIndex, setHintIndex] = useState(0);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      // Show hints after 5 seconds
      if (elapsed >= 5 && !showHint) {
        setShowHint(true);
      }

      // Rotate hints every 5 seconds after showing
      if (elapsed >= 5 && elapsed % 5 === 0) {
        setHintIndex((prev) => (prev + 1) % hintList.length);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [startTime, showHint, hintList.length]);

  return (
    <p className="text-xs text-slate-500 mt-0.5 truncate transition-opacity duration-300">
      {showHint ? hintList[hintIndex] : defaultSubtitle}
    </p>
  );
});

export const TurnIndicator = memo(function TurnIndicator({
  phase = "thinking",
  startTime,
}: TurnIndicatorProps) {
  const { t, i18n } = useTranslation();
  const effectiveStartTime = startTime || Date.now();

  const lang = i18n.language === "ko" ? "ko" : "en";
  const currentHints = hints[lang];

  const config = phaseConfig[phase];
  const phaseLabel = lang === "ko" ? config.labelKo : config.labelEn;

  return (
    <div className="px-4 py-3 bg-slate-50 border-t border-slate-200">
      <div className="max-w-3xl mx-auto">
        {/* Main indicator row */}
        <div className="flex items-center gap-3">
          {/* Animated spinner */}
          <div className="relative flex-shrink-0">
            <div className="animate-spin h-5 w-5 border-2 border-slate-300 border-t-indigo-600 rounded-full" />
            <div
              className="absolute inset-0 animate-ping opacity-20 h-5 w-5 border-2 border-indigo-400 rounded-full"
              style={{ animationDuration: "1.5s" }}
            />
          </div>

          {/* Status text */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-slate-700">
                {t("turnIndicator.processing", "Processing your action...")}
              </span>
              <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs font-medium rounded-full">
                {phaseLabel}
              </span>
            </div>

            {/* Hint text - shown after delay (isolated component) */}
            <HintDisplay
              startTime={effectiveStartTime}
              defaultSubtitle={t(
                "turnIndicator.subtitle",
                "The narrator is crafting a response",
              )}
              hints={currentHints}
            />
          </div>

          {/* Elapsed time (isolated component) */}
          <ElapsedTimer startTime={effectiveStartTime} />
        </div>

        {/* Progress bar */}
        <div className="mt-2 h-1 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-cyan-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${config.progress}%` }}
          />
        </div>

        {/* Phase indicators */}
        <div className="mt-2 flex justify-between text-[10px] text-slate-400">
          <span
            className={
              phase === "thinking" ? "text-indigo-600 font-medium" : ""
            }
          >
            {t("turnIndicator.phaseThinking", "Thinking")}
          </span>
          <span
            className={
              phase === "generating" ? "text-indigo-600 font-medium" : ""
            }
          >
            {t("turnIndicator.phaseGenerating", "Generating")}
          </span>
          <span
            className={
              phase === "finalizing" ? "text-indigo-600 font-medium" : ""
            }
          >
            {t("turnIndicator.phaseFinalizing", "Finalizing")}
          </span>
        </div>
      </div>
    </div>
  );
});

// Compact version for inline use
export const TurnIndicatorCompact = memo(function TurnIndicatorCompact() {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-full">
      <div className="animate-spin h-3 w-3 border-2 border-slate-300 border-t-indigo-600 rounded-full" />
      <span className="text-xs text-slate-600 font-medium">Processing...</span>
    </div>
  );
});
