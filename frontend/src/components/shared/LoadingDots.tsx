import { cn } from "@/lib/utils";

interface LoadingDotsProps {
  size?: "sm" | "md" | "lg";
  color?: "primary" | "secondary" | "white" | "current";
  className?: string;
}

/**
 * Unified loading indicator with bouncing dots animation.
 * Replaces duplicated bounce dot implementations across the codebase.
 */
export function LoadingDots({
  size = "md",
  color = "primary",
  className,
}: LoadingDotsProps) {
  const sizeClasses = {
    sm: "w-1.5 h-1.5",
    md: "w-2 h-2",
    lg: "w-3 h-3",
  };

  const colorClasses = {
    primary: "bg-cyan-400",
    secondary: "bg-slate-400",
    white: "bg-white",
    current: "bg-current",
  };

  const gapClasses = {
    sm: "gap-1",
    md: "gap-1.5",
    lg: "gap-2",
  };

  return (
    <div
      className={cn("flex items-center", gapClasses[size], className)}
      role="status"
      aria-label="Loading"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "rounded-full animate-bounce",
            sizeClasses[size],
            colorClasses[color],
          )}
          style={{
            animationDelay: `${i * 150}ms`,
            animationDuration: "600ms",
          }}
        />
      ))}
      <span className="sr-only">Loading...</span>
    </div>
  );
}

/**
 * Inline loading dots that inherit text color and baseline alignment.
 * Useful for loading indicators within text content.
 */
export function LoadingDotsInline({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-0.5", className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 bg-current rounded-full animate-bounce"
          style={{
            animationDelay: `${i * 150}ms`,
            animationDuration: "600ms",
          }}
        />
      ))}
    </span>
  );
}
