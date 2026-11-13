// 빌드: npm install && node build.mjs  →  index.html (단일 파일)
import { build } from 'esbuild';
import fs from 'fs';
const r = await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', write: false });
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
fs.writeFileSync('index.html', fs.readFileSync('src/template.html', 'utf8').replace('/*APP*/', () => js));
console.log('index.html built');
