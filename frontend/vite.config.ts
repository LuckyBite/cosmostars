import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The built interface is served by the service itself, so requests go to the
// same origin with no base URL to configure. In development the service runs
// on its own port and this proxy stands in for that, which keeps CORS out of
// the picture in both places.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1400 },
})
