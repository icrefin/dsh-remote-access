import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'test-ui/**/*.spec.tsx'],
  },
  // `.tsx` outside the host tsconfig still needs the automatic JSX runtime.
  esbuild: { jsx: 'automatic' },
})