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
  T.ready = false; S.env = null;
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
  T.ready = false; S.env = null;
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
  roads.forEach((r, i) => (r.name = String.fromCharCode(65 + i)));
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
    const lab = textSprite(`${r.name} ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(1)}m`);
    lab.position.set(mid.ox + mid.nx * 6, mid.roadG + 10, -(mid.oy + mid.ny * 6));
    groupCtx.add(lab);
  });
  const all = S.roads.map((r) => r.avg);
  const diff = Math.max(...all) - Math.min(...all);
  const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  box.innerHTML = S.roads.map((r) => `<b>${r.name}</b> ${r.dir}측 ${r.kind} · 접도 ${r.len.toFixed(0)}m · 평균 ${fmt(r.avg)}m (${fmt(r.lo)} ~ ${fmt(r.hi)}) · 경사 ${r.slope.toFixed(1)}%`).join('<br>') +
    (S.roads.length > 1 ? `<br><b>도로 간 높이차 ${diff.toFixed(1)}m</b> (평균 기준) · 최대 ${(Math.max(...S.roads.map((r) => r.hi)) - Math.min(...S.roads.map((r) => r.lo))).toFixed(1)}m` : '') +
    `<br><span class="dim">기준 0 = 대지 최저점 (해발 ${T.base.toFixed(1)}m). 경계 밖 4m 지점의 지형 높이.</span>`;
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
  const ctx = S.buildings.filter((b) => !b.onSite && b.mesh);
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
      const Hs = d < 1.5 ? 0 : Math.max(10, 2 * d);
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
    ${sun ? `정북 기준선: ${sunRoad ? '도로·철도 건너편 대지경계선 (시행령 86조⑥)' : '대지에 바로 맞닿은 인접대지만'}${refSummary.length ? '<br>기준 대지: ' + refSummary.slice(0, 6).join(', ') + (refSummary.length > 6 ? ` 외 ${refSummary.length - 6}` : '') : ''}<br>` : ''}
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

// ---------- 내보내기 ----------
function dxf() {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC'];
  const layers = [['SITE', 1], ['PARCEL', 8], ['BLDG', 7], ['BLDG_ROOF', 9], ['ENVELOPE', 5]];
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
  envOutlines().forEach(([x0, y0, x1, y1, z]) => out.push('0', 'LINE', '8', 'ENVELOPE', '10', f(x0), '20', f(y0), '30', f(z), '11', f(x1), '21', f(y1), '31', f(z)));
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
  $('hideSiteBldg').onchange = () => S.origin && buildScene(false);
  $('secEx').onchange = () => S.sectionPts.length === 2 && drawSection();
  $('zSel').innerHTML = '<option value="">선택</option>' + Object.keys(ZONES).map((z) => `<option>${z}</option>`).join('');
  $('zSel').onchange = applyZoneDefaults;
  $('btnEnv').onclick = () => buildEnvelope().catch((e) => { $('envInfo').textContent = '오류: ' + e.message; });
  $('envShow').onchange = () => drawEnvelope();
  $('secClose').onclick = () => { $('sectionBox').style.display = 'none'; };
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
