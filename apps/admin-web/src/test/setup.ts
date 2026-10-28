import { afterEach } from 'vitest';

// Unmount React trees between component tests (Vitest globals are off, so no auto-cleanup).
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
