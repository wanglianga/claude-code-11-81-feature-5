import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 离线工作台：纯前端构建，Worker 使用 ES 模块格式
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
