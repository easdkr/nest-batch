import swc from 'unplugin-swc';
import { readFileSync } from 'fs';

const code = readFileSync('./src/entities/job-meta.entities.ts', 'utf8');
const result = swc.swc?.transformSync?.(code, {
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    keepClassNames: true,
  },
  module: { type: 'es6' },
});
console.log(result?.code || 'no swc transform');
