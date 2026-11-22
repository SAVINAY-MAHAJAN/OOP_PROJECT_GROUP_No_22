import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['client/main.jsx'],
  bundle: true,
  outfile: 'dist/nexora.js',
  minify: true,
  jsx: 'automatic',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('client/index.html', 'dist/index.html');
