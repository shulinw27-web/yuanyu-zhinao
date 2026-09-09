import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  server: { host: '127.0.0.1', strictPort: true, proxy: { '/api': process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3001' } }
});
