// Rebuilds place-scene.bundle.js, the single browser script a Spline scene loads.
//   node scripts/build-bundle.mjs        (needs network for `npx esbuild` the first time)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
execFileSync('npx', ['--yes', 'esbuild@0.25.12', path.join(dir, 'builder/index.js'), '--bundle', '--format=iife', '--global-name=SplinePlace',
  '--minify', '--platform=browser', '--external:node:zlib', '--legal-comments=none', `--outfile=${path.join(dir, 'place-scene.bundle.js')}`], { stdio: 'inherit' });

