import { defineConfig } from 'vitest/config';

/**
 * Component tests render the shared screens through React Native Web in jsdom: the same code
 * the Expo web apps ship. Native-only modules are mocked in vitest.setup.ts.
 */
export default defineConfig({
  resolve: { alias: { 'react-native': 'react-native-web' } },
  define: { __DEV__: 'true' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
