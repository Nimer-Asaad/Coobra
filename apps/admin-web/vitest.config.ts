import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
    setupFiles: ['./src/test/setup.ts'],
  },
});
