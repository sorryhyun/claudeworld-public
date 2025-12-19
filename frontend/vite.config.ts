import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'
import type { PluginOption } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react()]

  // Add bundle analyzer when building with --mode analyze
  if (mode === 'analyze') {
    plugins.push(
      visualizer({
        open: true,
        filename: 'dist/bundle-stats.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap', // 'sunburst' | 'treemap' | 'network'
      }) as PluginOption
    )
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '0.0.0.0', // Allow access from Windows host in WSL2
      port: 5173,
    },
    build: {
      // Optimize chunk splitting for better caching
      rollupOptions: {
        output: {
          manualChunks: {
            // Split vendor libraries into separate chunks
            'react-vendor': ['react', 'react-dom'],
            'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tooltip'],
            'markdown': ['react-markdown', 'remark-gfm', 'remark-breaks'],
            'i18n': ['i18next', 'react-i18next'],
            'virtuoso': ['react-virtuoso'],
          },
        },
      },
    },
  }
})
