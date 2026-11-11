import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const engineUrl = `http://127.0.0.1:${process.env.SYMPOSIUM_PORT ?? 4400}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': engineUrl,
      '/ws': { target: engineUrl, ws: true },
    },
  },
});
