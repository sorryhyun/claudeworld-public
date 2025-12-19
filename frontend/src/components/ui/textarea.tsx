import * as React from "react"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: 'default' | 'ghost' | 'game';
  error?: boolean;
}

/**
 * Unified Textarea component with variant styling.
 *
 * Variants:
 * - default: Standard input with visible border
 * - ghost: Transparent until focused
 * - game: Dark theme optimized for game UI
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant = 'default', error, ...props }, ref) => {
    const variantStyles = {
      default: [
        'bg-transparent border-input',
        'focus-visible:ring-1 focus-visible:ring-ring',
      ],
      ghost: [
        'bg-transparent border-transparent',
        'focus:bg-slate-50 focus:border-slate-300',
      ],
      game: [
        'bg-slate-900/80 border-slate-700/50 text-slate-100',
        'focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20',
        'placeholder:text-slate-500',
      ],
    };

    return (
      <textarea
        className={cn(
          // Base styles
          'flex min-h-[60px] w-full rounded-md border px-3 py-2',
          'text-base shadow-sm placeholder:text-muted-foreground',
          'focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'sm:text-sm',
          'resize-none',
          // Variant styles
          variantStyles[variant],
          // Error state
          error && 'border-red-500 focus:border-red-500 focus:ring-red-500/20',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea"

export { Textarea }
