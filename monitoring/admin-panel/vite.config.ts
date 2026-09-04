import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api al admin-server de monitoring (puerto propio, separado del
// backend de negocio) durante desarrollo. En producción se sirve el build
// (dist/) directo desde admin-server.js, así que este proxy no aplica ahí.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:4001',
        changeOrigin: true,
      },
    },
  },
});
