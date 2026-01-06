import { useState, useEffect } from "react";
import {
  getWorldHistory,
  compressWorldHistory,
} from "../../services/gameService";

interface HistoryPanelProps {
  worldId: number | null;
  worldName?: string;
}

export function HistoryPanel({ worldId, worldName }: HistoryPanelProps) {
  const [history, setHistory] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [compressMessage, setCompressMessage] = useState<string | null>(null);

  const handleCompress = async () => {
    if (!worldId || compressing) return;

    setCompressing(true);
    setCompressMessage(null);

    try {
      const result = await compressWorldHistory(worldId);
      if (result.success) {
        setCompressMessage(
          `Compressed ${result.turns_compressed} turns into ${result.sections_created} sections`,
        );
        // Refresh history after compression
        const content = await getWorldHistory(worldId);
        setHistory(content);
      } else {
        setCompressMessage(result.message);
      }
    } catch (err) {
      console.error("Failed to compress history:", err);
      setCompressMessage(
        err instanceof Error ? err.message : "Failed to compress history",
      );
    } finally {
      setCompressing(false);
      // Clear message after 3 seconds
      setTimeout(() => setCompressMessage(null), 3000);
    }
  };

  useEffect(() => {
    if (!worldId) {
      setHistory("");
      return;
    }

    const fetchHistory = async () => {
      setLoading(true);
      setError(null);
      try {
        const content = await getWorldHistory(worldId);
        setHistory(content);
      } catch (err) {
        setError("Failed to load history");
        console.error("Failed to load history:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();

    // Poll for updates every 5 seconds
    const interval = setInterval(fetchHistory, 5000);
    return () => clearInterval(interval);
  }, [worldId]);

  if (!worldId) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-slate-400">
          <svg
            className="w-12 h-12 mx-auto mb-3 opacity-50"
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
          <p className="text-sm font-medium">No World Selected</p>
          <p className="text-xs mt-1">Select a world to view its history</p>
        </div>
      </div>
    );
  }

  if (loading && !history) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin h-6 w-6 border-3 border-slate-300 border-t-slate-600 rounded-full mx-auto mb-2" />
          <p className="text-sm text-slate-500">Loading history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-red-500">
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!history.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-slate-400">
          <svg
            className="w-12 h-12 mx-auto mb-3 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="text-sm font-medium">No History Yet</p>
          <p className="text-xs mt-1">
            History will appear as you travel through the world
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-slate-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
              />
            </svg>
            <span className="text-sm font-medium text-slate-700 truncate">
              {worldName || "World"} History
            </span>
          </div>
          <button
            onClick={handleCompress}
            disabled={compressing}
            className="px-2 py-1 text-xs rounded hover:bg-slate-100 text-slate-500 hover:text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            title="Compress history into consolidated sections"
          >
            {compressing ? (
              <div className="animate-spin h-3 w-3 border-2 border-slate-300 border-t-slate-600 rounded-full" />
            ) : (
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
                  d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                />
              </svg>
            )}
            <span>Compress</span>
          </button>
        </div>
        {compressMessage && (
          <div className="mt-2 text-xs text-slate-500 bg-slate-50 rounded px-2 py-1">
            {compressMessage}
          </div>
        )}
      </div>

      {/* History Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="prose prose-sm prose-slate max-w-none">
          {history.split("\n").map((line, index) => {
            // Handle headers
            if (line.startsWith("# ")) {
              return (
                <h1
                  key={index}
                  className="text-lg font-bold text-slate-800 mt-4 mb-2 first:mt-0"
                >
                  {line.slice(2)}
                </h1>
              );
            }
            if (line.startsWith("## ")) {
              return (
                <h2
                  key={index}
                  className="text-base font-semibold text-slate-700 mt-3 mb-1.5"
                >
                  {line.slice(3)}
                </h2>
              );
            }
            if (line.startsWith("### ")) {
              return (
                <h3
                  key={index}
                  className="text-sm font-medium text-slate-600 mt-2 mb-1"
                >
                  {line.slice(4)}
                </h3>
              );
            }
            // Handle empty lines
            if (!line.trim()) {
              return <div key={index} className="h-2" />;
            }
            // Handle list items
            if (line.startsWith("- ")) {
              return (
                <div
                  key={index}
                  className="flex gap-2 text-sm text-slate-600 ml-2"
                >
                  <span className="text-slate-400">•</span>
                  <span>{line.slice(2)}</span>
                </div>
              );
            }
            // Regular text
            return (
              <p key={index} className="text-sm text-slate-600 leading-relaxed">
                {line}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
