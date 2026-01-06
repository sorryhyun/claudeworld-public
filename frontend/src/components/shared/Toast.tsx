import {
  createContext,
  useContext,
  useCallback,
  useState,
  useEffect,
  memo,
  type ReactNode,
} from "react";
import { zIndex } from "../../styles/tokens";

// Toast types
export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (toast: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Toast icons for each type
const icons: Record<ToastType, ReactNode> = {
  success: (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  ),
  error: (
    <svg
      className="w-5 h-5"
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
  ),
  warning: (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  ),
  info: (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
};

// Color classes for each type
const typeClasses: Record<
  ToastType,
  { bg: string; icon: string; border: string }
> = {
  success: {
    bg: "bg-green-50",
    icon: "text-green-500",
    border: "border-green-200",
  },
  error: {
    bg: "bg-red-50",
    icon: "text-red-500",
    border: "border-red-200",
  },
  warning: {
    bg: "bg-amber-50",
    icon: "text-amber-500",
    border: "border-amber-200",
  },
  info: {
    bg: "bg-blue-50",
    icon: "text-blue-500",
    border: "border-blue-200",
  },
};

// Default durations by type
const defaultDurations: Record<ToastType, number> = {
  success: 3000,
  error: 5000,
  warning: 4000,
  info: 3000,
};

// Individual toast component
const ToastItem = memo(function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const [isExiting, setIsExiting] = useState(false);
  const classes = typeClasses[toast.type];

  // Auto-dismiss after duration
  useEffect(() => {
    const duration = toast.duration ?? defaultDurations[toast.type];
    if (duration <= 0) return;

    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onDismiss, 200); // Wait for exit animation
    }, duration);

    return () => clearTimeout(timer);
  }, [toast.duration, toast.type, onDismiss]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(onDismiss, 200);
  }, [onDismiss]);

  return (
    <div
      role="alert"
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      className={`
        flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg max-w-sm
        ${classes.bg} ${classes.border}
        transition-all duration-200 ease-out
        ${
          isExiting
            ? "opacity-0 translate-x-4 scale-95"
            : "opacity-100 translate-x-0 scale-100 animate-in slide-in-from-right-4"
        }
      `}
    >
      {/* Icon */}
      <div className={`flex-shrink-0 ${classes.icon}`}>{icons[toast.type]}</div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700">{toast.message}</p>

        {/* Action button */}
        {toast.action && (
          <button
            onClick={() => {
              toast.action?.onClick();
              handleDismiss();
            }}
            className="mt-1 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 p-1 text-slate-400 hover:text-slate-600 rounded transition-colors"
        aria-label="Dismiss"
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
    </div>
  );
});

// Toast container component
const ToastContainer = memo(function ToastContainer({
  toasts,
  dismissToast,
}: {
  toasts: Toast[];
  dismissToast: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 flex flex-col gap-2 pointer-events-none"
      style={{ zIndex: zIndex.toast }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onDismiss={() => dismissToast(toast.id)} />
        </div>
      ))}
    </div>
  );
});

// Toast provider component
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  return (
    <ToastContext.Provider
      value={{ toasts, showToast, dismissToast, clearToasts }}
    >
      {children}
      <ToastContainer toasts={toasts} dismissToast={dismissToast} />
    </ToastContext.Provider>
  );
}

// Hook to use toast functionality
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

// Convenience functions for showing specific toast types
export function useToastHelpers() {
  const { showToast } = useToast();

  return {
    success: (
      message: string,
      options?: Partial<Omit<Toast, "id" | "type" | "message">>,
    ) => showToast({ type: "success", message, ...options }),

    error: (
      message: string,
      options?: Partial<Omit<Toast, "id" | "type" | "message">>,
    ) => showToast({ type: "error", message, ...options }),

    warning: (
      message: string,
      options?: Partial<Omit<Toast, "id" | "type" | "message">>,
    ) => showToast({ type: "warning", message, ...options }),

    info: (
      message: string,
      options?: Partial<Omit<Toast, "id" | "type" | "message">>,
    ) => showToast({ type: "info", message, ...options }),
  };
}
