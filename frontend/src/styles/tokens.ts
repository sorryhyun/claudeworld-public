/**
 * Design Token System for ClaudeWorld
 *
 * Centralized design tokens for consistent styling across the application.
 * These tokens are consumed by Tailwind config and can be used directly in JS/TS.
 */

// Semantic color palette
export const colors = {
  // Primary actions and links
  primary: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6", // Base
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
  },
  // Secondary/neutral tones
  secondary: {
    50: "#f8fafc",
    100: "#f1f5f9",
    200: "#e2e8f0",
    300: "#cbd5e1",
    400: "#94a3b8",
    500: "#64748b", // Base
    600: "#475569",
    700: "#334155",
    800: "#1e293b",
    900: "#0f172a",
  },
  // Accent for highlights
  accent: {
    light: "#a5f3fc", // cyan-200
    base: "#06b6d4", // cyan-500
    dark: "#0891b2", // cyan-600
  },
  // Semantic status colors
  success: {
    light: "#bbf7d0",
    base: "#22c55e",
    dark: "#16a34a",
  },
  warning: {
    light: "#fef08a",
    base: "#eab308",
    dark: "#ca8a04",
  },
  error: {
    light: "#fecaca",
    base: "#ef4444",
    dark: "#dc2626",
  },
} as const;

// Standardized gradient definitions
export const gradients = {
  primary: "from-blue-500 to-cyan-500", // Main CTA, player actions
  secondary: "from-slate-600 to-slate-700", // Secondary buttons
  accent: "from-amber-500 to-orange-500", // Highlights, achievements
  magical: "from-indigo-500 to-purple-600", // NPC/magical effects
} as const;

// Animation timing tokens
export const timing = {
  instant: "50ms",
  fast: "150ms",
  normal: "200ms",
  slow: "300ms",
  slower: "500ms",
} as const;

// Easing functions
export const easing = {
  default: "cubic-bezier(0.4, 0, 0.2, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  out: "cubic-bezier(0, 0, 0.2, 1)",
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  bounce: "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
} as const;

// Shadow scale
export const shadows = {
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
  glow: "0 0 20px rgb(59 130 246 / 0.5)", // For focus/active states
  "glow-primary": "0 0 20px rgb(59 130 246 / 0.5)",
  "glow-accent": "0 0 20px rgb(6 182 212 / 0.5)",
} as const;

// Z-index scale (prevents magic numbers)
export const zIndex = {
  base: 0,
  dropdown: 10,
  sticky: 20,
  fixed: 30,
  overlay: 40,
  modal: 50,
  popover: 60,
  toast: 70,
  tooltip: 80,
  max: 9999,
} as const;

// Spacing scale (matches Tailwind but explicit for JS usage)
export const spacing = {
  px: "1px",
  0: "0",
  0.5: "0.125rem", // 2px
  1: "0.25rem", // 4px
  1.5: "0.375rem", // 6px
  2: "0.5rem", // 8px
  2.5: "0.625rem", // 10px
  3: "0.75rem", // 12px
  4: "1rem", // 16px
  5: "1.25rem", // 20px
  6: "1.5rem", // 24px
  8: "2rem", // 32px
  10: "2.5rem", // 40px
  12: "3rem", // 48px
  16: "4rem", // 64px
} as const;

// Border radius
export const radius = {
  none: "0",
  sm: "0.125rem", // 2px
  md: "0.375rem", // 6px
  lg: "0.5rem", // 8px
  xl: "0.75rem", // 12px
  "2xl": "1rem", // 16px
  full: "9999px",
} as const;

// Breakpoints (standardized Tailwind defaults)
export const breakpoints = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

// Type exports for usage in components
export type ColorScale = typeof colors;
export type GradientName = keyof typeof gradients;
export type ZIndexLevel = keyof typeof zIndex;
export type SpacingValue = keyof typeof spacing;
