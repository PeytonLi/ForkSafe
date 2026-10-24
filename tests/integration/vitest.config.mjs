import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireConvex = createRequire(new URL('../../convex/package.json', import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      'convex-test': requireConvex.resolve('convex-test'),
      '@convex-dev/workflow/test': requireConvex.resolve('@convex-dev/workflow/test'),
      '@convex-dev/workpool/test': requireConvex.resolve('@convex-dev/workpool/test'),
      '@forksafe/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.{ts,mjs}'],
    testTimeout: 15000,
    env: { INTEGRATION_LIVE: process.env.INTEGRATION_LIVE || '' },
  },
});
