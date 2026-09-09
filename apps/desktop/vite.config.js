import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: '0.0.0.0',
    proxy: { '/api': process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3001' }
  }
});
