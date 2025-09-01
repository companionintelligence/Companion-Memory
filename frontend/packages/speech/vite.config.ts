import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'CISpeech',
      fileName: (format) => `ci-speech.${format}.js`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['react', 'socket.io-client'],
      output: {
        globals: {
          react: 'React',
          'socket.io-client': 'io',
        },
      },
    },
  },
});