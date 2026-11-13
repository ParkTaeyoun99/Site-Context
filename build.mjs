// 빌드: npm install && node build.mjs  →  index.html (단일 파일)
import { build } from 'esbuild';
import fs from 'fs';
const r = await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', write: false });
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const tpl = fs.readFileSync('src/template.html', 'utf8');
fs.writeFileSync('index.html', tpl.replace('/*APP*/', () => js));
// 스튜디오(아티팩트)용: 같은 코드, 데이터 수집 대신 프로젝트 파일 불러오기 + Claude 규칙 해석
fs.mkdirSync('studio', { recursive: true });
fs.writeFileSync('studio/index.html', tpl.replace('<title>Site Context — 대지 맥락 3D</title>', '<title>Site Context Studio</title>').replace('/*APP*/', () => 'window.__STUDIO=true;\n' + js));
console.log('index.html + studio/index.html built');
