import { colors, shadows, zIndex } from './src/styles/tokens.js';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    screens: {
      // Three-tier responsive system:
      // Mobile: 0-479px (default styles, no prefix)
      // Tablet: 480-1023px (sm: prefix)
      // Desktop: 1024px+ (lg: prefix)
      'sm': '480px',
      'lg': '1024px',
    },
    extend: {
      colors: {
        // Map semantic tokens to Tailwind classes
        brand: colors.primary,
        neutral: colors.secondary,
        'accent-color': colors.accent,
        'success-color': colors.success,
        'warning-color': colors.warning,
        'error-color': colors.error,
      },
      boxShadow: {
        ...shadows,
      },
      zIndex: {
        ...zIndex,
      },
      transitionDuration: {
        'fast': '150ms',
        'normal': '200ms',
        'slow': '300ms',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
