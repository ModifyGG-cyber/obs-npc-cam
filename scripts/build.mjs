// Bundles src/main.ts into dist/obs-npc-cam/ with module.json, ready to copy into Foundry's modules folder.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'dist/obs-npc-cam';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/module.js`, sourcemap: true });
const manifest = JSON.parse(readFileSync('module.json', 'utf8'));
manifest.version = pkg.version;
writeFileSync(`${out}/module.json`, JSON.stringify(manifest, null, 2) + '\n');
cpSync('LICENSE', `${out}/LICENSE`);
cpSync('README.md', `${out}/README.md`);
console.log(`built ${out} v${pkg.version}`);
