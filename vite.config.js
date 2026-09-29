import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'three-mf-license-notices',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'THREE_MF_NOTICES.txt',
          source: readFileSync(
            new URL('./src/vendor/three-mf/THIRD_PARTY_NOTICES.txt', import.meta.url),
            'utf8',
          ),
        });
      },
    },
  ],
  build: { chunkSizeWarningLimit: 800 },
  worker: { format: 'es' },
});
