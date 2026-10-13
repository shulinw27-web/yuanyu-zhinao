import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  clearScreen: false,
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Cache library code independently from frequently changing UI code.
          if (id.replace(/\\/g, '/').includes('/node_modules/')) return 'vendor';
        }
      }
    }
  },
  server: { port: 5174, strictPort: true, proxy: { '/api': process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3001' } },
  preview: { port: 4174, strictPort: true }
});
