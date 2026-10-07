import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'tools/**/*.test.js'],
    // tools/enroll es un proyecto Node aparte: tiene su propio package.json y su
    // propio runner (node --test). Sin esta exclusión, vitest lo colecta, no lo
    // entiende y falla con "No test suite found".
    exclude: [...configDefaults.exclude, '**/tools/enroll/**'],
  },
});
