import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'API_PORT');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${env.API_PORT || '3000'}`,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
