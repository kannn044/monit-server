import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Serve under a sub-path by building with VITE_BASE, e.g. behind nginx:
//   VITE_BASE=/monit/ npm run build
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  build: { outDir: 'dist' },
});
