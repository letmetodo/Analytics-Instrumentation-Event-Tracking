import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  test: {
    root: __dirname,
    include: [resolve(__dirname, 'test/**/*.test.ts')],
    environment: 'node',
  },
};
