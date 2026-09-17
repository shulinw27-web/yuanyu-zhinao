import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], server: { host: '127.0.0.1', strictPort: true, proxy: { '/api/portal': 'http://127.0.0.1:15196' } } });
