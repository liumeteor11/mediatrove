import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      clearScreen: false,
      server: {
        port: 1420,
        strictPort: true,
        host: host || '127.0.0.1',
        hmr: host
          ? {
              protocol: "ws",
              host,
              port: 1421,
            }
          : undefined,
        watch: {
          ignored: ["**/src-tauri/**"],
        },
        proxy: {
            '/api/moonshot': {
                target: 'https://api.moonshot.cn',
                changeOrigin: true,
                secure: false,
                rewrite: (path) => path.replace(/^\/api\/moonshot/, ''),
            }
        }
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      },
    };
});
