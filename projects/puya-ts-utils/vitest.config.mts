import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'
import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {},
  test: {
    setupFiles: ['vitest.setup.ts'],
    // LocalNet round times dominate the e2e suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [
    typescript({
      // The repo tsconfig targets CommonJS for ts-node; the test bundle stays ESM
      // so that the testing package's `exports` map resolves.
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: false,
      declaration: false,
      declarationMap: false,
      // `*.algo.spec.ts` files are rewritten to run against the AVM emulator;
      // plain `*.spec.ts` files (the e2e suite) are left alone.
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
