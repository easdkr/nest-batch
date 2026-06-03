import { createServer } from '/Users/june/workspace/personal/nest-batch/node_modules/.pnpm/vite@5.4.21_@types+node@22.19.19/node_modules/vite/dist/node/index.js';
import swc from '/Users/june/workspace/personal/nest-batch/node_modules/.pnpm/unplugin-swc@1.5.7_@swc+core@1.15.40_vite@5.4.21/node_modules/unplugin-swc/dist/index.mjs';

const server = await createServer({
  configFile: false,
  plugins: [swc.vite({
    module: { type: 'es6' },
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      keepClassNames: true,
    },
  })],
  server: { middlewareMode: true, fs: { strict: false } },
  appType: 'custom',
  logLevel: 'silent',
});
const id = '/Users/june/workspace/personal/nest-batch/packages/nest-batch/src/flow/flow-evaluator.ts';
try {
  const result = await server.pluginContainer.resolveId(id);
  console.log('resolved:', JSON.stringify(result));
  if (result) {
    const loaded = await server.pluginContainer.load(result.id);
    console.log('loaded:', loaded ? `OK len=${loaded.code.length}` : 'NULL');
  }
} catch (e) {
  console.error('ERROR:', e.message);
}
await server.close();
