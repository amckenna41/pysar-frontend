import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Use jsdom to simulate browser APIs (localStorage, File, FormData, etc.)
    environment: 'jsdom',

    // Run the setup file before every test file
    setupFiles: ['./src/__tests__/setup.js'],

    // Expose describe/it/expect globally (no need to import in each file)
    globals: true,

    // Coverage configuration (used with --coverage flag)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/__tests__/**', 'src/main.jsx'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
})
