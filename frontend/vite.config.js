import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    // Proxy /api calls to the FastAPI backend during development
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Split vendor bundles; recharts is inherently ~545 kB so raise the warning limit
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'charts': ['recharts'],
          'xlsx': ['xlsx'],
          'utils': ['axios', 'zustand', 'react-hot-toast', 'react-dropzone', 'canvas-confetti'],
        },
      },
    },
  },
})
