// Lets Node run the calculator's TypeScript source directly (used by the optimizer server).
// Transpiles with ts-node, resolves the "@/..." path alias, and stubs the asset imports (images, styles) that only the
// web build uses.
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

require('ts-node').register({
  transpileOnly: true,
  project: path.join(root, 'tsconfig.json'),
  compilerOptions: { module: 'commonjs', moduleResolution: 'node', jsx: 'react' },
});
require('tsconfig-paths').register({ baseUrl: root, paths: { '@/*': ['src/*'] } });

for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.css']) {
  // eslint-disable-next-line no-param-reassign
  require.extensions[ext] = (m) => { m.exports = { src: '', height: 0, width: 0 }; };
}
