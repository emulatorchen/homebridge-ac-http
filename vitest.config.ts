import { defineConfig } from 'vitest/config';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

let hapPath: string;
try {
  hapPath = req.resolve('@homebridge/hap-nodejs');
} catch {
  hapPath = req.resolve('hap-nodejs');
}

export default defineConfig({
  resolve: {
    alias: {
      '@homebridge/hap-nodejs': hapPath,
    },
  },
});
