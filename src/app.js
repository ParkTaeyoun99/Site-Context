import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
  T.ready = false;
  buildScene(true);
  await sampleTerrain();
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
  T.ready = false;
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
  scene.background = new THREE.Color(0xf4f2ee);
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
  return [mk(minor, 0x8a7f6c, 0.35), mk(major, 0x5c513f, 0.8)];
}

function buildScene(resetCam) {
  groupCtx.clear(); groupLines.clear(); S.sectionPts = []; $('section').innerHTML = ''; S.groundMesh = null;
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
  S.buildings.forEach((b) => {
    const top = b.ground + b.height;
    const mat = new THREE.MeshLambertMaterial({ color: b.onSite ? 0x999999 : heightColor(top), transparent: b.onSite, opacity: b.onSite ? 0.35 : 1 });
    const m = prism(b.ring, b.height, b.ground, mat);
    m.userData = { kind: 'building', ref: b };
    b.mesh = m;
    groupCtx.add(m);
  });
  const n = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(S.radius * 0.85, (T.ready ? elev(S.radius * 0.85, S.radius * 0.6) : 0) + 3, -S.radius * 0.6), 30, 0x222222, 8, 5);
  groupCtx.add(n);
  if (S.mode === 'view') runViewAnalysis();
  updateStats();
  if (resetCam) { camera.position.set(S.radius * 1.1, S.radius * 1.3, S.radius * 1.3); controls.target.set(0, 0, 0); }
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
function runViewAnalysis() {
  groupLines.clear();
  const targets = sitePoints();
  const ctx = S.buildings.filter((b) => !b.onSite);
  const meshes = ctx.map((b) => b.mesh).concat(S.groundMesh ? [S.groundMesh] : []);
  const showLines = $('showLines').checked;
  const results = [];
  ctx.forEach((b) => {
    const c = centroid(b.ring);
    const eye = new THREE.Vector3(c[0], b.ground + b.height + 1.5, -c[1]);
    let vis = 0;
    targets.forEach((t) => {
      const dir = t.clone().sub(eye); const dist = dir.length(); dir.normalize();
      raycaster.set(eye, dir); raycaster.far = dist - 0.5;
      const hits = raycaster.intersectObjects(meshes, false).filter((h) => h.object !== b.mesh);
      if (!hits.length) {
        vis++;
        if (showLines && vis === 1) groupLines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([eye, t]), new THREE.LineBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.5 })));
      }
    });
    const ratio = vis / targets.length;
    const down = eye.y - siteGround();
    b.view = { ratio, down };
    const col = new THREE.Color();
    if (ratio === 0) col.set(0xd9d6d0); else col.setHSL(0.08, 0.9, 0.75 - 0.35 * ratio);
    b.mesh.material.color = col;
    if (ratio > 0) results.push(b);
  });
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
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], 0.5, -a[1]), new THREE.Vector3(b[0], 0.5, -b[1])]), new THREE.LineBasicMaterial({ color: 0x0044ff }));
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
    const bl = S.buildings.find((q) => pip(pt, q.ring));
    samples.push({ d: t * L, g: g ? g.g : null, site: g && g.site, top: bl ? bl.ground + bl.height : null, bg: bl ? bl.ground : null });
  }
  const gs = samples.filter((s) => s.g !== null).map((s) => s.g);
  const tops = samples.filter((s) => s.top !== null).map((s) => s.top);
  const ymin = Math.min(0, ...gs) - 2, ymax = Math.max(10, ...tops, ...gs) + 4;
  const W = 600, H = 220, sx = W / L, sy = Math.min((H - 20) / (ymax - ymin), sx * 1.0);
  const Y = (v) => H - 10 - (v - ymin) * sy;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
  // 건물
  let run = null;
  const flush = (end) => { if (run) { svg += `<rect x="${run.d0 * sx}" y="${Y(run.top)}" width="${(end - run.d0) * sx}" height="${Y(run.bg) - Y(run.top)}" fill="#cfcac0" stroke="#555" stroke-width="0.6"/>`; run = null; } };
  samples.forEach((s) => {
    if (s.top === null || (run && (run.top !== s.top || run.bg !== s.bg))) flush(s.d);
    if (s.top !== null && !run) run = { d0: s.d, top: s.top, bg: s.bg };
  });
  flush(L);
  // 지반선
  let path = '';
  samples.forEach((s, i) => { if (s.g !== null) path += (path ? 'L' : 'M') + (s.d * sx).toFixed(1) + ' ' + Y(s.g).toFixed(1); });
  svg += `<path d="${path}" fill="none" stroke="#222" stroke-width="1.6"/>`;
  // 대지 구간
  samples.forEach((s) => { if (s.site) svg += `<rect x="${s.d * sx - 0.6}" y="${Y(s.g) - 1}" width="1.6" height="3" fill="#d94f3d"/>`; });
  svg += `<text x="4" y="16" font-size="15">단면 길이 ${L.toFixed(0)}m · 수직 축척 = 수평과 동일 · 빨강 = 대지</text></svg>`;
  $('section').innerHTML = svg;
}

// ---------- 내보내기 ----------
function dxf() {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC'];
  const layers = [['SITE', 1], ['PARCEL', 8], ['BLDG', 7], ['BLDG_ROOF', 9]];
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
  out.push('0', 'TEXT', '8', 'SITE', '10', '0', '20', '-5', '30', '0', '40', '1.5', '1', `ORIGIN lon ${o.lon.toFixed(7)} lat ${o.lat.toFixed(7)} (unit m)`);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n');
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function projectJson() {
  return JSON.stringify({
    version: 1, origin: S.origin, floorHeight: S.floorH, radius: S.radius, demo: S.demo,
    site: S.siteParcels.map(({ id, jibun, ring, ground, props }) => ({ id, jibun, ring, ground, pnu: props.pnu })),
    parcels: S.parcels.map(({ id, ring, ground, props }) => ({ id, ring, ground, pnu: props.pnu })),
    buildings: S.buildings.map(({ id, ring, floors, height, heightSrc, ground, onSite, props }) => ({ id, ring, floors, height, heightSrc, ground, onSite, props })),
  });
}
function loadProject(text) {
  const d = JSON.parse(text);
  Object.assign(S, { origin: d.origin, floorH: d.floorHeight, radius: d.radius, demo: d.demo });
  S.siteParcels = d.site.map((p) => ({ ...p, props: { pnu: p.pnu } }));
  S.parcels = d.parcels.map((p) => ({ ...p, props: { pnu: p.pnu } }));
  S.buildings = d.buildings;
  log('프로젝트 파일을 불러왔습니다.', 'ok');
  buildScene(true);
}

// ---------- UI 연결 ----------
function init() {
  $('key').value = store.get('vw_key') || '';
  $('domain').value = store.get('vw_domain') || (location.origin + location.pathname.replace(/[^/]*$/, ''));
  initThree();
  $('btnLoad').onclick = () => loadVWorld().catch((e) => log(e.message, 'err'));
  $('btnDemo').onclick = loadDemo;
  $('btnTerrain').onclick = () => sampleTerrain();
  $('showContours').onchange = () => S.origin && buildScene(false);
  $('floorH').onchange = (e) => {
    S.floorH = parseFloat(e.target.value) || 3.3;
    S.buildings.forEach((b) => { if (b.heightSrc !== 'data') b.height = b.floors * S.floorH; });
    if (S.origin) buildScene(false);
  };
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('showLines').onchange = () => S.origin && S.mode === 'view' && runViewAnalysis();
  $('btnDxf').onclick = () => S.origin && download('site-context.dxf', dxf(), 'application/dxf');
  $('btnJson').onclick = () => S.origin && download('site-context.json', projectJson(), 'application/json');
  $('btnPng').onclick = () => { const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png'); a.download = 'site-context.png'; a.click(); };
  $('fileJson').onchange = (e) => { const f = e.target.files[0]; if (f) f.text().then(loadProject); };
  setMode('height');
  window.__S = S; // 디버그용
  window.__demo = loadDemo;
  window.__mode = setMode;
}
init();
