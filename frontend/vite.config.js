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
        // Return 503 (not a raw network error) when the backend is still starting up,
        // so the frontend's retry interceptor and backendOnline logic handle it cleanly.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if (!res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ detail: 'Backend not ready' }))
            }
          })
        },
      },
    },
  },
  build: {
    // Split vendor bundles; recharts is inherently ~545 kB so raise the warning limit
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React + scheduler must all land in the same chunk so recharts always
          // finds one React instance. The object form only handles direct imports
          // of 'react'/'react-dom' and leaves React scattered across entry chunks.
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'react-vendor'
          }
          // recharts also pulls in d3 and victory-vendor — group them together
          if (
            id.includes('/node_modules/recharts/') ||
            id.includes('/node_modules/d3') ||
            id.includes('/node_modules/victory-vendor/')
          ) {
            return 'charts'
          }
          if (id.includes('/node_modules/xlsx/')) return 'xlsx'
          if (
            id.includes('/node_modules/axios/') ||
            id.includes('/node_modules/zustand/') ||
            id.includes('/node_modules/react-hot-toast/') ||
            id.includes('/node_modules/react-dropzone/') ||
            id.includes('/node_modules/canvas-confetti/')
          ) {
            return 'utils'
          }
        },
      },
    },
  },
})
