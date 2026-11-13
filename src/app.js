import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ClipperLib from 'clipper-lib';
import { zipSync, strToU8 } from 'fflate';
const STUDIO = !!window.__STUDIO;

// ---------- 상태 ----------
const S = {
  origin: null,          // {lon, lat}
  siteParcels: [],       // {id, jibun, ring:[[x,y]], ground, props}
  parcels: [],           // 주변 필지
  buildings: [],         // {id, ring, floors, height, ground, props, mesh}
  floorH: 3.3,
  radius: 200,
  mode: 'height',        // 'height' | 'view'
  sectionPts: [],
  demo: false,
};
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function log(msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------- 좌표 ----------
function project(lon, lat) {
  const o = S.origin;
  const kx = Math.cos((o.lat * Math.PI) / 180) * 111320;
  return [(lon - o.lon) * kx, (lat - o.lat) * 110540];
}
function unproject(x, y) {
  const o = S.origin;
  const kx = Math.cos((o.lat * Math.PI) / 180) * 111320;
  return [o.lon + x / kx, o.lat + y / 110540];
}
function polyArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
}
function centroid(r) {
  let x = 0, y = 0;
  r.forEach((p) => { x += p[0]; y += p[1]; });
  return [x / r.length, y / r.length];
}
function pip(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function cleanRing(r) {
  const out = r.slice();
  const a = out[0], b = out[out.length - 1];
  if (out.length > 1 && a[0] === b[0] && a[1] === b[1]) out.pop();
  return out;
}
// GeoJSON geometry → 바깥 링 목록 (lon/lat)
function outerRings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return [];
}

// ---------- V-World (JSONP) ----------
let cbSeq = 0;
function jsonp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const name = '__vw' + Date.now() + '_' + cbSeq++;
    const s = document.createElement('script');
    const t = setTimeout(() => { cleanup(); reject(new Error('응답 시간 초과')); }, timeout);
    function cleanup() { clearTimeout(t); delete window[name]; s.remove(); }
    window[name] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('요청 실패 (키·도메인 확인)')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + name;
    document.head.appendChild(s);
  });
}
function vwKey() { return $('key').value.trim(); }
function vwDomain() { return $('domain').value.trim(); }

async function geocode(addr) {
  const q = new URLSearchParams({
    service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '1', page: '1',
    query: addr, type: 'address', category: 'parcel', format: 'json', errorformat: 'json', key: vwKey(),
  });
  const d = await jsonp('https://api.vworld.kr/req/search?' + q);
  const r = d && d.response;
  if (!r || r.status !== 'OK') throw new Error(`주소 검색 실패: ${addr} (${r ? r.status : '응답 없음'}${r && r.error ? ' ' + r.error.text : ''})`);
  const p = r.result.items[0].point;
  return [parseFloat(p.x), parseFloat(p.y)];
}

async function getFeatures(layer, geomFilter, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({
      service: 'data', request: 'GetFeature', version: '2.0', data: layer, key: vwKey(), domain: vwDomain(),
      geomFilter, crs: 'EPSG:4326', format: 'json', errorFormat: 'json', size: '1000', page: String(page),
      geometry: 'true', attribute: 'true',
    });
    const d = await jsonp('https://api.vworld.kr/req/data?' + q);
    const r = d && d.response;
    if (!r) throw new Error(layer + ': 응답 없음');
    if (r.status === 'NOT_FOUND') break;
    if (r.status !== 'OK') throw new Error(`${layer}: ${r.status} ${r.error ? r.error.text : ''}`);
    all.push(...r.result.featureCollection.features);
    const total = r.page ? parseInt(r.page.total, 10) : 1;
    if (page >= total) break;
  }
  return all;
}

function readFloors(p) {
  const keys = ['gro_flo_co', 'grnd_flr', 'grnd_flr_co', 'ground_floor', 'flr_co', 'floor'];
  for (const k of keys) {
    const v = parseInt(p[k], 10);
    if (!isNaN(v) && v > 0) return v;
  }
  return null;
}
function readHeight(p) {
  const keys = ['height', 'heit', 'bld_hgt', 'bldg_hgt'];
  for (const k of keys) {
    const v = parseFloat(p[k]);
    if (!isNaN(v) && v > 0) return v;
  }
  return null;
}

// ---------- 데이터 불러오기 ----------
async function loadVWorld() {
  if (!vwKey()) { log('V-World 인증키를 입력하세요.', 'err'); return; }
  store.set('vw_key', vwKey()); store.set('vw_domain', vwDomain());
  S.demo = false;
  const base = $('base').value.trim();
  const jibuns = [...new Set($('jibuns').value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
  S.radius = parseFloat($('radius').value) || 200;
  log(`대지 필지 ${jibuns.length}개 검색 중…`);
  const siteFeats = [];
  for (const j of jibuns) {
    try {
      const [lon, lat] = await geocode(`${base} ${j}`);
      const fs = await getFeatures('LP_PA_CBND_BUBUN', `POINT(${lon} ${lat})`, 1);
      if (!fs.length) { log(`  ${j}: 필지 없음`, 'warn'); continue; }
      fs[0].__jibun = j;
      siteFeats.push(fs[0]);
      log(`  ${j}: OK`);
    } catch (e) { log(`  ${j}: ${e.message}`, 'err'); }
  }
  if (!siteFeats.length) { log('대지를 찾지 못했습니다.', 'err'); return; }

  // 원점 = 대지 필지 중심
  let sx = 0, sy = 0, n = 0;
  siteFeats.forEach((f) => outerRings(f.geometry).forEach((r) => r.forEach(([x, y]) => { sx += x; sy += y; n++; })));
  S.origin = { lon: sx / n, lat: sy / n };
  const sitePnu = new Set(siteFeats.map((f) => f.properties.pnu));
  S.siteParcels = [];
  siteFeats.forEach((f, i) => outerRings(f.geometry).forEach((r, k) => {
    S.siteParcels.push({ id: 's' + i + '_' + k, jibun: f.__jibun, ring: cleanRing(r.map(([x, y]) => project(x, y))), ground: 0, props: f.properties });
  }));

  // 주변 BOX
  const [lon0, lat0] = unproject(-S.radius, -S.radius);
  const [lon1, lat1] = unproject(S.radius, S.radius);
  const box = `BOX(${lon0},${lat0},${lon1},${lat1})`;
  log(`주변 반경 ${S.radius}m 필지·건물 불러오는 중…`);
  let pf = [], bf = [];
  try { pf = await getFeatures('LP_PA_CBND_BUBUN', box); } catch (e) { log('필지: ' + e.message, 'err'); }
  try { bf = await getFeatures('LT_C_SPBD', box); } catch (e) { log('건물: ' + e.message, 'err'); }
  let rf = [];
  try { rf = await getFeatures('LT_L_SPRD', box); } catch (e) { log('도로명: ' + e.message, 'warn'); }
  S.roadLines = [];
  rf.forEach((f) => {
    const g = f.geometry; if (!g || !f.properties.rn) return;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    lines.forEach((ln) => S.roadLines.push({ name: f.properties.rn, pts: ln.map(([x, y]) => project(x, y)).map(([x, y]) => [r2(x), r2(y)]) }));
  });
  S.parcels = [];
  pf.filter((f) => !sitePnu.has(f.properties.pnu)).forEach((f, i) => outerRings(f.geometry).forEach((r, k) => {
    S.parcels.push({ id: 'p' + i + '_' + k, ring: cleanRing(r.map(([x, y]) => project(x, y))), ground: 0, props: f.properties });
  }));
  S.buildings = [];
  let noFloor = 0;
  bf.forEach((f, i) => outerRings(f.geometry).forEach((r, k) => {
    const p = f.properties;
    const floors = readFloors(p);
    const h = readHeight(p);
    if (!floors && !h) noFloor++;
    S.buildings.push({
      id: 'b' + i + '_' + k, ring: cleanRing(r.map(([x, y]) => project(x, y))),
      floors: floors || 2, height: h || (floors || 2) * S.floorH, heightSrc: h ? 'data' : floors ? 'floors' : 'default', ground: 0, props: p,
    });
  }));
  // 대지 안의 기존 건물 표시
  S.buildings.forEach((b) => { b.onSite = S.siteParcels.some((sp) => pip(centroid(b.ring), sp.ring)); });
  log(`필지 ${S.parcels.length} · 건물 ${S.buildings.length} 불러옴` + (noFloor ? ` (층수 없는 건물 ${noFloor}개는 2층으로 가정)` : ''), 'ok');
  T.ready = false; S.env = null; S.mass = null;
  buildScene(true);
  await sampleTerrain();
  await loadZoning();
}

function loadDemo() {
  S.demo = true;
  S.origin = { lon: 126.9215, lat: 37.5535 };
  S.radius = 150;
  const rnd = mulberry(7);
  S.siteParcels = [
    { id: 's0', jibun: '데모-1', ring: [[-20, -15], [5, -15], [5, 15], [-20, 15]], ground: 0, props: {} },
    { id: 's1', jibun: '데모-2', ring: [[5, -15], [22, -15], [22, 15], [5, 15]], ground: 0, props: {} },
  ];
  S.parcels = []; S.buildings = [];
  let id = 0;
  for (let gx = -140; gx < 140; gx += 28) for (let gy = -140; gy < 140; gy += 24) {
    const r = [[gx, gy], [gx + 26, gy], [gx + 26, gy + 22], [gx, gy + 22]];
    if (Math.abs(gx + 13) < 40 && Math.abs(gy + 11) < 30) continue;
    // 북쪽으로 갈수록 지반 상승 (데모용 경사)
    const ground = Math.max(0, (gy + 11) * 0.06);
    S.parcels.push({ id: 'p' + id, ring: r, ground, props: {} });
    const floors = 1 + Math.floor(rnd() * (gx > 40 ? 18 : 6));
    S.buildings.push({ id: 'b' + id++, ring: [[gx + 3, gy + 3], [gx + 23, gy + 3], [gx + 23, gy + 19], [gx + 3, gy + 19]], floors, height: floors * S.floorH, heightSrc: 'floors', ground, props: { 비고: '데모 가상 건물' } });
  }
  T.ready = false; S.env = null; S.mass = null;
  log('데모 데이터(가상)를 불러왔습니다. 실제 대지는 V-World 키로 불러오세요.', 'warn');
  buildScene(true);
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- 지형: AWS Terrain Tiles (terrarium, z15 ≈ 3.8m 픽셀, 공개 DEM 기반 참고값) ----------
const TZ = 15;
const T = { tiles: {}, base: 0, ready: false };
function tileXY(lon, lat) {
  const n = 2 ** TZ, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}
async function fetchTile(tx, ty) {
  const k = tx + '_' + ty;
  if (T.tiles[k]) return;
  const blob = await (await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TZ}/${tx}/${ty}.png`)).blob();
  const bm = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'); g.drawImage(bm, 0, 0);
  const d = g.getImageData(0, 0, 256, 256).data;
  const e = new Float32Array(256 * 256);
  for (let i = 0; i < e.length; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  T.tiles[k] = e;
}
function pixAbs(gx, gy) { // 전역 픽셀 좌표
  const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
  const t = T.tiles[tx + '_' + ty];
  if (!t) return null;
  return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
}
function elevAbsLL(lon, lat) {
  const [x, y] = tileXY(lon, lat);
  const px = x * 256 - 0.5, py = y * 256 - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  const a = pixAbs(x0, y0), b = pixAbs(x0 + 1, y0), c = pixAbs(x0, y0 + 1), d = pixAbs(x0 + 1, y0 + 1);
  if ([a, b, c, d].some((v) => v === null)) return null;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
// 로컬 좌표(m) → 대지 최저점 기준 상대 높이
function elev(x, y) {
  if (!T.ready) return 0;
  if (T.grid) {
    const G = T.grid, fx = (x - G.x0) / G.step, fy = (y - G.y0) / G.step;
    const i = Math.max(0, Math.min(G.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(G.ny - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
    const v = (a, b) => G.data[b * G.nx + a];
    return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty;
  }
  const v = elevAbsLL(...unproject(x, y));
  return v === null ? 0 : v - T.base;
}
function ringGroundMin(ring) { return Math.min(...densify(ring, 3).map(([x, y]) => elev(x, y))); }
function ringGroundAvg(ring) { const pts = densify(ring, 3); pts.push(centroid(ring)); return pts.reduce((a, [x, y]) => a + elev(x, y), 0) / pts.length; }
function densify(ring, step) {
  const out = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let k = 0; k < n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  });
  return out;
}

async function sampleTerrain(quiet) {
  if (!S.origin || S.demo) return;
  const R = S.radius + 30;
  const [lonA, latA] = unproject(-R, -R), [lonB, latB] = unproject(R, R);
  const [xa, yb] = tileXY(lonA, latA), [xb, ya] = tileXY(lonB, latB);
  const jobs = [];
  for (let tx = Math.floor(xa); tx <= Math.floor(xb); tx++) for (let ty = Math.floor(ya); ty <= Math.floor(yb); ty++) jobs.push(fetchTile(tx, ty));
  if (!quiet) log(`지형 타일 ${jobs.length}장 불러오는 중…`);
  try { await Promise.all(jobs); } catch (e) { log('지형 요청 실패: ' + e.message, 'err'); return; }
  T.ready = true; T.base = 0;
  // 기준 = 대지 필지 경계·중심 중 최저점
  const siteMin = Math.min(...S.siteParcels.flatMap((p) => densify(p.ring, 3).concat([centroid(p.ring)]).map(([x, y]) => elev(x, y))));
  T.base = siteMin;
  [...S.siteParcels, ...S.parcels].forEach((p) => { p.ground = +ringGroundAvg(p.ring).toFixed(2); });
  S.buildings.forEach((b) => { b.ground = +ringGroundMin(b.ring).toFixed(2); });
  log(`지형 반영 완료 · 대지 최저점 해발 약 ${siteMin.toFixed(1)}m = 기준 0 (공개 DEM 참고값, 실측 아님)`, 'ok');
  buildScene(false);
}

// ---------- 3D ----------
let renderer, scene, camera, controls, groupCtx, groupLines, raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selected = null;

function initThree() {
  const host = $('view');
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  host.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  const darkMQ = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  const applyBg = () => { scene.background = new THREE.Color(darkMQ && darkMQ.matches ? 0x1b1b1d : 0xf4f2ee); };
  applyBg();
  if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', applyBg);
  camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.position.set(220, 260, 260);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.maxPolarAngle = Math.PI * 0.495;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-150, 300, 120); // 남서쪽 하늘 (z+ = 남)
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 10, far: 1000 });
  scene.add(sun);
  groupCtx = new THREE.Group(); scene.add(groupCtx);
  groupLines = new THREE.Group(); scene.add(groupLines);
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize); resize();
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
}

// 평면 (x, y北) → three (x, z=-y)
function shapeFrom(ring) {
  const s = new THREE.Shape();
  ring.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  return s;
}
function prism(ring, h, ground, mat) {
  const r = polyArea(ring) < 0 ? ring.slice().reverse() : ring;
  const g = new THREE.ExtrudeGeometry(shapeFrom(r), { depth: Math.max(h, 0.05), bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // shape y → -z, extrude z → y
  const m = new THREE.Mesh(g, mat);
  m.position.y = ground;
  m.castShadow = m.receiveShadow = true;
  return m;
}
function outline(ring, y, color) {
  const pts = ring.concat([ring[0]]).map(([x, z]) => new THREE.Vector3(x, y, -z));
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
}

function siteGround() { return Math.min(...S.siteParcels.map((p) => p.ground)); }

function heightColor(top) {
  // 대지 지반 기준 상대 높이: 낮으면 청색, 높으면 적색
  const rel = top - siteGround();
  const t = Math.max(0, Math.min(1, rel / 60));
  const c = new THREE.Color();
  c.setHSL(0.6 - 0.6 * t, 0.55, 0.62);
  return c;
}

function drapedFill(ring, off, mat) {
  const r = polyArea(ring) < 0 ? ring.slice().reverse() : ring;
  const g = new THREE.ShapeGeometry(shapeFrom(densify(r, 4)));
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, elev(pos.getX(i), -pos.getZ(i)) + off);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function drapedLine(ring, off, color) {
  const pts = densify(ring, 2); pts.push(pts[0]);
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, elev(x, y) + off, -y))), new THREE.LineBasicMaterial({ color }));
}
function terrainMesh() {
  const R = S.radius, step = 2, n = Math.round((2 * R) / step);
  const g = new THREE.PlaneGeometry(2 * R, 2 * R, n, n);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, cols = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) { const h = elev(pos.getX(i), -pos.getZ(i)); pos.setY(i, h); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) { const t = (pos.getY(i) - lo) / Math.max(1, hi - lo); c.setHSL(0.1, 0.22, 0.9 - 0.22 * t); cols.push(c.r, c.g, c.b); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  m.receiveShadow = true;
  return { mesh: m, lo, hi };
}
// 등고선 (marching squares, 1m 간격 · 5m 주곡선)
function contours(lo, hi) {
  const R = S.radius, step = 2, n = Math.round((2 * R) / step);
  const H = [];
  for (let j = 0; j <= n; j++) { H.push([]); for (let i = 0; i <= n; i++) H[j].push(elev(-R + i * step, -R + j * step)); }
  const minor = [], major = [];
  for (let lv = Math.ceil(lo); lv <= Math.floor(hi); lv++) {
    const out = lv % 5 === 0 ? major : minor;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const v = [H[j][i], H[j][i + 1], H[j + 1][i + 1], H[j + 1][i]];
      const P = [[-R + i * step, -R + j * step], [-R + (i + 1) * step, -R + j * step], [-R + (i + 1) * step, -R + (j + 1) * step], [-R + i * step, -R + (j + 1) * step]];
      const cross = [];
      for (let e = 0; e < 4; e++) {
        const a = v[e], b = v[(e + 1) % 4];
        if ((a < lv) !== (b < lv)) { const t = (lv - a) / (b - a); const A = P[e], B = P[(e + 1) % 4]; cross.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); }
      }
      for (let k = 0; k + 1 < cross.length; k += 2) cross.slice(k, k + 2).forEach(([x, y]) => out.push(x, lv + 0.08, -y));
    }
  }
  const mk = (arr, color, op) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op })); };
  return [mk(minor, 0x7a6e58, 0.6), mk(major, 0x3d3426, 1)];
}

function buildScene(resetCam) {
  groupCtx.clear(); groupLines.clear(); S.sectionPts = []; $('section').innerHTML = ''; $('sectionBox').style.display = 'none'; S.groundMesh = null;
  if (T.ready) {
    const { mesh, lo, hi } = terrainMesh();
    mesh.userData = { kind: 'ground' }; S.groundMesh = mesh;
    groupCtx.add(mesh);
    if ($('showContours').checked) contours(lo, hi).forEach((l) => groupCtx.add(l));
    const pMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.01, depthWrite: false });
    S.parcels.forEach((p) => {
      const m = drapedFill(p.ring, 0.05, pMat); m.userData = { kind: 'parcel', ref: p };
      groupCtx.add(m); groupCtx.add(drapedLine(p.ring, 0.12, 0xb0a794));
    });
    const sMat = new THREE.MeshLambertMaterial({ color: 0xd94f3d, transparent: true, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
    S.siteParcels.forEach((p) => {
      const m = drapedFill(p.ring, 0.25, sMat); m.userData = { kind: 'site', ref: p };
      groupCtx.add(m); groupCtx.add(drapedLine(p.ring, 0.3, 0x7a1d12));
    });
  } else {
    const gp = new THREE.Mesh(new THREE.PlaneGeometry(4 * S.radius, 4 * S.radius).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf0ede7 }));
    gp.position.y = -0.1; gp.receiveShadow = true; gp.userData = { kind: 'ground' };
    groupCtx.add(gp);
    const parcelMat = new THREE.MeshLambertMaterial({ color: 0xe6e1d8 });
    S.parcels.forEach((p) => {
      const m = prism(p.ring, 0.05, p.ground - 0.05, parcelMat);
      m.castShadow = false; m.userData = { kind: 'parcel', ref: p };
      groupCtx.add(m); groupCtx.add(outline(p.ring, p.ground + 0.02, 0xbdb5a6));
    });
    const siteMat = new THREE.MeshLambertMaterial({ color: 0xd94f3d, transparent: true, opacity: 0.85 });
    S.siteParcels.forEach((p) => {
      const m = prism(p.ring, 0.3, p.ground - 0.05, siteMat);
      m.castShadow = false; m.userData = { kind: 'site', ref: p };
      groupCtx.add(m); groupCtx.add(outline(p.ring, p.ground + 0.3, 0x7a1d12));
    });
  }
  const hideSite = $('hideSiteBldg').checked;
  S.buildings.forEach((b) => {
    if (b.onSite && hideSite) { b.mesh = null; return; }
    const top = b.ground + b.height;
    const mat = new THREE.MeshLambertMaterial({ color: b.onSite ? 0x999999 : heightColor(top), transparent: !!b.onSite, opacity: b.onSite ? 0.35 : 1 });
    const m = prism(b.ring, b.height, b.ground, mat);
    m.userData = { kind: 'building', ref: b };
    b.mesh = m;
    groupCtx.add(m);
  });
  const n = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(S.radius * 0.85, (T.ready ? elev(S.radius * 0.85, S.radius * 0.6) : 0) + 3, -S.radius * 0.6), 30, 0x222222, 8, 5);
  groupCtx.add(n);
  drawRoads();
  S.envGroup = null; drawEnvelope();
  S.massGroup = null; drawMass();
  S.altGroup = null; if (S.rule) drawAlts();
  if (S.mode === 'view') runViewAnalysis();
  updateStats();
  if (resetCam) { camera.position.set(S.radius * 1.1, S.radius * 1.3, S.radius * 1.3); controls.target.set(0, 0, 0); }
}

// ---------- 접도 분석: 대지 경계 바깥쪽 4m 지점이 도로인지, 그 높이는 얼마인지 ----------
function linearKind(p) { // 지목으로 도로·철도·구거 판별 (필지 없음 = 도로로 간주)
  if (!p) return '도로';
  const j = ((p.props && p.props.jibun) || '').trim();
  if (/도$/.test(j)) return '도로';
  if (/철$/.test(j)) return '철도부지';
  if (/구$/.test(j)) return '구거';
  return null;
}
function bearingName(nx, ny) {
  const a = (Math.atan2(nx, ny) * 180) / Math.PI; // 0 = 북, 시계방향
  const names = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  return names[Math.round(((a + 360) % 360) / 45) % 8];
}
function analyzeRoads() {
  if (!S.siteParcels.length) return [];
  const samples = [];
  S.siteParcels.forEach((sp) => {
    const r = polyArea(sp.ring) > 0 ? sp.ring.slice().reverse() : sp.ring; // CCW (polyArea는 CCW에서 음수)
    r.forEach((a, i) => {
      const b = r[(i + 1) % r.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.5) return;
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L; // 바깥 법선
      const n = Math.max(1, Math.round(L / 2));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        const ox = x + nx * 4, oy = y + ny * 4;
        if (S.siteParcels.some((q) => pip([ox, oy], q.ring))) continue; // 대지 내부 경계
        const hit = S.parcels.find((q) => pip([ox, oy], q.ring));
        const kind = linearKind(hit);
        samples.push({ x, y, ox, oy, nx, ny, len: L / n, road: !!kind, kind, edgeG: elev(x, y), roadG: elev(ox, oy) });
      }
    });
  });
  // 도로 샘플 묶기: 6m 이내 + 법선 방향 차 50° 이내
  const rs = samples.filter((q) => q.road);
  const par = rs.map((_, i) => i);
  const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const A = rs[i], B = rs[j];
    if (A.kind === B.kind && Math.hypot(A.x - B.x, A.y - B.y) < 6 && A.nx * B.nx + A.ny * B.ny > Math.cos((50 * Math.PI) / 180)) par[find(i)] = find(j);
  }
  const groups = {};
  rs.forEach((q, i) => (groups[find(i)] = groups[find(i)] || []).push(q));
  const roads = Object.values(groups).filter((g) => g.reduce((a, q) => a + q.len, 0) >= 4).map((g) => {
    const len = g.reduce((a, q) => a + q.len, 0);
    const nx = g.reduce((a, q) => a + q.nx * q.len, 0), ny = g.reduce((a, q) => a + q.ny * q.len, 0);
    const hs = g.map((q) => q.roadG);
    const lo = Math.min(...hs), hi = Math.max(...hs), avg = g.reduce((a, q) => a + q.roadG * q.len, 0) / len;
    // 접도 구간 양 끝 사이 경사
    let far = [g[0], g[0]], best = -1;
    g.forEach((p) => g.forEach((q) => { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d > best) { best = d; far = [p, q]; } }));
    const slope = best > 0 ? (Math.abs(far[0].roadG - far[1].roadG) / best) * 100 : 0;
    return { dir: bearingName(nx, ny), kind: g[0].kind, len, lo, hi, avg, slope, pts: g };
  }).sort((a, b) => b.len - a.len);
  // 이름: 도로명주소 도로구간(중심선) 중 접도 지점에 가장 가까운 도로명으로 투표, 없으면 방향·종류
  const near = (x, y) => {
    let best = null;
    (S.roadLines || []).forEach((l) => { for (let i = 0; i + 1 < l.pts.length; i++) { const d = segDist([x, y], l.pts[i], l.pts[i + 1]); if (d < 20 && (!best || d < best.d)) best = { d, n: l.name }; } });
    return best && best.n;
  };
  roads.forEach((r) => {
    const votes = {};
    if (r.kind === '도로') r.pts.forEach((q) => { const n = near(q.ox, q.oy); if (n) votes[n] = (votes[n] || 0) + q.len; });
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    r.key = r.dir + '|' + r.kind;
    r.name = (S.roadNames && S.roadNames[r.key]) || (top ? top[0] : `${r.dir}측 ${r.kind}`);
  });
  const seen = {};
  roads.forEach((r) => { if (seen[r.name]) r.name += ' (' + r.dir + '측)'; seen[r.name] = 1; });
  return roads;
}
function textSprite(text, color = '#1f3b8f') {
  const c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = 'bold 44px sans-serif';
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w; c.height = 64;
  g.font = 'bold 44px sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 0, w, 64);
  g.strokeStyle = color; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, 60);
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 14, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sp.scale.set(w / 9, 64 / 9, 1);
  sp.renderOrder = 10;
  return sp;
}
function drawRoads() {
  S.roads = T.ready ? analyzeRoads() : [];
  const box = $('roadList');
  if (!S.roads.length) { box.innerHTML = T.ready ? '접도 구간을 찾지 못했어요.' : '지형을 불러오면 분석해요.'; return; }
  S.roads.forEach((r) => {
    const pts = r.pts.map((q) => new THREE.Vector3(q.ox, q.roadG + 0.4, -q.oy));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    groupCtx.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x1f3b8f, size: 2.2, sizeAttenuation: true })));
    const mid = r.pts[Math.floor(r.pts.length / 2)];
    if ($('roadLabels').checked) { // 규칙 질문에서 A·B·C로 부르므로 이름만 작게
      const lab = textSprite(r.name, '#1f3b8f'); lab.scale.multiplyScalar(0.45);
      lab.position.set(mid.ox + mid.nx * 6, mid.roadG + 4, -(mid.oy + mid.ny * 6));
      groupCtx.add(lab);
    }
  });
  const all = S.roads.map((r) => r.avg);
  const diff = Math.max(...all) - Math.min(...all);
  const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  box.innerHTML = S.roads.map((r, i) => `<input class="rname" data-ri="${i}" value="${r.name.replace(/"/g, '&quot;')}" title="이름 고치기"> ${r.name.includes(r.kind) ? '' : r.dir + '측 ' + r.kind + ' '}· 접도 ${r.len.toFixed(0)}m · 평균 ${fmt(r.avg)}m (${fmt(r.lo)} ~ ${fmt(r.hi)}) · 경사 ${r.slope.toFixed(1)}%`).join('<br>') +
    (S.roads.length > 1 ? `<br><b>접도 간 높이차 ${diff.toFixed(1)}m</b> (평균 기준) · 최대 ${(Math.max(...S.roads.map((r) => r.hi)) - Math.min(...S.roads.map((r) => r.lo))).toFixed(1)}m` : '') +
    `<br><span class="dim">기준 0 = 대지 최저점 (해발 ${T.base.toFixed(1)}m). 경계 밖 4m 지점의 지형 높이. 이름 칸을 눌러 고칠 수 있어요.</span>`;
  box.querySelectorAll('input.rname').forEach((inp) => (inp.onchange = () => {
    const r = S.roads[+inp.dataset.ri], v = inp.value.trim();
    S.roadNames = S.roadNames || {};
    if (v) S.roadNames[r.key] = v; else delete S.roadNames[r.key];
    buildScene(false);
  }));
}

function updateStats() {
  const area = S.siteParcels.reduce((a, p) => a + Math.abs(polyArea(p.ring)), 0);
  const gs = S.siteParcels.map((p) => p.ground);
  const others = S.parcels.map((p) => p.ground);
  $('stats').innerHTML = S.origin ? `
    <b>대지</b> ${S.siteParcels.length}필지 · 약 ${area.toFixed(0)}㎡${S.demo ? ' (데모)' : ''}<br>
    <b>대지 지반고</b> ${Math.min(...gs).toFixed(1)} ~ ${Math.max(...gs).toFixed(1)} m${T.ready ? ` <span class="dim">(기준 0 = 해발 ${T.base.toFixed(1)}m)</span>` : ' <span class="dim">(지형 미반영)</span>'}<br>
    <b>주변 지반고</b> ${others.length ? Math.min(...others).toFixed(1) + ' ~ ' + Math.max(...others).toFixed(1) + ' m' : '-'}<br>
    <b>주변 건물</b> ${S.buildings.filter((b) => !b.onSite).length}동 · 최고 ${Math.max(0, ...S.buildings.map((b) => b.ground + b.height)).toFixed(0)} m` : '';
}

// ---------- 시선 분석: 주변 건물 옥상에서 대지가 보이는가 ----------
function sitePoints() {
  const pts = [];
  S.siteParcels.forEach((p) => {
    const xs = p.ring.map((q) => q[0]), ys = p.ring.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const step = Math.max(3, Math.min(x1 - x0, y1 - y0) / 4);
    for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) if (pip([x, y], p.ring)) pts.push(new THREE.Vector3(x, (T.ready ? elev(x, y) : p.ground) + 1, -y));
    const c = centroid(p.ring); pts.push(new THREE.Vector3(c[0], (T.ready ? elev(c[0], c[1]) : p.ground) + 1, -c[1]));
  });
  return pts;
}
// 원인: 지형 메시(8만 삼각형)와 건물 수백 동에 광선을 수만 번 쏘아 화면이 멈췄음.
// 해결: 건물은 격자 색인 + 2D 선분-다각형 교차로, 지형은 선을 따라 높이만 샘플링, 그리고 나눠서 계산.
let viewRun = 0;
async function runViewAnalysis() {
  const run = ++viewRun;
  groupLines.clear();
  const all = sitePoints();
  const step = Math.max(1, Math.ceil(all.length / 24)); // 대지 표본점은 최대 ~24개
  const targets = all.filter((_, i) => i % step === 0);
  const ctx = S.buildings.filter((b) => !b.onSite && b.mesh);
  // 건물 bbox 격자 색인 (20m)
  const CELL = 20, grid = new Map();
  ctx.forEach((b, bi) => {
    const xs = b.ring.map((q) => q[0]), ys = b.ring.map((q) => q[1]);
    b._bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    for (let gx = Math.floor(b._bb[0] / CELL); gx <= Math.floor(b._bb[2] / CELL); gx++)
      for (let gy = Math.floor(b._bb[1] / CELL); gy <= Math.floor(b._bb[3] / CELL); gy++) {
        const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(bi);
      }
  });
  const segX = (ax, ay, bx, by, cx, cy, dx, dy) => { // 선분 AB와 CD 교차 시 AB 위의 t
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : null;
  };
  function blocked(E, P, self) {
    const L = Math.hypot(P.x - E.x, P.y - E.y);
    // 건물
    const seen = new Set();
    for (let d = 0; d <= L + CELL; d += CELL / 2) {
      const t = Math.min(1, d / L), x = E.x + (P.x - E.x) * t, y = E.y + (P.y - E.y) * t;
      const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || [];
      for (const bi of list) {
        if (seen.has(bi)) continue; seen.add(bi);
        const b = ctx[bi]; if (b === self) continue;
        const top = b.ground + b.height, r = b.ring;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const tt = segX(E.x, E.y, P.x, P.y, r[j][0], r[j][1], r[i][0], r[i][1]);
          if (tt !== null && E.z + (P.z - E.z) * tt < top) return true;
        }
      }
    }
    // 지형 (양 끝 3m 제외)
    if (T.ready) for (let d = 3; d < L - 3; d += 3) {
      const t = d / L, x = E.x + (P.x - E.x) * t, y = E.y + (P.y - E.y) * t;
      if (elev(x, y) > E.z + (P.z - E.z) * t + 0.1) return true;
    }
    return false;
  }
  const showLines = $('showLines').checked;
  const results = [];
  $('viewList').innerHTML = '계산 중… 0%';
  for (let k = 0; k < ctx.length; k++) {
    const b = ctx[k];
    const c = centroid(b.ring);
    const E = { x: c[0], y: c[1], z: b.ground + b.height + 1.5 };
    let vis = 0, firstT = null;
    for (const t of targets) {
      const P = { x: t.x, y: -t.z, z: t.y };
      if (!blocked(E, P, b)) { vis++; if (!firstT) firstT = t; }
    }
    const ratio = vis / targets.length, down = E.z - siteGround();
    b.view = { ratio, down };
    const col = new THREE.Color();
    if (ratio === 0) col.set(0xd9d6d0); else col.setHSL(0.08, 0.9, 0.75 - 0.35 * ratio);
    b.mesh.material.color = col;
    if (ratio > 0) {
      results.push(b);
      if (showLines && firstT) groupLines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(E.x, E.z, -E.y), firstT]), new THREE.LineBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.5 })));
    }
    if (k % 25 === 24) { // 화면이 멈추지 않게 나눠서 계산
      $('viewList').innerHTML = `계산 중… ${Math.round(((k + 1) / ctx.length) * 100)}%`;
      await new Promise((r) => setTimeout(r, 0));
      if (run !== viewRun || S.mode !== 'view') return;
    }
  }
  results.sort((a, b) => b.view.ratio * b.view.down - a.view.ratio * a.view.down);
  $('viewList').innerHTML = `<b>대지를 내려다보는 건물 ${results.length}동</b> / ${ctx.length}동<br>` +
    results.slice(0, 8).map((b) => `· ${label(b)} — 대지 ${(b.view.ratio * 100).toFixed(0)}% 보임, 눈높이 대지+${b.view.down.toFixed(0)}m`).join('<br>');
}
function label(b) {
  const p = b.props || {};
  return p.buld_nm || p.bld_nm || p.bd_nm || `${b.floors}층 건물`;
}

function setMode(m) {
  S.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('legendHeight').style.display = m === 'height' ? '' : 'none';
  $('legendView').style.display = m === 'view' ? '' : 'none';
  if (S.origin) buildScene(false);
}

// ---------- 선택 / 편집 ----------
let downAt = null;
function onDown(e) { downAt = [e.clientX, e.clientY]; }
function onUp(e) {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera); raycaster.far = Infinity;
  const hits = raycaster.intersectObjects(groupCtx.children.filter((o) => o.userData.kind), false);
  if (!hits.length) return;
  if ($('sectionMode').checked) { addSectionPoint(hits[0].point); return; }
  const h = hits.find((x) => x.object.userData.kind !== 'ground');
  if (h) select(h.object.userData);
}
function select(ud) {
  selected = ud;
  const r = ud.ref;
  const kindName = { site: '대지 필지', parcel: '주변 필지', building: '건물' }[ud.kind];
  let html = `<b>${kindName}</b>${r.jibun ? ' ' + r.jibun : ''}<br>`;
  html += `지반고 <input id="edGround" type="number" step="0.1" value="${r.ground}"> m<br>`;
  if (ud.kind === 'building') {
    html += `층수 <input id="edFloors" type="number" value="${r.floors}"> · 높이 <input id="edH" type="number" step="0.1" value="${r.height.toFixed(1)}"> m<br>`;
    html += `<span class="dim">높이 출처: ${{ data: '데이터', floors: '층수×층고', default: '가정값' }[r.heightSrc]}</span><br>`;
  }
  const props = Object.entries(r.props || {}).filter(([, v]) => v !== null && v !== '').slice(0, 14);
  if (props.length) html += `<details><summary>속성</summary>${props.map(([k, v]) => `${k}: ${v}`).join('<br>')}</details>`;
  $('info').innerHTML = html;
  $('edGround').onchange = (e) => { r.ground = parseFloat(e.target.value) || 0; if (ud.kind !== 'building') S.buildings.forEach((b) => { if (pip(centroid(b.ring), r.ring)) b.ground = r.ground; }); buildScene(false); };
  if (ud.kind === 'building') {
    $('edFloors').onchange = (e) => { r.floors = parseInt(e.target.value, 10) || 1; r.height = r.floors * S.floorH; r.heightSrc = 'floors'; buildScene(false); select(ud); };
    $('edH').onchange = (e) => { r.height = parseFloat(e.target.value) || 1; r.heightSrc = 'data'; buildScene(false); };
  }
}

// ---------- 단면 ----------
function addSectionPoint(p) {
  S.sectionPts.push([p.x, -p.z]);
  if (S.sectionPts.length === 2) { drawSection(); }
  if (S.sectionPts.length > 2) { S.sectionPts = [[p.x, -p.z]]; }
  groupLines.children.filter((o) => o.userData.section).forEach((o) => groupLines.remove(o));
  if (S.sectionPts.length === 2) {
    const [a, b] = S.sectionPts;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(2, Math.ceil(L / 2)), pts = [];
    for (let i = 0; i <= n; i++) { const x = a[0] + ((b[0] - a[0]) * i) / n, y = a[1] + ((b[1] - a[1]) * i) / n; pts.push(new THREE.Vector3(x, elev(x, y) + 0.6, -y)); }
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x0044ff, depthTest: false }));
    ln.userData.section = true; groupLines.add(ln);
  }
}
function groundAt(pt) {
  const p = [...S.siteParcels, ...S.parcels].find((q) => pip(pt, q.ring));
  const site = !!p && S.siteParcels.includes(p);
  if (T.ready) return { g: elev(pt[0], pt[1]), site };
  return p ? { g: p.ground, site } : null;
}
function drawSection() {
  const [a, b] = S.sectionPts;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const N = Math.ceil(L / 0.5);
  const samples = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const g = groundAt(pt);
    const bl = S.buildings.find((q) => q.mesh && pip(pt, q.ring));
    samples.push({ d: t * L, g: g ? g.g : null, site: g && g.site, top: bl ? bl.ground + bl.height : null, bg: bl ? bl.ground : null });
  }
  const ex = parseFloat($('secEx').value) || 1;
  const gs = samples.filter((s) => s.g !== null).map((s) => s.g);
  const tops = samples.filter((s) => s.top !== null).map((s) => s.top);
  const ymin = Math.min(...gs) - 2, ymax = Math.max(Math.min(...gs) + 10, ...tops, ...gs) + 3;
  const W = 1000, H = 300, padL = 46, padB = 22, padR = 34;
  const sx = (W - padL - padR) / L;
  const sy = Math.min((H - padB - 14) / (ymax - ymin), sx * ex);
  const X = (d) => padL + d * sx, Y = (v) => H - padB - (v - ymin) * sy;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="font:12px sans-serif">`;
  // 높이 눈금
  const stepV = ymax - ymin > 40 ? 10 : 5;
  for (let v = Math.ceil(ymin / stepV) * stepV; v <= ymax; v += stepV) svg += `<line x1="${padL}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eee"/><text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end" fill="#888">${v >= 0 ? '+' : ''}${v}</text>`;
  let run = null;
  const flush = (end) => { if (run) { svg += `<rect x="${X(run.d0)}" y="${Y(run.top)}" width="${(end - run.d0) * sx}" height="${Y(run.bg) - Y(run.top)}" fill="#d9d4ca" stroke="#666" stroke-width="0.8"/>`; run = null; } };
  samples.forEach((s) => {
    if (s.top === null || (run && (run.top !== s.top || run.bg !== s.bg))) flush(s.d);
    if (s.top !== null && !run) run = { d0: s.d, top: s.top, bg: s.bg };
  });
  flush(L);
  let path = '';
  samples.forEach((s) => { if (s.g !== null) path += (path ? 'L' : 'M') + X(s.d).toFixed(1) + ' ' + Y(s.g).toFixed(1); });
  svg += `<path d="${path}" fill="none" stroke="#111" stroke-width="2"/>`;
  // 대지 구간
  let sr = null; const sites = [];
  samples.forEach((s) => { if (s.site && !sr) sr = { d0: s.d }; if (!s.site && sr) { sr.d1 = s.d; sites.push(sr); sr = null; } });
  if (sr) { sr.d1 = L; sites.push(sr); }
  sites.forEach((r) => { svg += `<rect x="${X(r.d0)}" y="${H - padB + 3}" width="${(r.d1 - r.d0) * sx}" height="6" fill="#d94f3d"/>`; });
  // 양 끝·대지 경계 지반고 표기
  const lab = (d) => { const s = samples.reduce((p, q) => (Math.abs(q.d - d) < Math.abs(p.d - d) ? q : p)); if (s.g === null) return ''; return `<circle cx="${X(s.d)}" cy="${Y(s.g)}" r="3" fill="#1f3b8f"/><text x="${X(s.d)}" y="${Y(s.g) - 8}" text-anchor="middle" fill="#1f3b8f" font-weight="bold">${s.g >= 0 ? '+' : ''}${s.g.toFixed(1)}</text>`; };
  svg += lab(0) + lab(L);
  sites.forEach((r) => { svg += lab(r.d0) + lab(r.d1); });
  svg += `<text x="${padL}" y="${H - 4}" fill="#555">0</text><text x="${W - 10}" y="${H - 4}" text-anchor="end" fill="#555">${L.toFixed(0)}m</text>`;
  svg += `<text x="${padL + 4}" y="14" fill="#333">단면 길이 ${L.toFixed(0)}m · 수직 과장 ×${(sy / sx).toFixed(1)} · 빨강 띠 = 대지 · 파랑 = 지반고(m, 대지 최저점 기준)</text></svg>`;
  $('section').innerHTML = svg;
  $('sectionBox').style.display = 'block';
}

// ================= 2단계: 법규 볼륨 =================
// 서울특별시 도시계획 조례 기준 (지구단위계획·특례가 있으면 그 값이 우선 — 반드시 확인)
const ZONES = {
  '제1종전용주거지역': [50, 100, true], '제2종전용주거지역': [40, 120, true],
  '제1종일반주거지역': [60, 150, true], '제2종일반주거지역': [60, 200, true], '제3종일반주거지역': [50, 250, true],
  '준주거지역': [60, 400, false], '중심상업지역': [60, 1000, false], '일반상업지역': [60, 800, false],
  '근린상업지역': [60, 600, false], '유통상업지역': [60, 600, false], '전용공업지역': [60, 200, false],
  '일반공업지역': [60, 200, false], '준공업지역': [60, 400, false], '보전녹지지역': [20, 50, false],
  '생산녹지지역': [20, 50, false], '자연녹지지역': [20, 50, false],
};
async function vwPoint(layer, x, y) {
  if (STUDIO) return [];
  const [lon, lat] = unproject(x, y);
  const q = new URLSearchParams({ service: 'data', request: 'GetFeature', version: '2.0', data: layer, key: vwKey(), domain: vwDomain(),
    geomFilter: `POINT(${lon} ${lat})`, crs: 'EPSG:4326', format: 'json', errorFormat: 'json', size: '10', geometry: 'false', attribute: 'true' });
  const d = await jsonp('https://api.vworld.kr/req/data?' + q);
  const r = d && d.response;
  if (!r || r.status !== 'OK') return [];
  return r.result.featureCollection.features.map((f) => f.properties);
}
async function loadZoning() {
  if (S.demo || !S.siteParcels.length) { $('zoneInfo').innerHTML = '실제 대지를 불러오면 자동 조회해요.'; return; }
  $('zoneInfo').textContent = '용도지역 조회 중…';
  const zones = {}, others = new Set();
  for (const p of S.siteParcels) {
    const c = interiorPoint(p.ring);
    try {
      (await vwPoint('LT_C_UQ111', c[0], c[1])).forEach((a) => (zones[a.uname] = (zones[a.uname] || 0) + Math.abs(polyArea(p.ring))));
    } catch (e) { /* 무시 */ }
  }
  const c0 = interiorPoint(S.siteParcels[0].ring);
  for (const L of ['LT_C_UQ121', 'LT_C_UQ123', 'LT_C_UQ124', 'LT_C_UQ125', 'LT_C_UQ126', 'LT_C_UQ128', 'LT_C_UQ129', 'LT_C_UQ130', 'LT_C_UPISUQ161']) {
    try { (await vwPoint(L, c0[0], c0[1])).forEach((a) => others.add(a.uname || a.dgm_nm || L)); } catch (e) { /* 무시 */ }
  }
  const list = Object.entries(zones).sort((a, b) => b[1] - a[1]);
  S.zone = list.length ? list[0][0] : null;
  if (S.zone && ZONES[S.zone]) {
    $('zSel').value = S.zone;
    applyZoneDefaults();
  }
  $('zoneInfo').innerHTML = (list.length ? list.map(([n, a]) => `<b>${n}</b> ${a.toFixed(0)}㎡`).join(' · ') : '용도지역을 찾지 못했어요. 직접 고르세요.') +
    (others.size ? `<br>기타 지역·지구: ${[...others].join(', ')}` : '<br>지구단위계획·용도지구: 조회된 것 없음') +
    `<br><span class="dim">서울시 조례 기본값이에요. 지구단위계획, 건축선, 높이 지정은 토지이음(eum.go.kr)에서 꼭 확인하세요.</span>`;
}
function interiorPoint(ring) {
  const c = centroid(ring);
  if (pip(c, ring)) return c;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  for (let k = 0; k < 400; k++) {
    const pt = [Math.min(...xs) + Math.random() * (Math.max(...xs) - Math.min(...xs)), Math.min(...ys) + Math.random() * (Math.max(...ys) - Math.min(...ys))];
    if (pip(pt, ring)) return pt;
  }
  return c;
}
function applyZoneDefaults() {
  const z = ZONES[$('zSel').value];
  if (!z) return;
  $('zBcr').value = z[0]; $('zFar').value = z[1]; $('zSun').checked = z[2];
}

// 대지 외곽 경계선 (대지 필지끼리 맞닿은 선 제외) + 바깥이 도로인지
function siteExteriorEdges() {
  const edges = [];
  S.siteParcels.forEach((sp) => {
    const r = polyArea(sp.ring) > 0 ? sp.ring.slice().reverse() : sp.ring; // CCW
    r.forEach((a, i) => {
      const b = r[(i + 1) % r.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.2) return;
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L;
      // 짧게 나눠서 각 조각마다 바깥 판정
      const n = Math.max(1, Math.round(L / 2));
      for (let k = 0; k < n; k++) {
        const p0 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        const p1 = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
        const m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        if (S.siteParcels.some((q) => pip([m[0] + nx * 0.6, m[1] + ny * 0.6], q.ring))) continue;
        const hit = S.parcels.find((q) => pip([m[0] + nx * 4, m[1] + ny * 4], q.ring));
        edges.push({ a: p0, b: p1, nx, ny, road: !!linearKind(hit) });
      }
    });
  });
  return edges;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
// 셀 중심에서 정북(+y)으로 쏜 선이 처음 만나는 외곽 경계
function northHit(p, edges) {
  let best = null;
  edges.forEach((e) => {
    const [x0, y0] = e.a, [x1, y1] = e.b;
    if ((x0 - p[0]) * (x1 - p[0]) > 0 || x0 === x1) return;
    const t = (p[0] - x0) / (x1 - x0);
    const y = y0 + (y1 - y0) * t;
    if (y <= p[1]) return;
    const d = y - p[1];
    if (!best || d < best.d) best = { d, e };
  });
  return best;
}

// 도로·철도·구거(또는 필지 없는 땅)를 지나 정북으로 처음 만나는 일반 대지의 경계
function marchNorth(x, y0) {
  const lim = S.radius;
  const lotAt = (y) => { const q = S.parcels.find((pp) => pip([x, y], pp.ring)); return q && !linearKind(q) && !S.siteParcels.includes(q) ? q : null; };
  let prev = y0;
  for (let y = y0 + 0.5; y < lim; y += 0.5) {
    const q = lotAt(y);
    if (q) {
      let lo = prev, hi = y;
      for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (lotAt(m)) hi = m; else lo = m; }
      return { y: hi, parcel: q };
    }
    prev = y;
  }
  return null;
}
async function buildEnvelope() {
  if (!S.siteParcels.length) return;
  $('envInfo').textContent = '계산 중…';
  const cs = 0.5;
  const bcr = parseFloat($('zBcr').value) || 0, far = parseFloat($('zFar').value) || 0;
  const hIn = parseFloat($('zHmax').value); const hMax = hIn > 0 ? hIn : 30; // 미입력 시 표시 상한 30m
  const sbRoad = parseFloat($('zSbRoad').value) || 0, sbNb = parseFloat($('zSbNb').value) || 0;
  const sun = $('zSun').checked, sunRoad = $('zSunRoad').checked;
  const sunD = Math.max(1.5, parseFloat($('zSunD').value) || 1.5); // 1.5m 이상 범위에서 건축조례
  const sunNew = $('zSunRule').value === 'new';
  const sunD2 = Math.max(5, parseFloat($('zSunD2').value) || 5); // 10~17m 구간: 5m 이상 범위에서 건축조례
  const fh = S.floorH;
  const edges = siteExteriorEdges();
  const area = S.siteParcels.reduce((a, p) => a + Math.abs(polyArea(p.ring)), 0);
  // 높이 기준면: 대지 경계 지반의 평균 (지표면 산정 단순화)
  const bpts = edges.map((e) => [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]);
  const G0 = bpts.reduce((a, [x, y]) => a + elev(x, y), 0) / Math.max(1, bpts.length);
  const xs = S.siteParcels.flatMap((p) => p.ring.map((q) => q[0])), ys = S.siteParcels.flatMap((p) => p.ring.map((q) => q[1]));
  const X0 = Math.floor(Math.min(...xs)), Y0 = Math.floor(Math.min(...ys));
  const nx = Math.ceil((Math.max(...xs) - X0) / cs), ny = Math.ceil((Math.max(...ys) - Y0) / cs);
  const cells = [];
  let sunLimited = 0, evaluated = 0;
  // 1차: 셀마다 정북 기준선 찾기
  const refCache = new Map();
  const pending = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = [X0 + (i + 0.5) * cs, Y0 + (j + 0.5) * cs];
    if (!S.siteParcels.some((q) => pip(p, q.ring))) continue;
    let ok = true;
    for (const e of edges) { const d = segDist(p, e.a, e.b); if (d < (e.road ? sbRoad : sbNb)) { ok = false; break; } }
    if (!ok) continue;
    let ref = null; // {y, parcel, via}
    if (sun) {
      const hit = northHit(p, edges);
      if (hit && !hit.e.road) ref = { y: p[1] + hit.d, parcel: S.parcels.find((q) => pip([p[0], p[1] + hit.d + 0.5], q.ring)) || null, via: 'direct' };
      else if (hit && hit.e.road && sunRoad) {
        const key = i + ':' + edges.indexOf(hit.e);
        if (!refCache.has(key)) refCache.set(key, marchNorth(p[0], p[1] + hit.d + 0.05));
        const r = refCache.get(key);
        if (r) ref = { ...r, via: 'across' };
      }
    }
    pending.push({ i, j, p, ref });
  }
  // 정북 인접 대지의 용도지역 확인 (전용·일반주거가 아니면 제86조②3 적용 제외)
  const refParcels = [...new Set(pending.map((c) => c.ref && c.ref.parcel).filter(Boolean))];
  if (!S.demo) {
    for (const rp of refParcels) {
      if (rp.zoneName !== undefined) continue;
      try { const ip = interiorPoint(rp.ring); const z = await vwPoint('LT_C_UQ111', ip[0], ip[1]); rp.zoneName = z.length ? z[0].uname : null; }
      catch (e) { rp.zoneName = null; }
    }
  }
  const resid = (z) => !z || /전용주거|일반주거/.test(z); // 모르면 적용(보수적)
  const refPts = [];
  for (const c of pending) {
    evaluated++;
    let H = hMax;
    if (c.ref && resid(c.ref.parcel && c.ref.parcel.zoneName)) {
      const d = c.ref.y - c.p[1];
      // 2026.11 시행: ≤10m 1.5m(조례) / 10~17m 5m(조례) / 17m 초과 H/2. 종전: 10m 초과 H/2
      const Hs = d < sunD ? 0 : sunNew ? (d < sunD2 ? 10 : Math.max(17, 2 * d)) : Math.max(10, 2 * d);
      if (Hs < H) { H = Hs; sunLimited++; }
      refPts.push([c.p[0], c.ref.y]);
    }
    const g = elev(c.p[0], c.p[1]);
    const floors = Math.max(0, Math.floor((G0 + H - g) / fh + 1e-6));
    if (floors > 0) cells.push({ i: c.i, j: c.j, x: c.p[0], y: c.p[1], g, floors });
  }
  const refSummary = refParcels.map((rp) => `${(rp.props && rp.props.jibun) || '필지'}(${rp.zoneName || '용도 미확인'}${resid(rp.zoneName) ? '' : ' → 적용 제외'})`);
  const cellA = cs * cs;
  const envGFA = cells.reduce((a, c) => a + c.floors * cellA, 0);
  const envFoot = cells.length * cellA;
  const maxF = Math.max(0, ...cells.map((c) => c.floors));
  const farFloors = bcr > 0 ? far / bcr : 0; // 건폐율을 꽉 채웠을 때 필요한 층수
  const uniqRef = []; refPts.forEach((q) => { if (uniqRef.every((u) => Math.abs(u[0] - q[0]) > 0.4 || Math.abs(u[1] - q[1]) > 0.4)) uniqRef.push(q); });
  S.env = { cs, X0, Y0, nx, ny, cells, G0, fh, farFloors, edges, refPts: uniqRef };
  drawEnvelope();
  const farGFA = (area * far) / 100, bcrA = (area * bcr) / 100;
  const govern = envGFA >= farGFA ? `용적률이 규모를 결정 (볼륨 안에 여유 ${(envGFA - farGFA).toFixed(0)}㎡)` : `사선·높이 볼륨이 규모를 결정 (용적률 ${((envGFA / area) * 100).toFixed(0)}%까지만 가능)`;
  $('envInfo').innerHTML = `
    대지면적 ${area.toFixed(0)}㎡ · 높이 기준면 +${G0.toFixed(1)}m (경계 평균 지반)<br>
    <b>최대 건축면적</b> ${bcrA.toFixed(0)}㎡ (건폐율 ${bcr}%) · 볼륨 바닥 ${envFoot.toFixed(0)}㎡<br>
    <b>최대 연면적</b> ${farGFA.toFixed(0)}㎡ (용적률 ${far}%)<br>
    <b>볼륨이 담는 연면적</b> ${envGFA.toFixed(0)}㎡ · 최고 ${maxF}층<br>
    <b>→ ${govern}</b><br>
    건폐율을 꽉 채우면 평균 ${(farGFA / bcrA).toFixed(1)}개 층 · 정북일조로 낮아진 칸 ${((sunLimited / Math.max(1, evaluated)) * 100).toFixed(0)}%<br>
    ${sun ? `정북 일조 기준: ${sunNew ? `2026.11 개정 (≤10m ${sunD}m · 10~17m ${sunD2}m · 17m 초과 H/2)` : `종전 (≤10m ${sunD}m · 10m 초과 H/2)`}<br>정북 기준선: ${sunRoad ? '도로·철도 건너편 대지경계선 (시행령 86조⑥)' : '대지에 바로 맞닿은 인접대지만'}${refSummary.length ? '<br>기준 대지: ' + refSummary.slice(0, 6).join(', ') + (refSummary.length > 6 ? ` 외 ${refSummary.length - 6}` : '') : ''}<br>` : ''}
    ${hIn > 0 ? '' : '<span class="warn">최고높이 미입력 → 볼륨은 30m까지만 표시 (실제 제한 아님)</span><br>'}<span class="dim">0.5m 격자 근사 · 층고 ${fh}m · 지표면은 경계 평균으로 단순화 (고저차 3m 초과 시 구간별 산정은 미반영)</span>`;
}
function drawEnvelope() {
  if (S.envGroup) groupCtx.remove(S.envGroup);
  const E = S.env;
  if (!E || !$('envShow').checked) return;
  const grp = new THREE.Group();
  // 법적 최대 볼륨: 겉면만 있는 한 겹짜리 옅은 면 (내부 면이 겹쳐 진해지지 않게)
  const F = new Map(); E.cells.forEach((c) => F.set(c.i + ',' + c.j, c));
  const P = [];
  const quad = (a, b, c, d) => P.push(...a, ...b, ...c, ...a, ...c, ...d);
  E.cells.forEach((c) => {
    const x0 = E.X0 + c.i * E.cs, y0 = E.Y0 + c.j * E.cs, x1 = x0 + E.cs, y1 = y0 + E.cs, z = c.g + c.floors * E.fh;
    quad([x0, z, -y0], [x1, z, -y0], [x1, z, -y1], [x0, z, -y1]);
    [[0, -1, x0, y0, x1, y0], [0, 1, x0, y1, x1, y1], [-1, 0, x0, y0, x0, y1], [1, 0, x1, y0, x1, y1]].forEach(([di, dj, ax, ay, bx, by]) => {
      const q = F.get(c.i + di + ',' + (c.j + dj));
      const zb = q ? q.g + q.floors * E.fh : c.g;
      if (zb < z) quad([ax, zb, -ay], [bx, zb, -by], [bx, z, -by], [ax, z, -ay]);
    });
  });
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  grp.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide })));
  // 윤곽: 꼭대기 외곽 + 높이가 바뀌는 단 + 모서리 세로선
  const arr = [];
  envTopOutline().forEach(([x0, y0, z0, x1, y1, z1]) => arr.push(x0, z0, -y0, x1, z1, -y1));
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  grp.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2b55b8, transparent: true, opacity: 0.8 })));
  // 용적률 한계 높이: 건폐율을 꽉 채웠을 때 필요한 층수 위치에 빨간 점선 링
  if (E.farFloors > 0) {
    const z = E.G0 + E.farFloors * E.fh;
    const pts = [];
    E.edges.forEach((e) => pts.push(new THREE.Vector3(e.a[0], z, -e.a[1]), new THREE.Vector3(e.b[0], z, -e.b[1])));
    const lg = new THREE.BufferGeometry().setFromPoints(pts);
    const ln = new THREE.LineSegments(lg, new THREE.LineDashedMaterial({ color: 0xd94f3d, dashSize: 1.2, gapSize: 0.8 }));
    ln.computeLineDistances();
    grp.add(ln);
    const lab = textSprite(`용적률 ${$('zFar').value}% ≈ ${E.farFloors.toFixed(1)}층`, '#c0392b');
    const e0 = E.edges[0];
    lab.position.set(e0.a[0], z + 4, -e0.a[1]);
    grp.add(lab);
  }
  if (E.refPts && E.refPts.length) {
    const rp = E.refPts.map(([x, y]) => new THREE.Vector3(x, elev(x, y) + 0.4, -y));
    grp.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(rp), new THREE.PointsMaterial({ color: 0xe67e22, size: 1.6 })));
    const top = E.refPts.reduce((a, b) => (b[1] > a[1] ? b : a));
    const lb = textSprite('정북 기준선', '#d35400');
    lb.position.set(top[0], elev(top[0], top[1]) + 6, -top[1]);
    grp.add(lb);
  }
  S.envGroup = grp;
  groupCtx.add(grp);
}
// 꼭대기 윤곽선 [x0,y0,z0,x1,y1,z1]: 윗면 가장자리(이웃이 더 낮거나 없음) + 외곽을 따라 6m마다 세로선
function envTopOutline() {
  const E = S.env; if (!E) return [];
  const F = new Map(); E.cells.forEach((c) => F.set(c.i + ',' + c.j, c));
  const segs = [], vcand = [];
  E.cells.forEach((c) => {
    const x0 = E.X0 + c.i * E.cs, y0 = E.Y0 + c.j * E.cs, x1 = x0 + E.cs, y1 = y0 + E.cs, z = c.g + c.floors * E.fh;
    [[0, -1, x0, y0, x1, y0], [0, 1, x0, y1, x1, y1], [-1, 0, x0, y0, x0, y1], [1, 0, x1, y0, x1, y1]].forEach(([di, dj, a, b, cc, d]) => {
      const q = F.get(c.i + di + ',' + (c.j + dj));
      if (!q || q.floors < c.floors) segs.push([a, b, z, cc, d, z]);
      if (!q) vcand.push([a, b, c.g, z]);
    });
  });
  const picked = [];
  vcand.forEach((v) => { if (picked.every((p) => Math.hypot(v[0] - p[0], v[1] - p[1]) > 8)) picked.push(v); });
  picked.forEach(([x, y, g, z]) => segs.push([x, y, g, x, y, z]));
  return segs;
}

// 층 k(1..)의 외곽: floors≥k 인 셀과 아닌 셀 사이의 격자선. z = 셀 지반 + k·층고 (층 상단)
function envOutlines() {
  const E = S.env; if (!E) return [];
  const F = new Map(); E.cells.forEach((c) => F.set(c.i + ',' + c.j, c));
  const segs = [];
  const maxF = Math.max(0, ...E.cells.map((c) => c.floors));
  for (let k = 1; k <= maxF; k++) {
    E.cells.forEach((c) => {
      if (c.floors < k) return;
      const x0 = E.X0 + c.i * E.cs, y0 = E.Y0 + c.j * E.cs, x1 = x0 + E.cs, y1 = y0 + E.cs, z = c.g + k * E.fh;
      const nb = (di, dj) => { const q = F.get(c.i + di + ',' + (c.j + dj)); return q && q.floors >= k; };
      if (!nb(0, -1)) segs.push([x0, y0, x1, y0, z, k]);
      if (!nb(0, 1)) segs.push([x0, y1, x1, y1, z, k]);
      if (!nb(-1, 0)) segs.push([x0, y0, x0, y1, z, k]);
      if (!nb(1, 0)) segs.push([x1, y0, x1, y1, z, k]);
    });
  }
  return segs;
}

// ================= 규모검토 (층별 바닥판) =================
const CS = 100; // Clipper 정수 좌표 배율 (cm)
const toP = (ring) => ring.map(([x, y]) => ({ X: Math.round(x * CS), Y: Math.round(y * CS) }));
const fromP = (path) => path.map((q) => [q.X / CS, q.Y / CS]);
function clip(a, b, type) {
  const c = new ClipperLib.Clipper(), out = new ClipperLib.Paths();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  if (b) c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}
const uni = (a) => clip(a, null, ClipperLib.ClipType.ctUnion);
const inter = (a, b) => clip(a, b, ClipperLib.ClipType.ctIntersection);
const diff = (a, b) => clip(a, b, ClipperLib.ClipType.ctDifference);
function offs(paths, d, open) {
  const o = new ClipperLib.ClipperOffset(2, 25), out = new ClipperLib.Paths();
  o.AddPaths(paths, ClipperLib.JoinType.jtMiter, open ? ClipperLib.EndType.etOpenButt : ClipperLib.EndType.etClosedPolygon);
  o.Execute(out, d * CS);
  return out;
}
const pArea = (paths) => paths.reduce((a, q) => a + ClipperLib.Clipper.Area(q), 0) / (CS * CS);
function cleanPaths(paths) { return ClipperLib.Clipper.CleanPolygons(paths, 0.05 * CS).filter((q) => Math.abs(ClipperLib.Clipper.Area(q)) > 0.5 * CS * CS); }
// 원하는 면적 이하가 되도록 균일하게 안으로 줄이기
function shrinkTo(paths, target) {
  if (pArea(paths) <= target) return paths;
  let lo = 0, hi = 30, best = [];
  for (let k = 0; k < 22; k++) {
    const m = (lo + hi) / 2, r = cleanPaths(offs(paths, -m));
    if (pArea(r) > target) lo = m; else { hi = m; best = r; }
  }
  return best;
}
function pathsToShapes(paths) {
  const outers = [], holes = [];
  paths.forEach((q) => (ClipperLib.Clipper.Area(q) > 0 ? outers : holes).push(fromP(q)));
  const shapes = outers.map((r) => ({ ring: r, holes: [] }));
  holes.forEach((h) => { const sh = shapes.find((s) => pip(h[0], s.ring)); if (sh) sh.holes.push(h); });
  return shapes.map(({ ring, holes }) => {
    const s = shapeFrom(ring);
    holes.forEach((h) => s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y)))));
    return s;
  });
}

// 대지 x 0.5m 간격마다: 가장 북쪽 외곽 경계 → (도로·철도면 건너편까지) 정북 기준 대지경계
function refColumns(edges, sunRoad) {
  const xs = S.siteParcels.flatMap((p) => p.ring.map((q) => q[0]));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const cols = [];
  for (let x = xmin + 0.01; x <= xmax; x += 0.5) {
    let top = null;
    edges.forEach((e) => {
      const [x0, y0] = e.a, [x1, y1] = e.b;
      if ((x0 - x) * (x1 - x) > 0 || x0 === x1) return;
      const y = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      if (!top || y > top.y) top = { y, e };
    });
    if (!top) continue;
    let ref = null;
    if (!top.e.road) ref = { y: top.y, parcel: S.parcels.find((q) => pip([x, top.y + 0.5], q.ring)) || null };
    else if (sunRoad) ref = marchNorth(x, top.y + 0.05);
    cols.push({ x, ref });
  }
  return cols;
}
// 필지 용도지역 조회 (수집기에서만 네트워크 사용, 결과는 프로젝트 파일에 저장)
async function ensureZones(list) {
  if (S.demo || STUDIO) return;
  for (const rp of [...new Set(list.filter(Boolean))]) {
    if (rp.zoneName !== undefined) continue;
    try { const ip = interiorPoint(rp.ring); const z = await vwPoint('LT_C_UQ111', ip[0], ip[1]); rp.zoneName = z.length ? z[0].uname : null; } catch (e) { rp.zoneName = null; }
  }
}

async function scaleStudy() {
  if (!S.siteParcels.length) return;
  const bcr = parseFloat($('zBcr').value) || 0, far = parseFloat($('zFar').value) || 0;
  const hIn = parseFloat($('zHmax').value), hMax = hIn > 0 ? hIn : Infinity;
  const sbRoad = parseFloat($('zSbRoad').value) || 0, sbNb = parseFloat($('zSbNb').value) || 0;
  const sun = $('zSun').checked, sunRoad = $('zSunRoad').checked, sunNew = $('zSunRule').value === 'new';
  const sunD = Math.max(1.5, parseFloat($('zSunD').value) || 1.5), sunD2 = Math.max(5, parseFloat($('zSunD2').value) || 5);
  const fh = S.floorH;
  const area = S.siteParcels.reduce((a, p) => a + Math.abs(polyArea(p.ring)), 0);
  const bcrA = (area * bcr) / 100, farGFA = (area * far) / 100;
  // 1) 대지 외곽 (필지 합치기) — 미세한 틈은 닫고
  const site = cleanPaths(offs(offs(uni(S.siteParcels.map((p) => toP(p.ring))), 0.05), -0.05));
  const edges = siteExteriorEdges();
  const bpts = edges.map((e) => [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]);
  const G0 = bpts.reduce((a, [x, y]) => a + elev(x, y), 0) / Math.max(1, bpts.length);
  // 2) 이격: 경계 조각마다 도로/인접대지 거리만큼 띠를 만들어 빼기
  let buildable = site;
  const bands = [];
  edges.forEach((e) => { const d = e.road ? sbRoad : sbNb; if (d > 0) bands.push(...offs([toP([e.a, e.b])], d, true)); });
  if (bands.length) buildable = cleanPaths(diff(site, uni(bands)));
  // 3) 정북 기준선: x 0.5m 간격으로, 대지 가장 북쪽 경계 → (도로면 건너편까지) 인접 대지경계
  const xs = S.siteParcels.flatMap((p) => p.ring.map((q) => q[0]));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const cols = refColumns(edges, sunRoad);
  await ensureZones(cols.map((c) => c.ref && c.ref.parcel));
  const resid = (z) => !z || /전용주거|일반주거/.test(z);
  cols.forEach((c) => { c.refY = sun && c.ref && resid(c.ref.parcel && c.ref.parcel.zoneName) ? c.ref.y : Infinity; });
  const req = (h) => (h <= 10 ? sunD : sunNew ? (h <= 17 ? sunD2 : h / 2) : h / 2);
  const BIG = 1e4;
  function sunRegion(h) { // 높이 h(기준면 위)인 부분이 놓일 수 있는 영역
    if (!sun || cols.every((c) => c.refY === Infinity)) return null;
    const d = req(h), pts = [[xmin - 5, -BIG]];
    cols.forEach((c) => pts.push([c.x, c.refY === Infinity ? BIG : c.refY - d]));
    pts.push([xmax + 5, pts[pts.length - 1][1]], [xmax + 5, -BIG]);
    pts.splice(1, 0, [xmin - 5, pts[1][1]]);
    return [toP(pts)];
  }
  const limit = (paths, h) => { const r = sunRegion(h); return r ? cleanPaths(inter(paths, r)) : paths; };
  // 4~5) 층 쌓기: 1층 가능 영역에서 시작, 정북사선·최고높이·규칙(관통 동선) 반영, 용적률 한도까지.
  //      건축면적(전 층 수평투영) ≤ 건폐율이 되도록 외곽을 균일하게 줄이는 값을 이분탐색
  const avail1 = limit(buildable, fh);
  const P = S.rule && S.rule.path;
  function cutPath(plate, k) {
    if (!P) return plate;
    if (P.cover === 'open') return cleanPaths(diff(plate, P.corridor));
    const base = k === 1 ? -Infinity : G0 + (k - 1) * fh;
    const hit = P.slices.filter((sl) => base < sl.zmax + P.clear);
    return hit.length ? cleanPaths(diff(plate, hit.map((sl) => sl.poly))) : plate;
  }
  function stack(foot) {
    const out = [];
    let sum = 0;
    for (let k = 1; k <= 80; k++) {
      const top = k * fh;
      if (top > hMax + 1e-6) break;
      let plate = cutPath(k === 1 ? foot : limit(foot, top), k);
      let a = pArea(plate);
      if (a < 10) { if (k === 1) continue; break; }
      const remain = farGFA - sum;
      let partial = false;
      if (a > remain) {
        if (remain < Math.max(20, a * 0.15)) break;
        plate = shrinkTo(plate, remain); a = pArea(plate); partial = true;
      }
      out.push({ k, top, plate, area: a, partial });
      sum += a;
      if (partial) break;
    }
    return out;
  }
  const projA = (fl) => (fl.length ? pArea(cleanPaths(uni(fl.flatMap((f) => f.plate)))) : 0);
  let foot = avail1, floors = stack(foot);
  if (projA(floors) > bcrA) {
    let lo = 0, hi = 30;
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) / 2, f = cleanPaths(offs(avail1, -m)), fl = stack(f);
      if (projA(fl) > bcrA) lo = m; else { hi = m; foot = f; floors = fl; }
    }
  }
  const footA = projA(floors);
  const gfa = floors.reduce((a, f) => a + f.area, 0);
  S.mass = { G0, fh, floors, buildable, foot, site };
  drawMass();
  const maxH = floors.length ? floors[floors.length - 1].top : 0;
  const govern = gfa >= farGFA - 1 ? '용적률' : floors.length && floors[floors.length - 1].top + fh > hMax ? '최고높이' : '정북일조사선·이격';
  $('massInfo').innerHTML = `
    <table class="tbl"><tr><th>층</th><th>바닥면적</th><th>누계</th></tr>
    ${floors.slice().reverse().map((f) => `<tr${f.partial ? ' class="part"' : ''}><td>${f.k}F</td><td>${f.area.toFixed(1)}㎡</td><td>${floors.filter((g) => g.k <= f.k).reduce((a, g) => a + g.area, 0).toFixed(1)}</td></tr>`).join('')}
    </table>
    <table class="tbl sum">
      <tr><td>대지면적</td><td>${area.toFixed(1)}㎡</td></tr>
      <tr><td>건축면적</td><td>${footA.toFixed(1)}㎡ <span class="dim">(한도 ${bcrA.toFixed(1)})</span></td></tr>
      <tr><td>건폐율</td><td><b>${((footA / area) * 100).toFixed(2)}%</b> <span class="dim">/ ${bcr}%</span></td></tr>
      <tr><td>연면적(지상)</td><td>${gfa.toFixed(1)}㎡ <span class="dim">(한도 ${farGFA.toFixed(1)})</span></td></tr>
      <tr><td>용적률</td><td><b>${((gfa / area) * 100).toFixed(2)}%</b> <span class="dim">/ ${far}%</span></td></tr>
      <tr><td>규모</td><td>지상 ${floors.length}층 · 높이 ${maxH.toFixed(1)}m</td></tr>
      <tr><td>규모 결정</td><td><b>${govern}</b></td></tr>
      ${P ? `<tr><td>관통 동선</td><td>${P.label}</td></tr>` : ''}
    </table>
    <span class="dim">층고 ${fh}m · 높이 기준면 +${G0.toFixed(1)}m(경계 평균 지반) · 건축면적 = 전 층 수평투영 · 건폐율 초과분은 외곽을 균일하게 줄여 맞춤 · 최상층은 남은 용적률만큼 축소</span>`;
}
function drawMass() {
  if (S.massGroup) groupCtx.remove(S.massGroup);
  const M = S.mass;
  if (!M || !$('massShow').checked) return;
  const grp = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0xf4f1ea });
  const matTop = new THREE.MeshLambertMaterial({ color: 0xf7d9a8 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x222222 });
  M.floors.forEach((f) => {
    const base = f.k === 1 ? Math.min(M.G0, ...fromP(M.foot.flat ? M.foot[0] : M.foot).map(([x, y]) => elev(x, y))) : M.G0 + (f.k - 1) * M.fh;
    const topZ = M.G0 + f.top;
    pathsToShapes(f.plate).forEach((sh) => {
      const g = new THREE.ExtrudeGeometry(sh, { depth: topZ - base - 0.12, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, f.partial ? matTop : mat);
      m.position.y = base; m.castShadow = m.receiveShadow = true;
      grp.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), edgeMat);
      e.position.y = base; grp.add(e);
    });
    const lab = textSprite(`${f.k}F ${f.area.toFixed(0)}㎡`, '#333');
    const c = fromP(f.plate[0])[0];
    lab.scale.multiplyScalar(0.55);
    lab.position.set(c[0], topZ - M.fh / 2, -c[1]);
    grp.add(lab);
  });
  // 관통 동선(슬로프) 표면
  const P = S.rule && S.rule.path;
  if (P) {
    const pos = [];
    const at = (t, side) => { const x = P.p[0] + P.ux * P.L * t + P.nx * side * P.w / 2, y = P.p[1] + P.uy * P.L * t + P.ny * side * P.w / 2; return [x, P.zs + (P.ze - P.zs) * t + 0.12, -y]; };
    for (let i = 0; i < 40; i++) { const t0 = i / 40, t1 = (i + 1) / 40; const a = at(t0, -1), b = at(t0, 1), c = at(t1, 1), d = at(t1, -1); pos.push(...a, ...b, ...c, ...a, ...c, ...d); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.computeVertexNormals();
    grp.add(new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ color: 0xc0392b, side: THREE.DoubleSide })));
    const lb = textSprite(P.label, '#c0392b'); lb.scale.multiplyScalar(0.6);
    const m = at(0.5, 0); lb.position.set(m[0], m[1] + 3, m[2]); grp.add(lb);
  }
  // 건축 가능 영역(이격 반영) 바닥선
  M.buildable.forEach((q) => {
    const r = fromP(q); r.push(r[0]);
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(r.map(([x, y]) => new THREE.Vector3(x, elev(x, y) + 0.35, -y))), new THREE.LineDashedMaterial({ color: 0x1e8449, dashSize: 0.8, gapSize: 0.5 }));
    ln.computeLineDistances(); grp.add(ln);
  });
  S.massGroup = grp;
  groupCtx.add(grp);
}

// ================= 3단계: 프로젝트 규칙 =================
// 도구가 계산할 수 있는 규칙 유형 (새 유형은 여기에 추가)
const RULE_TYPES = {
  through_path: {
    name: '관통 동선',
    desc: '서로 다른 두 도로(또는 철도부지 등 선형 공간)를 대지를 가로지르는 꺾이지 않는 직선 길(슬로프/통로)로 잇는다. 길은 건물 매스를 뚫고 지나간다.',
    params: {
      from: { label: '시작하는 길', kind: 'road' },
      to: { label: '끝나는 길', kind: 'road' },
      width: { label: '길 폭', unit: 'm', default: 6, options: [4, 6, 8, 10] },
      cover: { label: '뚫는 방식', default: 'covered', options: ['open', 'covered'], optionLabels: { open: '하늘로 열린 길 (매스를 둘로 가름)', covered: '매스 아래 통로 (위층은 길 위를 덮음)' } },
      clear: { label: '통로 유효높이', unit: 'm', default: 4.5, options: [3.3, 4.5, 6.6], onlyIf: 'cover=covered' },
      maxSlope: { label: '최대 경사', unit: '%', default: 8.33, options: [5.56, 8.33, 12.5], optionLabels: { 5.56: '1/18 (완만)', 8.33: '1/12 (무장애 기준)', 12.5: '1/8 (가파름)' } },
      position: { label: '위치', default: 'center', options: ['center', 'gentle'], optionLabels: { center: '대지를 고르게 가르는 한가운데', gentle: '경사가 가장 완만한 곳' } },
    },
  },
};
S.rule = { text: '', type: null, params: {}, questions: [], alts: [], sel: -1, path: null };

function siteSummaryForAI() {
  const roads = (S.roads || []).map((r) => ({ name: r.name, side: r.dir + '측', kind: r.kind, frontage_m: +r.len.toFixed(0), avg_height_m: +r.avg.toFixed(1), range_m: [+r.lo.toFixed(1), +r.hi.toFixed(1)], slope_pct: +r.slope.toFixed(1) }));
  const area = S.siteParcels.reduce((a, p) => a + Math.abs(polyArea(p.ring)), 0);
  return { address: (S.project && S.project.address) || '', site_area_m2: Math.round(area), zone: S.zone || $('zSel').value || null,
    bcr_pct: +$('zBcr').value, far_pct: +$('zFar').value, floor_height_m: S.floorH,
    heights_note: '높이는 대지 최저점 기준(m)', adjacent_linear_spaces: roads };
}
function ruleSchemaForAI() {
  return Object.fromEntries(Object.entries(RULE_TYPES).map(([k, t]) => [k, { name: t.name, description: t.desc,
    params: Object.fromEntries(Object.entries(t.params).map(([pk, pv]) => [pk, { label: pv.label, unit: pv.unit, options: pv.kind === 'road' ? (S.roads || []).map((r) => r.name) : pv.options, option_labels: pv.optionLabels, default: pv.default, only_if: pv.onlyIf }])) }]));
}
async function interpretRule() {
  const text = $('ruleText').value.trim();
  if (!text) return;
  if (!S.roads || !S.roads.length) { $('ruleBox').innerHTML = '<span class="err">먼저 프로젝트 파일을 불러오세요 (접도 분석이 필요해요).</span>'; return; }
  const sample = window.claude && (await window.claude.use('sample'));
  if (!sample) { $('ruleBox').innerHTML = '<span class="err">이 화면에서는 Claude를 쓸 수 없어요.</span>'; return; }
  $('ruleBox').innerHTML = '<span class="dim">Claude가 규칙을 읽는 중… (처음엔 사용 허락 창이 떠요)</span>';
  const prompt = `너는 건축 설계 도구의 "규칙 번역기"다. 설계자가 쓴 프로젝트 규칙 문장을, 도구가 계산할 수 있는 규칙 유형과 파라미터로 옮긴다.

[대지 정보]
${JSON.stringify(siteSummaryForAI(), null, 1)}

[도구가 계산할 수 있는 규칙 유형]
${JSON.stringify(ruleSchemaForAI(), null, 1)}

[설계자의 규칙 문장]
"${text}"

할 일:
1. 문장이 어느 규칙 유형인지 고른다. 맞는 유형이 없으면 type을 null로 하고 unsupported_reason에 어떤 새 유형이 필요한지 한국어로 쓴다.
2. 문장에서 분명히 알 수 있는 파라미터만 params에 채운다. 추측하지 않는다. 길은 adjacent_linear_spaces의 name 값(도로명 등)을 그대로 쓴다.
3. 설계 의도에 해당하는데 문장에 없는 파라미터는 questions로 묻는다. 대지 정보를 활용해 선택지를 구체적으로 만든다 (예: "와우산로32길 · 북동측 · 평균 +1.1m"). 길의 정확한 위치처럼 도구가 여러 대안으로 펼쳐 보여줄 수 있는 것은 묻지 않는다. 질문은 최대 4개, 중요한 순서로.
4. understood에 규칙을 도구 입장에서 한 문장으로 다시 쓴다.

JSON 하나만 답한다. 형식:
{"type":"through_path","understood":"...","params":{"cover":"covered"},"questions":[{"param":"from","question":"...","options":[{"value":"A","label":"..."}],"why":"..."}],"unsupported_reason":null}`;
  try {
    const r = await sample.json(prompt, { modelTier: 'default' });
    if (!r || typeof r !== 'object') throw { message: '해석 결과가 비었어요' };
    S.rule = { text, type: r.type && RULE_TYPES[r.type] ? r.type : null, params: r.params || {}, questions: Array.isArray(r.questions) ? r.questions : [], understood: r.understood || '', unsupported: r.unsupported_reason, alts: [], sel: -1, path: null };
    renderRule();
  } catch (e) {
    $('ruleBox').innerHTML = `<span class="err">${e.code === 'not_granted' ? 'Claude 사용이 허락되지 않았어요.' : e.code === 'rate_limited' ? '잠시 후 다시 시도해 주세요.' : '해석 실패: ' + (e.message || e.code)}</span>`;
  }
}
function paramLabel(type, k, v) {
  const d = RULE_TYPES[type].params[k];
  if (d.kind === 'road') { const r = (S.roads || []).find((x) => x.name === v); return r ? `${r.name} ${r.dir}측 ${r.kind} (${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(1)}m)` : v; }
  return (d.optionLabels && d.optionLabels[v]) || `${v}${d.unit || ''}`;
}
function renderRule() {
  const R = S.rule, box = $('ruleBox');
  if (!R.type) { box.innerHTML = `<div class="card"><b>아직 계산할 수 없는 규칙이에요.</b><br>${R.unsupported || ''}<br><span class="dim">이런 규칙은 새 유형으로 추가해야 해요. Claude에게 이 문장을 전해 주세요.</span></div>`; return; }
  const T = RULE_TYPES[R.type];
  const open = R.questions.filter((q) => R.params[q.param] === undefined && T.params[q.param]);
  let html = `<div class="card"><b>${T.name}</b> — ${R.understood}<br>`;
  html += Object.entries(R.params).filter(([k]) => T.params[k]).map(([k, v]) => `<span class="chip">${T.params[k].label}: ${paramLabel(R.type, k, v)}</span>`).join(' ');
  html += '</div>';
  open.forEach((q, qi) => {
    html += `<div class="card q"><b>${q.question}</b>${q.why ? `<br><span class="dim">${q.why}</span>` : ''}<div>`;
    (q.options || []).forEach((o, oi) => { html += `<button data-q="${qi}" data-o="${oi}">${o.label || o.value}</button>`; });
    html += `<input data-qin="${qi}" placeholder="직접 입력" style="width:90px"></div></div>`;
  });
  if (!open.length) html += `<button id="btnAlts" class="primary">대안 생성</button>`;
  box.innerHTML = html;
  box.querySelectorAll('button[data-q]').forEach((b) => (b.onclick = () => { const q = open[+b.dataset.q]; R.params[q.param] = q.options[+b.dataset.o].value; renderRule(); }));
  box.querySelectorAll('input[data-qin]').forEach((inp) => (inp.onchange = () => { const q = open[+inp.dataset.qin]; const v = inp.value.trim(); if (v) { R.params[q.param] = isNaN(+v) ? v : +v; renderRule(); } }));
  const ba = $('btnAlts'); if (ba) ba.onclick = () => { genAlts(); };
}
function fullParams() {
  const R = S.rule, T = RULE_TYPES[R.type], out = {};
  Object.entries(T.params).forEach(([k, d]) => { out[k] = R.params[k] !== undefined ? R.params[k] : d.default; });
  return out;
}
// 관통 동선 대안: 두 길의 접도점 쌍 중 직선이 대지를 지나고, 경사 한도 안이며, 위치 기준 점수가 높은 것
function genAlts() {
  const prm = fullParams();
  const rf = S.roads.find((r) => r.name === prm.from), rt = S.roads.find((r) => r.name === prm.to);
  if (!rf || !rt || rf === rt) { $('altBox').innerHTML = '<span class="err">서로 다른 두 길을 골라야 해요.</span>'; return; }
  const site = cleanPaths(offs(offs(uni(S.siteParcels.map((p) => toP(p.ring))), 0.05), -0.05));
  const siteA = pArea(site);
  const inSite = (x, y) => S.siteParcels.some((q) => pip([x, y], q.ring));
  const w = +prm.width, maxS = +prm.maxSlope;
  const cands = [];
  rf.pts.forEach((a) => rt.pts.forEach((b) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 10) return;
    const slope = (Math.abs(b.roadG - a.roadG) / L) * 100;
    if (slope > maxS) return;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, nx = -uy, ny = ux;
    let ok = 0, tot = 0;
    for (let t = 0.04; t < 0.96; t += 1 / L) for (const sd of [-0.5, 0, 0.5]) {
      tot++; if (inSite(a.x + ux * L * t + nx * sd * w, a.y + uy * L * t + ny * sd * w)) ok++;
    }
    if (ok / tot < 0.9) return;
    const half = [toP([[a.x - ux * 1e3, a.y - uy * 1e3], [b.x + ux * 1e3, b.y + uy * 1e3], [b.x + ux * 1e3 + nx * 1e3, b.y + uy * 1e3 + ny * 1e3], [a.x - ux * 1e3 + nx * 1e3, a.y - uy * 1e3 + ny * 1e3]])];
    const a1 = pArea(inter(site, half)), bal = Math.min(a1, siteA - a1) / Math.max(a1, siteA - a1);
    const score = prm.position === 'gentle' ? 1 - slope / maxS + 0.2 * bal : bal - 0.3 * (slope / maxS);
    cands.push({ a, b, L, slope, bal, score, ux, uy, nx, ny });
  }));
  cands.sort((x, y) => y.score - x.score);
  const alts = [];
  for (const c of cands) {
    if (alts.some((o) => Math.hypot(o.a.x - c.a.x, o.a.y - c.a.y) < 8 && Math.hypot(o.b.x - c.b.x, o.b.y - c.b.y) < 8)) continue;
    alts.push(c); if (alts.length >= 4) break;
  }
  S.rule.alts = alts; S.rule.sel = -1; S.rule.path = null;
  if (!alts.length) { $('altBox').innerHTML = `<div class="card"><b>조건을 만족하는 직선이 없어요.</b><br>최대 경사(${maxS}%)를 완화하거나 다른 두 길을 골라 보세요.</div>`; drawAlts(); return; }
  renderAlts(); drawAlts();
}
function renderAlts() {
  const R = S.rule;
  $('altBox').innerHTML = '<b>대안</b> <span class="dim">(고르면 규모검토가 다시 돼요)</span>' + R.alts.map((c, i) => `
    <div class="card alt${R.sel === i ? ' on' : ''}" data-i="${i}"><b>${'①②③④'[i]}</b> 길이 ${c.L.toFixed(0)}m · 경사 ${c.slope.toFixed(1)}% (1/${(100 / Math.max(c.slope, 0.01)).toFixed(0)}) · ${(c.a.roadG >= 0 ? '+' : '') + c.a.roadG.toFixed(1)} → ${(c.b.roadG >= 0 ? '+' : '') + c.b.roadG.toFixed(1)}m · 대지 분할 ${(c.bal * 100).toFixed(0)}%</div>`).join('') +
    (R.sel >= 0 ? '<button id="btnSaveRule">이 규칙과 대안 저장</button>' : '');
  $('altBox').querySelectorAll('.alt').forEach((el) => (el.onclick = () => selectAlt(+el.dataset.i)));
  const sb = $('btnSaveRule'); if (sb) sb.onclick = saveRule;
}
async function selectAlt(i) {
  const R = S.rule, c = R.alts[i], prm = fullParams();
  R.sel = i;
  const ext = 3, w = +prm.width;
  const A = [c.a.x - c.ux * ext, c.a.y - c.uy * ext], B = [c.b.x + c.ux * ext, c.b.y + c.uy * ext];
  const rect = (p0, p1) => [toP([[p0[0] + c.nx * w / 2, p0[1] + c.ny * w / 2], [p1[0] + c.nx * w / 2, p1[1] + c.ny * w / 2], [p1[0] - c.nx * w / 2, p1[1] - c.ny * w / 2], [p0[0] - c.nx * w / 2, p0[1] - c.ny * w / 2]])];
  const n = Math.ceil(c.L / 2), slices = [];
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    const p0 = [c.a.x + c.ux * c.L * t0, c.a.y + c.uy * c.L * t0], p1 = [c.a.x + c.ux * c.L * t1, c.a.y + c.uy * c.L * t1];
    const q0 = k === 0 ? A : p0, q1 = k === n - 1 ? B : p1;
    slices.push({ poly: rect(q0, q1)[0], zmax: Math.max(c.a.roadG + (c.b.roadG - c.a.roadG) * t0, c.a.roadG + (c.b.roadG - c.a.roadG) * t1) });
  }
  R.path = { p: [c.a.x, c.a.y], ux: c.ux, uy: c.uy, nx: c.nx, ny: c.ny, L: c.L, w, zs: c.a.roadG, ze: c.b.roadG, cover: prm.cover, clear: +prm.clear,
    corridor: rect(A, B), slices, label: `${prm.from}→${prm.to} 슬로프 ${c.slope.toFixed(1)}% · L${c.L.toFixed(0)}m · 폭 ${w}m · ${prm.cover === 'open' ? '하늘로 열림' : '통로 h' + prm.clear + 'm'}` };
  renderAlts(); drawAlts();
  $('massInfo').textContent = '계산 중…';
  try { await scaleStudy(); } catch (e) { $('massInfo').textContent = '오류: ' + e.message; }
}
function drawAlts() {
  if (S.altGroup) groupCtx.remove(S.altGroup);
  const R = S.rule; if (!R.alts.length) return;
  const g = new THREE.Group();
  R.alts.forEach((c, i) => {
    const on = R.sel === i;
    const pts = [new THREE.Vector3(c.a.x, c.a.roadG + 1, -c.a.y), new THREE.Vector3(c.b.x, c.b.roadG + 1, -c.b.y)];
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: on ? 0xc0392b : 0x7f8c8d, depthTest: false, transparent: true, opacity: on ? 1 : 0.7 })));
    const lb = textSprite('①②③④'[i], on ? '#c0392b' : '#555'); lb.scale.multiplyScalar(0.6);
    lb.position.set(c.a.x, c.a.roadG + 4, -c.a.y); g.add(lb);
  });
  S.altGroup = g; groupCtx.add(g);
}
async function saveRule() {
  const db = window.claude && (await window.claude.use('db'));
  const R = S.rule, c = R.alts[R.sel];
  const rec = { created: new Date().toISOString(), project: (S.project && S.project.address) || '', sentence: R.text, type: R.type, understood: R.understood,
    params: fullParams(), chosen: c ? { from_xy: [r2(c.a.x), r2(c.a.y)], to_xy: [r2(c.b.x), r2(c.b.y)], length_m: r2(c.L), slope_pct: r2(c.slope), start_h: r2(c.a.roadG), end_h: r2(c.b.roadG) } : null,
    result: S.mass ? { floors: S.mass.floors.length, gfa_m2: r2(S.mass.floors.reduce((a, f) => a + f.area, 0)) } : null };
  if (!db) { log('저장소를 쓸 수 없어요 (로그인 확인).', 'err'); return; }
  try { await db.collection('rules').doc('r' + Date.now()).set(rec); log('규칙을 저장했어요. Claude가 대화에서 읽을 수 있어요.', 'ok'); loadSavedRules(); }
  catch (e) { log('저장 실패: ' + (e.message || e.code), 'err'); }
}
async function loadSavedRules() {
  const db = window.claude && (await window.claude.use('db'));
  if (!db) return;
  try {
    const snap = await db.collection('rules').orderBy('created', 'desc').limit(10).get();
    const rows = (snap.docs || snap).map((d) => (d.data ? d.data() : d));
    $('savedRules').innerHTML = rows.length ? '<b>저장된 규칙</b>' + rows.map((r) => `<div class="card dim">${(r.created || '').slice(0, 10)} · ${r.sentence}<br>${r.understood || ''}</div>`).join('') : '';
  } catch (e) { /* 비어 있거나 권한 없음 */ }
}

// ---------- 내보내기 ----------
function dxf() {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC'];
  const layers = [['SITE', 1], ['PARCEL', 8], ['BLDG', 7], ['BLDG_ROOF', 9], ['ENVELOPE', 5], ['MASS', 3], ['BUILDABLE', 3]];
  out.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length));
  layers.forEach(([n, c]) => out.push('0', 'LAYER', '2', n, '70', '0', '62', String(c), '6', 'CONTINUOUS'));
  out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  const f = (v) => v.toFixed(3);
  const poly = (ring, layer, z, thick) => {
    out.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', f(z), '70', '1');
    if (thick) out.push('39', f(thick));
    ring.forEach(([x, y]) => out.push('0', 'VERTEX', '8', layer, '10', f(x), '20', f(y), '30', f(z)));
    out.push('0', 'SEQEND', '8', layer);
  };
  S.siteParcels.forEach((p) => poly(p.ring, 'SITE', p.ground));
  S.parcels.forEach((p) => poly(p.ring, 'PARCEL', p.ground));
  S.buildings.forEach((b) => {
    poly(b.ring, 'BLDG', b.ground, b.height);
    const r = polyArea(b.ring) < 0 ? b.ring.slice().reverse() : b.ring;
    const tris = THREE.ShapeUtils.triangulateShape(r.map(([x, y]) => new THREE.Vector2(x, y)), []);
    const z = b.ground + b.height;
    tris.forEach(([i, j, k]) => {
      const P = [r[i], r[j], r[k], r[k]];
      out.push('0', '3DFACE', '8', 'BLDG_ROOF');
      P.forEach(([x, y], n) => out.push(String(10 + n), f(x), String(20 + n), f(y), String(30 + n), f(z)));
    });
  });
  const o = S.origin;
  if (S.mass) {
    S.mass.floors.forEach((fl) => fl.plate.forEach((q) => poly(fromP(q), 'MASS', S.mass.G0 + (fl.k - 1) * S.mass.fh, S.mass.fh)));
    S.mass.buildable.forEach((q) => poly(fromP(q), 'BUILDABLE', S.mass.G0));
  }
  if (S.env && $('envShow').checked) envOutlines().forEach(([x0, y0, x1, y1, z]) => out.push('0', 'LINE', '8', 'ENVELOPE', '10', f(x0), '20', f(y0), '30', f(z), '11', f(x1), '21', f(y1), '31', f(z)));
  out.push('0', 'TEXT', '8', 'SITE', '10', '0', '20', '-5', '30', '0', '40', '1.5', '1', `ORIGIN lon ${o.lon.toFixed(7)} lat ${o.lat.toFixed(7)} (unit m)`);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n');
}
async function saveFile(name, data) {
  if (!STUDIO) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  const dl = window.claude && (await window.claude.use('downloads'));
  if (!dl) { log('이 화면에서는 파일 저장을 쓸 수 없어요.', 'err'); return; }
  let fname = name, payload = data;
  if (/\.dxf$/i.test(name)) { // 아티팩트는 .dxf 저장을 허용하지 않아 zip으로 감싼다
    payload = new Blob([zipSync({ [name]: strToU8(data) })]);
    fname = name.replace(/\.dxf$/i, '.zip');
  }
  try { await dl.save({ filename: fname, data: payload }); log(`${fname} 저장`, 'ok'); }
  catch (e) { if (e.code !== 'declined') log('저장 실패: ' + (e.message || e.code), 'err'); }
}
const r2 = (v) => Math.round(v * 100) / 100;
const ringOut = (r) => r.map(([x, y]) => [r2(x), r2(y)]);
async function exportProject() {
  // 정북 기준이 될 수 있는 대지의 용도지역을 미리 조회해 파일에 담는다
  const edges = siteExteriorEdges();
  const refs = [...refColumns(edges, true), ...refColumns(edges, false)].map((c) => c.ref && c.ref.parcel);
  log('정북 인접 대지 용도지역 조회 중…');
  await ensureZones(refs);
  let grid = null;
  if (T.ready && !T.grid) {
    const R = S.radius + 10, step = 2, n = Math.round((2 * R) / step) + 1, data = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) data.push(r2(elev(-R + i * step, -R + j * step)));
    grid = { x0: -R, y0: -R, step, nx: n, ny: n, data };
  } else if (T.grid) grid = { ...T.grid, data: Array.from(T.grid.data) };
  const keep = ['buld_nm', 'gro_flo_co', 'rd_nm', 'buld_no'];
  return JSON.stringify({
    version: 2, created: new Date().toISOString(), address: $('base').value + ' ' + $('jibuns').value,
    origin: S.origin, floorHeight: S.floorH, radius: S.radius, demo: S.demo,
    zone: S.zone || null, zoneInfo: $('zoneInfo').innerText,
    terrain: grid ? { base: T.base, grid } : null,
    roadLines: S.roadLines || [], roadNames: S.roadNames || {},
    site: S.siteParcels.map((p) => ({ id: p.id, jibun: p.jibun, ring: ringOut(p.ring), ground: r2(p.ground), pnu: p.props.pnu })),
    parcels: S.parcels.map((p) => ({ id: p.id, ring: ringOut(p.ring), ground: r2(p.ground), pnu: p.props.pnu, jibun: p.props.jibun, zoneName: p.zoneName })),
    buildings: S.buildings.map((b) => ({ id: b.id, ring: ringOut(b.ring), floors: b.floors, height: r2(b.height), heightSrc: b.heightSrc, ground: r2(b.ground), onSite: !!b.onSite,
      props: Object.fromEntries(keep.filter((k) => b.props && b.props[k] != null).map((k) => [k, b.props[k]])) })),
  });
}
function loadProject(text) {
  const d = JSON.parse(text);
  Object.assign(S, { origin: d.origin, floorH: d.floorHeight || 3.3, radius: d.radius, demo: !!d.demo, env: null, mass: null, sectionPts: [] });
  S.siteParcels = d.site.map((p) => ({ ...p, props: { pnu: p.pnu, jibun: p.jibun } }));
  S.parcels = d.parcels.map((p) => { const q = { ...p, props: { pnu: p.pnu, jibun: p.jibun } }; if (p.zoneName === undefined) delete q.zoneName; return q; });
  S.buildings = d.buildings;
  S.roadLines = d.roadLines || [];
  S.roadNames = d.roadNames || {};
  T.tiles = {}; T.grid = null; T.ready = false;
  if (d.terrain && d.terrain.grid) { T.grid = { ...d.terrain.grid, data: Float32Array.from(d.terrain.grid.data) }; T.base = d.terrain.base; T.ready = true; }
  S.zone = d.zone || null;
  if (S.zone && ZONES[S.zone]) { $('zSel').value = S.zone; applyZoneDefaults(); }
  $('zoneInfo').innerHTML = d.zoneInfo ? d.zoneInfo.replace(/\n/g, '<br>') : '용도지역 정보 없음 — 직접 고르세요.';
  $('floorH').value = S.floorH;
  S.project = { address: d.address || '', created: d.created || '' };
  S.rule = { text: '', type: null, params: {}, questions: [], alts: [], sel: -1, path: null }; $('ruleBox').innerHTML = ''; $('altBox').innerHTML = '';
  log(`프로젝트 불러옴: ${d.address || ''}${T.ready ? '' : ' (지형 없음)'}`, 'ok');
  buildScene(true);
  if (window.__onProjectLoaded) window.__onProjectLoaded(d, text);
}

// ---------- UI 연결 ----------
function init() {
  if (STUDIO) document.body.classList.add('studio');
  $('key').value = store.get('vw_key') || '';
  $('domain').value = store.get('vw_domain') || (location.origin + location.pathname.replace(/[^/]*$/, ''));
  initThree();
  $('btnLoad').onclick = () => loadVWorld().catch((e) => log(e.message, 'err'));
  $('btnDemo').onclick = loadDemo;
  $('btnTerrain').onclick = () => sampleTerrain();
  $('showContours').onchange = () => S.origin && buildScene(false);
  $('hideSiteBldg').onchange = () => S.origin && buildScene(false);
  $('roadLabels').onchange = () => S.origin && buildScene(false);
  $('secEx').onchange = () => S.sectionPts.length === 2 && drawSection();
  $('zSel').innerHTML = '<option value="">선택</option>' + Object.keys(ZONES).map((z) => `<option>${z}</option>`).join('');
  $('zSel').onchange = applyZoneDefaults;
  $('btnEnv').onclick = async () => {
    try { $('massInfo').textContent = '계산 중…'; await scaleStudy(); if ($('envShow').checked) await buildEnvelope(); else { S.env = null; drawEnvelope(); $('envInfo').textContent = ''; } }
    catch (e) { $('massInfo').textContent = '오류: ' + e.message; console.error(e); }
  };
  $('massShow').onchange = () => drawMass();
  $('envShow').onchange = async () => { if ($('envShow').checked) await buildEnvelope(); else drawEnvelope(); };
  $('secClose').onclick = () => { $('sectionBox').style.display = 'none'; };
  $('floorH').onchange = (e) => {
    S.floorH = parseFloat(e.target.value) || 3.3;
    S.buildings.forEach((b) => { if (b.heightSrc !== 'data') b.height = b.floors * S.floorH; });
    if (S.origin) buildScene(false);
  };
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('showLines').onchange = () => S.origin && S.mode === 'view' && runViewAnalysis();
  $('btnDxf').onclick = () => S.origin && saveFile('site-context.dxf', dxf());
  $('btnJson').onclick = async () => { if (!S.origin) return; const t = await exportProject(); saveFile('site-project.json', t); log('프로젝트 파일 내보냄 — 스튜디오에 끌어다 놓으세요.', 'ok'); };
  $('btnPng').onclick = () => renderer.domElement.toBlob((b) => b && saveFile('site-context.png', b));
  ['fileJson', 'fileJson2'].forEach((id) => { $(id).onchange = (e) => { const f = e.target.files[0]; if (f) f.text().then(loadProject).catch((er) => log('불러오기 실패: ' + er.message, 'err')); }; });
  setMode('height');
  if (STUDIO) {
    $('btnRule').onclick = () => interpretRule();
    loadSavedRules();
  }
  // 파일 끌어다 놓기
  const host = document.body;
  host.addEventListener('dragover', (e) => { e.preventDefault(); host.classList.add('drag'); });
  host.addEventListener('dragleave', () => host.classList.remove('drag'));
  host.addEventListener('drop', (e) => { e.preventDefault(); host.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) f.text().then(loadProject).catch((er) => log('불러오기 실패: ' + er.message, 'err')); });
  window.__S = S; // 디버그용
  window.__rules = { genAlts, selectAlt, renderRule, fullParams, exportProject };
  window.__app = { loadProject, scaleStudy, buildScene, saveFile, dxf, elev, analyzeRoads, siteExteriorEdges, ZONES, log, THREE, groupCtx: () => groupCtx, textSprite, pip, polyArea, centroid, densify, offs: null };
  window.__demo = loadDemo;
  window.__mode = setMode;
}
init();
