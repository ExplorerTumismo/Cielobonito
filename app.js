/* Cielo — PWA del tiempo multimodelo para España
   Fuentes: AEMET OpenData (predicción municipal horaria),
   Open-Meteo (AROME Météo-France, ECMWF IFS, DWD ICON). */
'use strict';

// ───────────────────────── configuración ─────────────────────────
const MODELS = {
  aemet:    { name: 'AEMET',    sub: 'Predicción municipal',   css: '--m-aemet' },
  arome:    { name: 'AROME',    sub: 'Météo-France · 2,5 km',  css: '--m-arome' },
  ecmwf:    { name: 'ECMWF',    sub: 'IFS · 0,25°',            css: '--m-ecmwf' },
  icon:     { name: 'ICON',     sub: 'DWD · seamless',         css: '--m-icon' },
};
const ORDER = ['aemet', 'arome', 'ecmwf', 'icon'];
const OM_MODELS = { arome: 'meteofrance_arome_france', ecmwf: 'ecmwf_ifs025', icon: 'icon_seamless' };
const OM_VARS = 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,cloud_cover,is_day,cape,lifted_index,lightning_potential';
const HOUR = 3600e3;


// ───────────────────────── estado ─────────────────────────
const LS = {
  get(k, d) { try { const v = localStorage.getItem('cielo.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cielo.' + k, JSON.stringify(v)); } catch {} },
};
const S = {
  loc: LS.get('loc', { name: 'Madrid', admin: 'Comunidad de Madrid', lat: 40.4168, lon: -3.7038 }),
  keys: LS.get('keys', { aemet: '', proxy: '' }),
  enabled: LS.get('enabled', { aemet: true, arome: true, ecmwf: true, icon: true }),
  data: {},       // modelo -> serie normalizada
  status: {},     // modelo -> mensaje si no hay datos
  tz: 'Europe/Madrid',
  view: LS.get('view', 'now'),
  hidden: new Set(LS.get('hidden', [])), // ocultos en meteograma
  openModels: new Set(),                  // modelos con su gráfico desplegado en «Ahora»
  fetchedAt: null,
};

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; };
const cssv = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const mcolor = (m) => cssv(MODELS[m]?.css || '--m-cons');
const round = (v, d = 0) => v == null || isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const fmtT = (v) => v == null ? '–' : `${Math.round(v)}°`;
const median = (a) => { const b = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms); }

// ───────────────────────── tiempo / zonas horarias ─────────────────────────
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function zoned(dateStr, hour, tz) { // 'YYYY-MM-DD' + hora local -> epoch ms
  const [y, m, d] = dateStr.split('-').map(Number);
  const g = Date.UTC(y, m - 1, d, hour);
  let t = g - tzOffset(g, tz);
  t = g - tzOffset(t, tz);
  return t;
}
const fmt = (ms, opts) => new Intl.DateTimeFormat('es-ES', { timeZone: S.tz, ...opts }).format(new Date(ms));
const hh = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(':00', 'h');
const localHour = (ms) => +fmt(ms, { hour: 'numeric', hourCycle: 'h23' });
const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;

// ───────────────────────── categorías de cielo ─────────────────────────
const CAT_TXT = { clear: 'Despejado', partly: 'Poco nuboso', cloudy: 'Nuboso', overcast: 'Cubierto', fog: 'Niebla', drizzle: 'Llovizna', rain: 'Lluvia', snow: 'Nieve', storm: 'Tormenta' };
const CAT_RANK = { clear: 0, partly: 1, cloudy: 2, overcast: 3, fog: 4, drizzle: 5, rain: 6, snow: 7, storm: 8 };
function catWMO(c) {
  if (c == null) return null;
  if (c <= 1) return 'clear'; if (c === 2) return 'partly'; if (c === 3) return 'overcast';
  if (c === 45 || c === 48) return 'fog'; if (c >= 51 && c <= 57) return 'drizzle';
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow'; if (c >= 95) return 'storm';
  return 'cloudy';
}
function catAEMET(v) {
  const c = parseInt(v, 10); if (isNaN(c)) return null;
  if (c === 11) return 'clear'; if (c === 12 || c === 13 || c === 17) return 'partly';
  if (c === 14 || c === 15) return 'cloudy'; if (c === 16) return 'overcast';
  if (c >= 43 && c <= 46) return 'drizzle'; if (c >= 23 && c <= 26) return 'rain';
  if ((c >= 33 && c <= 36) || (c >= 71 && c <= 74)) return 'snow';
  if ((c >= 51 && c <= 54) || (c >= 61 && c <= 64)) return 'storm';
  if (c >= 81 && c <= 83) return 'fog';
  return 'cloudy';
}
function icon(cat, night = false) {
  const sun = night
    ? '<path d="M15.5 4.5a6 6 0 1 0 4 9.6 7 7 0 0 1-4-9.6z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>';
  const cloud = (dx = 0, dy = 0) => `<path transform="translate(${dx} ${dy})" d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z"/>`;
  const smallSun = night
    ? '<path d="M10 3.5a4.2 4.2 0 1 0 3.2 6.6 4.8 4.8 0 0 1-3.2-6.6z"/>'
    : '<circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.4M1.8 8h1.4M3.6 3.6l1 1M12.4 3.6l-1 1"/>';
  const body = {
    clear: sun,
    partly: smallSun + '<path d="M9 20h8.5a3.5 3.5 0 0 0 .4-7 4.8 4.8 0 0 0-9.2 1.3A2.9 2.9 0 0 0 9 20z"/>',
    cloudy: cloud(0, 1),
    overcast: '<path d="M9.5 9.2A5 5 0 0 1 18.8 8a3.5 3.5 0 0 1 2.2 5.6" opacity=".55"/>' + cloud(-1, 2),
    fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
    drizzle: cloud(0, -3) + '<path d="M9 18.5v1M13 18.5v1M17 18.5v1"/>',
    rain: cloud(0, -3) + '<path d="M8.5 18l-1 3M12.5 18l-1 3M16.5 18l-1 3"/>',
    snow: cloud(0, -3) + '<path d="M9 19.5h.01M12.5 21h.01M16 19.5h.01" stroke-width="2.6"/>',
    storm: cloud(0, -3) + '<path d="M13 15l-2 3.5h3L12 22"/>',
  }[cat] || '<circle cx="12" cy="12" r="1.5"/>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
function windDir(deg) { if (deg == null) return ''; return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }
const DIRDEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SO: 225, SW: 225, O: 270, W: 270, NO: 315, NW: 315, C: null };

// ───────────────────────── serie normalizada ─────────────────────────
function emptySeries() { return { t: [], temp: [], feel: [], precip: [], pop: [], wind: [], gust: [], dir: [], hum: [], cloud: [], cat: [], day: [], cape: [], li: [], ltg: [], pstorm: [] }; }
function fromMap(m) { // Map<epoch, obj> -> serie ordenada
  const s = emptySeries();
  [...m.keys()].sort((a, b) => a - b).forEach(t => { const o = m.get(t); s.t.push(t); for (const k of Object.keys(s)) if (k !== 't') s[k].push(o[k] ?? null); });
  return s;
}
function at(series, t) { // índice exacto de hora
  if (!series) return -1;
  const i = series.t.indexOf(t);
  return i;
}

// ───────────────────────── red ─────────────────────────
async function getJSON(url, opts = {}, encoding) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (encoding) { const buf = await r.arrayBuffer(); return JSON.parse(new TextDecoder(encoding).decode(buf)); }
  return r.json();
}
const proxy = () => (S.keys.proxy || '').replace(/\/+$/, '');

// Open-Meteo: AROME, ECMWF, ICON en una sola llamada
async function fetchOpenMeteo(lat, lon) {
  // Una petición por modelo: si AROME no cubre el punto (sur de Andalucía, Ceuta, Melilla, Canarias),
  // Open-Meteo responde 400 y eso no debe tumbar ECMWF ni ICON.
  const want = Object.keys(OM_MODELS).filter(m => S.enabled[m]);
  const out = {};
  await Promise.all(want.map(async (m) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${OM_VARS}`
      + `&models=${OM_MODELS[m]}&timezone=auto&timeformat=unixtime&forecast_days=7&wind_speed_unit=kmh`;
    let j;
    try { j = await getJSON(url); }
    catch (e) { S.status[m] = /HTTP 400/.test(e.message) ? (m === 'arome' ? 'AROME no cubre esta zona' : 'Sin datos aquí') : 'Error de red'; return; }
    if (j.timezone) S.tz = j.timezone;
    const h = j.hourly, g = (v) => h[v] || [], map = new Map();
    h.time.forEach((ts, i) => {
      const temp = g('temperature_2m')[i];
      if (temp == null) return;
      map.set(ts * 1000, {
        temp, feel: g('apparent_temperature')[i], precip: g('precipitation')[i], wind: g('wind_speed_10m')[i], gust: g('wind_gusts_10m')[i],
        dir: g('wind_direction_10m')[i], hum: g('relative_humidity_2m')[i], cloud: g('cloud_cover')[i], cat: catWMO(g('weather_code')[i]), day: g('is_day')[i],
        cape: g('cape')[i], li: g('lifted_index')[i], ltg: g('lightning_potential')[i],
      });
    });
    if (map.size) out[m] = fromMap(map);
    else S.status[m] = m === 'arome' ? 'AROME no cubre esta zona' : 'Sin datos';
  }));
  return out;
}

// AEMET OpenData
async function aemet(path) {
  const p = proxy();
  if (!p && !S.keys.aemet) throw new Error('nokey');
  const url = p ? `${p}/aemet/api${path}` : `https://opendata.aemet.es/opendata/api${path}?api_key=${encodeURIComponent(S.keys.aemet)}`;
  const meta = await getJSON(url, {}, 'iso-8859-15');
  if (Array.isArray(meta)) return meta;
  if (!meta.datos) throw new Error(meta.descripcion || 'AEMET sin datos');
  const datos = p ? meta.datos.replace(/^https?:\/\/opendata\.aemet\.es\/opendata/, `${p}/aemet`) : meta.datos;
  return getJSON(datos, {}, 'iso-8859-15');
}
async function aemetMunicipios() {
  const c = LS.get('aemet.mun', null);
  if (c && c.v === 1 && c.list?.length > 1000) return c.list;
  const raw = await aemet('/maestro/municipios');
  const list = raw.map(m => [String(m.id).replace(/\D/g, '').padStart(5, '0'), +m.latitud_dec, +m.longitud_dec, m.nombre]).filter(m => !isNaN(m[1]));
  LS.set('aemet.mun', { v: 1, list });
  return list;
}
function nearest(list, lat, lon) {
  let best = null, bd = Infinity; const k = Math.cos(lat * Math.PI / 180);
  for (const m of list) { const d = (m[1] - lat) ** 2 + ((m[2] - lon) * k) ** 2; if (d < bd) { bd = d; best = m; } }
  return best ? { m: best, km: Math.sqrt(bd) * 111 } : null;
}
async function fetchAEMET(lat, lon) {
  const list = await aemetMunicipios();
  const nn = nearest(list, lat, lon);
  if (!nn || nn.km > 25) throw new Error('lejos');
  const code = nn.m[0];
  const j = await aemet('/prediccion/especifica/municipio/horaria/' + code);
  const pred = j[0];
  const tz = /^(35|38)/.test(code) ? 'Atlantic/Canary' : 'Europe/Madrid';
  const map = new Map();
  const put = (t, k, v) => { if (!map.has(t)) map.set(t, {}); map.get(t)[k] = v; };
  const num = (v) => v === 'Ip' ? 0.05 : (v === '' || v == null ? null : parseFloat(String(v).replace(',', '.')));
  for (const d of pred.prediccion.dia) {
    const date = d.fecha.slice(0, 10);
    const each = (arr, fn) => (arr || []).forEach(x => { if (x.periodo != null && String(x.periodo).length <= 2) fn(zoned(date, +x.periodo, tz), x); });
    each(d.temperatura, (t, x) => put(t, 'temp', num(x.value)));
    each(d.sensTermica, (t, x) => put(t, 'feel', num(x.value)));
    each(d.precipitacion, (t, x) => put(t, 'precip', num(x.value)));
    each(d.nieve, (t, x) => { const v = num(x.value); if (v) put(t, 'snowfall', v); });
    each(d.humedadRelativa, (t, x) => put(t, 'hum', num(x.value)));
    each(d.estadoCielo, (t, x) => { put(t, 'cat', catAEMET(x.value)); put(t, 'day', /n$/.test(x.value) ? 0 : 1); });
    each(d.vientoAndRachaMax, (t, x) => {
      if (x.velocidad) { put(t, 'wind', num(x.velocidad[0])); put(t, 'dir', DIRDEG[x.direccion?.[0]] ?? null); }
      else if (x.value != null) put(t, 'gust', num(x.value));
    });
    const spread6 = (arr, key) => (arr || []).forEach(x => {
      const p = String(x.periodo || ''); if (p.length !== 4) return;
      let a = +p.slice(0, 2), b = +p.slice(2); if (b <= a) b += 24;
      for (let hr = a; hr < b; hr++) { const t = zoned(date, 0, tz) + hr * HOUR; if (map.has(t)) map.get(t)[key] = num(x.value); }
    });
    spread6(d.probPrecipitacion, 'pop');
    spread6(d.probTormenta, 'pstorm');
  }
  for (const [t, o] of map) if (o.temp == null) map.delete(t);
  const s = fromMap(map);
  s.label = pred.nombre || nn.m[3];
  return s;
}

// Calidad del aire (CAMS Europa vía Open-Meteo, índice europeo EAQI)
async function fetchAir(lat, lon) {
  const j = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}`
    + `&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone&hourly=european_aqi&timezone=auto&timeformat=unixtime&forecast_days=2`);
  return { cur: j.current, t: (j.hourly?.time || []).map(x => x * 1000), aqi: j.hourly?.european_aqi || [] };
}
const AQI = [[20, 'Buena', '#50c8a0'], [40, 'Razonable', '#4fb05a'], [60, 'Moderada', '#e8c33a'], [80, 'Mala', '#f08a3c'], [100, 'Muy mala', '#e0453a'], [Infinity, 'Extremadamente mala', '#8e3a8f']];
const aqiLevel = (v) => AQI.find(a => v <= a[0]);

// Índice UV (Open-Meteo, basado en GFS): actual, horario y máximo diario
async function fetchUV(lat, lon) {
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=uv_index&hourly=uv_index&daily=uv_index_max&forecast_days=8&timezone=auto&timeformat=unixtime`);
  return { cur: j.current?.uv_index ?? null, t: (j.hourly?.time || []).map(x => x * 1000), v: j.hourly?.uv_index || [],
    dt: (j.daily?.time || []).map(x => x * 1000), dmax: j.daily?.uv_index_max || [] };
}
const UVL = [[2, 'Bajo', '#4cbb5e'], [5, 'Moderado', '#e8c12f'], [7, 'Alto', '#f08a2c'], [10, 'Muy alto', '#e0453a'], [Infinity, 'Extremo', '#a55ad6']];
const uvLevel = (v) => UVL.find(x => Math.round(v) <= x[0]);
function uvAt(t) { const u = S.uv; if (!u) return null; const i = u.t.indexOf(t); return i < 0 ? null : u.v[i]; }

// Normales climáticas 1991-2020 (archivo ERA5 de Open-Meteo): media diaria de máx/mín suavizada a 15 días.
// Se descargan una vez por ubicación y se guardan en el teléfono.
const DOY = (ms) => { const p = fmt(ms, { month: 'numeric', day: 'numeric' }).split('/').map(Number); const d = new Date(Date.UTC(2001, p[1] - 1, p[0])); return Math.round((d - Date.UTC(2001, 0, 1)) / 864e5); }; // 0..364 (29-feb cuenta como 28-feb)
async function fetchNormals(lat, lon) {
  const key = 'normals.' + lat.toFixed(1) + ',' + lon.toFixed(1);
  const c = LS.get(key, null); if (c) return c;
  const j = await getJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
    + `&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=auto`);
  const sx = Array(365).fill(0), sn = Array(365).fill(0), n = Array(365).fill(0);
  j.daily.time.forEach((d, i) => {
    const [y, m, dd] = d.split('-').map(Number); const k = Math.min(364, Math.round((Date.UTC(2001, m - 1, m === 2 && dd === 29 ? 28 : dd) - Date.UTC(2001, 0, 1)) / 864e5));
    const x = j.daily.temperature_2m_max[i], mn = j.daily.temperature_2m_min[i];
    if (x != null && mn != null) { sx[k] += x; sn[k] += mn; n[k]++; }
  });
  const mx0 = sx.map((s, k) => s / (n[k] || 1)), mn0 = sn.map((s, k) => s / (n[k] || 1));
  const smooth = (arr) => arr.map((_, k) => { let s = 0; for (let d = -7; d <= 7; d++) s += arr[(k + d + 365) % 365]; return Math.round(s / 15 * 10) / 10; });
  const out = { mx: smooth(mx0), mn: smooth(mn0) };
  LS.set(key, out);
  return out;
}

// Salida y puesta del sol (algoritmo astronómico de SunCalc / NOAA, sin red)
function sunTimes(ms, lat, lon) {
  const rad = Math.PI / 180, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397, J0 = 0.0009;
  const d = ms / 864e5 - 0.5 + J1970 - J2000, lw = -lon * rad, phi = lat * rad;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const transit = (a) => J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const noon = transit(ds);
  const w = Math.acos((Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  const set = transit(J0 + (w + lw) / (2 * Math.PI) + n), rise = noon - (set - noon);
  const ms_ = (j) => (j + 0.5 - J1970) * 864e5;
  return { rise: ms_(rise), set: ms_(set), noon: ms_(noon) };
}

// Riesgo de tormenta en las próximas 24 h combinando todos los modelos
function stormRisk(from) {
  const ms = active(), H = 24, perHour = Array(H).fill(0);
  let capeMax = null, liMin = null, ltgMax = null, aemetP = null; const who = [];
  ms.forEach(m => {
    const s = S.data[m]; let hit = false;
    s.t.forEach((t, i) => {
      const k = Math.round((t - from) / HOUR); if (k < 0 || k >= H) return;
      if (s.cat[i] === 'storm') { perHour[k]++; hit = true; }
      if (s.cape?.[i] != null) capeMax = Math.max(capeMax ?? 0, s.cape[i]);
      if (s.li?.[i] != null) liMin = Math.min(liMin ?? 99, s.li[i]);
      if (s.ltg?.[i] != null) ltgMax = Math.max(ltgMax ?? 0, s.ltg[i]);
      if (m === 'aemet' && s.pstorm?.[i] != null) aemetP = Math.max(aemetP ?? 0, s.pstorm[i]);
    });
    if (hit) who.push(m);
  });
  const frac = ms.length ? who.length / ms.length : 0;
  let lvl = 0;
  if (who.length || (capeMax >= 800 && liMin <= -1) || aemetP >= 30 || ltgMax >= 200) lvl = 1;
  if (frac >= 0.5 || (capeMax >= 1500 && liMin <= -3) || aemetP >= 60) lvl = 2;
  const hrs = perHour.map((c, k) => c ? k : -1).filter(k => k >= 0);
  return { lvl, who, n: ms.length, perHour, capeMax, liMin, ltgMax, aemetP, win: hrs.length ? [from + hrs[0] * HOUR, from + (hrs.at(-1) + 1) * HOUR] : null };
}

// ───────────────────────── carga ─────────────────────────
async function load(force = false) {
  const { lat, lon } = S.loc;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cache = LS.get('cache', null);
  if (!force && cache && cache.key === key && Date.now() - cache.at < 20 * 60e3) {
    S.data = cache.data; S.status = cache.status; S.tz = cache.tz; S.air = cache.air; S.uv = cache.uv; S.fetchedAt = cache.at; render(); loadNormals(); return;
  }
  $('#pstat').textContent = 'Actualizando…';
  S.status = {};
  const jobs = [
    fetchOpenMeteo(lat, lon),
    S.enabled.aemet ? fetchAEMET(lat, lon).then(r => ({ aemet: r }), e => { S.status.aemet = e.message === 'nokey' ? 'Añade la API key en Ajustes' : e.message === 'lejos' ? 'Sin municipio cercano' : (e instanceof TypeError ? 'Bloqueado (CORS): usa proxy' : 'Error: ' + e.message); return {}; }) : Promise.resolve({}),
  ];
  const airJob = fetchAir(lat, lon).then(a => { S.air = a; }, () => { S.air = null; });
  const uvJob = fetchUV(lat, lon).then(u => { S.uv = u; }, () => { S.uv = null; });
  const res = await Promise.all(jobs); await airJob; await uvJob;
  S.data = Object.assign({}, ...res);
  for (const m of ORDER) if (!S.enabled[m]) S.status[m] = 'Desactivado';
  S.fetchedAt = Date.now();
  if (Object.keys(S.data).length) LS.set('cache', { key, at: S.fetchedAt, data: S.data, status: S.status, tz: S.tz, air: S.air, uv: S.uv });
  else if (cache && cache.key === key) { S.data = cache.data; S.tz = cache.tz; S.air = cache.air; S.uv = cache.uv; S.fetchedAt = cache.at; toast('Sin conexión: mostrando la última predicción'); }
  render();
  loadNormals();
}

async function loadNormals() {
  const loc = S.loc;
  try { const n = await fetchNormals(loc.lat, loc.lon); if (loc === S.loc) { S.normals = n; renderNow(); } } catch { S.normals = null; }
}

// ───────────────────────── consenso ─────────────────────────
function active() { return ORDER.filter(m => S.data[m] && S.enabled[m]); }
function consensusAt(t, field, models = active()) {
  return median(models.map(m => { const i = at(S.data[m], t); return i < 0 ? null : S.data[m][field][i]; }));
}
function catAt(t, models = active()) {
  const votes = {};
  models.forEach(m => { const i = at(S.data[m], t); const c = i < 0 ? null : S.data[m].cat[i]; if (c) votes[c] = (votes[c] || 0) + 1 + CAT_RANK[c] * 0.01; });
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}
function dayAt(t) {
  for (const m of active()) { const i = at(S.data[m], t); if (i >= 0 && S.data[m].day[i] != null) return !!S.data[m].day[i]; }
  const h = localHour(t); return h >= 8 && h < 19;
}
function sumPrecip(m, from, to) {
  const s = S.data[m]; if (!s) return null; let sum = 0, n = 0;
  s.t.forEach((t, i) => { if (t >= from && t < to && s.precip[i] != null) { sum += s.precip[i]; n++; } });
  return n ? sum : null;
}
function nearestIdx(s, t) { let bi = -1, bd = Infinity; s.t.forEach((x, i) => { const d = Math.abs(x - t); if (d < bd) { bd = d; bi = i; } }); return bd <= 3 * HOUR ? bi : -1; }

// ───────────────────────── gráficos estilo Weawow ─────────────────────────
const RI = { // iconos de cabecera de cada fila
  temp: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><circle cx="12" cy="17.5" r="1.6" fill="currentColor"/>',
  feel: '<path d="M8 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><circle cx="18" cy="7" r="2"/><path d="M15 15c0-2 1.5-3 3-3s3 1 3 3"/>',
  pop:  '<path d="M7 20l4-8M12 20l4-8M17 20l2-4"/><path d="M15 6.5l4-3M15 3.5h.01M19 6.5h.01" stroke-width="1.4"/>',
  rain: '<path d="M6 20l5-9M11 20l5-9M16 20l3-5.5"/>',
  wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 17h7"/>',
  gust: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7M3 20h4"/>',
  hum:  '<path d="M12 3.5c3 4 6 7.3 6 10.5a6 6 0 0 1-12 0c0-3.2 3-6.5 6-10.5z"/>',
  uv:   '<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
};
const rIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${RI[k]}</svg>`;
const C_TEMP = '#e3a33a', C_MIN = '#7fb2ff', C_BLUE = '#4a9eff', C_GREY = '#c9ced6';
const nf = (v, d = 0) => v == null ? '–' : String(round(v, d)).replace('.', ',');

function circMean(dirs, w) {
  let x = 0, y = 0;
  dirs.forEach((d, i) => { if (d == null) return; const k = w?.[i] ?? 1; x += Math.cos(d * Math.PI / 180) * k; y += Math.sin(d * Math.PI / 180) * k; });
  if (!x && !y) return null;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// probabilidad de precipitación por consenso: % de modelos con ≥0,1 mm en esa hora (y la de AEMET si existe)
function popAt(t) {
  const ms = active(); let n = 0, wet = 0, ae = null;
  ms.forEach(m => { const s = S.data[m], i = at(s, t); if (i < 0) return; if (s.precip[i] != null) { n++; if (s.precip[i] >= 0.1) wet++; } if (m === 'aemet' && s.pop?.[i] != null) ae = s.pop[i]; });
  if (!n && ae == null) return null;
  const frac = n ? wet / n * 100 : null;
  const v = ae != null && frac != null ? (frac + ae) / 2 : (ae ?? frac);
  return Math.round(v / 5) * 5;
}
function dirAt(t) {
  const d = [], w = [];
  active().forEach(m => { const s = S.data[m], i = at(s, t); if (i >= 0 && s.dir[i] != null) { d.push(s.dir[i]); w.push(Math.max(1, s.wind[i] || 1)); } });
  return circMean(d, w);
}

// Renderiza una tabla-gráfico desplazable horizontalmente
// cols: [{top, icon, label}] · rows: [{key, title, unit, type:'line'|'dual'|'bars'|'arrows', v, v2, color, color2, fmt, h}]
function chartTable(cols, rows, COL, center = false) {
  const N = cols.length, W = N * COL, cx = (k) => k * COL + COL / 2;
  let html = `<div class="hc${center ? ' ctr' : ''}"><div class="hc-in" style="width:${W}px;--col:${COL}px">`;
  // franja de días: el nombre del día queda fijo a la izquierda hasta que termina ese día
  const daySeg = cols[0].day !== undefined;
  if (daySeg) {
    const segs = []; cols.forEach(c => { if (!segs.length || segs.at(-1).day !== c.day) segs.push({ day: c.day, n: 0 }); segs.at(-1).n++; });
    html += `<div class="hc-days">${segs.map(s => `<div style="width:${s.n * COL}px"><span>${s.day}</span></div>`).join('')}</div>`;
  }
  html += `<div class="hc-head">${cols.map(c => `<div style="width:${COL}px">${daySeg ? '' : `<span class="hd">${c.top || '&nbsp;'}</span>`}${c.icon}<span class="hl">${c.label}</span></div>`).join('')}</div>`;
  for (const r of rows) {
    html += `<div class="hc-row">` + (r.type === 'arrows' ? '' : `<div class="hc-title">${rIcon(r.key)}<span>${r.title}</span><small>${r.unit || ''}</small></div>`);
    const vals = (r.type === 'bars' ? r.v : r.v.concat(r.v2 || [])).filter(x => x != null);
    if (r.type === 'arrows') {
      html += `<div class="hc-arrows">${r.v.map(d => `<div style="width:${COL}px">${d == null ? '' : `<svg viewBox="0 0 24 24" style="transform:rotate(${(d + 180) % 360}deg)"><path d="M12 20V4M6 10l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`}</div>`).join('')}</div></div>`;
      continue;
    }
    const H = r.h || 54, top = r.type === 'bars' && r.v2 ? 30 : 17, bot = r.type === 'dual' ? H - 17 : H - 3, base = r.type === 'dual' ? H - 2 : bot;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (r.type === 'bars' || r.zero) lo = 0;
    if (r.max != null) hi = Math.max(hi, r.max);
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < (r.minSpan || 1)) hi = lo + (r.minSpan || 1);
    const Y = (v) => bot - (v - lo) / (hi - lo) * (bot - top);
    const gid = 'g' + Math.random().toString(36).slice(2, 8);
    let s = `<svg width="${W}" height="${H}" class="hc-svg"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${r.color}" stop-opacity=".45"/><stop offset="1" stop-color="${r.color}" stop-opacity="0"/></linearGradient></defs>`;
    s += `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="rgba(255,255,255,.12)"/>`;
    if (r.type === 'bars') {
      r.v.forEach((v, k) => {
        if (v == null) return;
        if (v > 0) s += `<rect x="${k * COL + COL * 0.28}" y="${Y(v)}" width="${COL * 0.44}" height="${bot - Y(v)}" rx="2" fill="${r.colorFn ? r.colorFn(v) : r.color}" opacity=".85"/>`;
        s += `<text x="${cx(k)}" y="${(v > 0 ? Y(v) : bot) - 4}" class="${v > 0 ? 'on' : ''}">${r.fmt(v)}</text>`;
      });
      if (r.v2) r.v2.forEach((p, k) => { if (p != null) s += `<text x="${cx(k)}" y="11" class="sm" style="fill:${p >= 50 ? '#8cc4ff' : 'var(--mute)'}">${p}%</text>`; });
    } else {
      const series = r.type === 'dual' ? [[r.v, r.color, -5], [r.v2, r.color2, 14]] : [[r.v, r.color, -5]];
      series.forEach(([arr, col, dy], si) => {
        let d = '', first = null, lastX = null;
        arr.forEach((v, k) => { if (v == null) return; const x = cx(k), y = Y(v); d += (first == null ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1); if (first == null) first = x; lastX = x; });
        if (!d) return;
        if (r.type !== 'dual') s += `<path d="${d}L${lastX} ${bot}L${first} ${bot}Z" fill="url(#${gid})"/>`;
        else if (si === 0) { // banda entre máxima y mínima
          const up = [], dn = [];
          r.v.forEach((v, k) => { if (v != null && r.v2[k] != null) { up.push(`${cx(k)} ${Y(v)}`); dn.unshift(`${cx(k)} ${Y(r.v2[k])}`); } });
          if (up.length) s += `<path d="M${up.join('L')}L${dn.join('L')}Z" fill="${r.color}" opacity=".16"/>`;
        }
        s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/>`;
        arr.forEach((v, k) => { if (v != null) s += `<text x="${cx(k)}" y="${Y(v) + dy}">${r.fmt(v)}</text>`; });
      });
    }
    html += s + '</svg></div>';
  }
  return html + '</div></div>';
}

// Fuente de datos para el gráfico horario: consenso entre modelos o un modelo concreto
const CONS_SRC = {
  v: (f, t) => f === 'pop' ? popAt(t) : f === 'dir' ? dirAt(t) : consensusAt(t, f === 'rain' ? 'precip' : f),
  cat: (t) => catAt(t), night: (t) => !dayAt(t),
};
function modelSrc(m) {
  const s = S.data[m];
  return {
    v: (f, t) => { const i = at(s, t); if (i < 0) return null; return f === 'pop' ? (s.pop?.[i] ?? null) : f === 'rain' ? s.precip[i] : s[f]?.[i] ?? null; },
    cat: (t) => { const i = at(s, t); return i < 0 ? null : s.cat[i]; },
    night: (t) => { const i = at(s, t); return i >= 0 && s.day[i] != null ? s.day[i] === 0 : !dayAt(t); },
  };
}
function hourlyChart(now, m) {
  const src = m ? modelSrc(m) : CONS_SRC;
  const cols = [], R = { temp: [], feel: [], pop: [], rain: [], wind: [], dir: [], gust: [], hum: [], uv: [] };
  const todayKey = fmt(now, { year: 'numeric', month: '2-digit', day: '2-digit' }), tomorrowKey = fmt(now + 864e5, { year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let k = 0; k < 48; k++) {
    const t = now + k * HOUR, temp = src.v('temp', t);
    if (temp == null) continue;
    const h = localHour(t), dkey = fmt(t, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const day = dkey === todayKey ? 'Hoy' : dkey === tomorrowKey ? 'Mañana' : fmt(t, { weekday: 'long' });
    cols.push({ day, icon: icon(src.cat(t), src.night(t)), label: k === 0 ? 'Ahora' : String(h).padStart(2, '0') });
    for (const f of Object.keys(R)) R[f].push(f === 'temp' ? temp : f === 'uv' ? (m ? null : uvAt(t)) : src.v(f, t));
  }
  if (!cols.length) return '<div class="note" style="padding:12px">Sin datos para las próximas horas.</div>';
  const hasPop = R.pop.some(p => p != null);
  const rows = [
    { key: 'temp', title: 'Temperatura', unit: '°C', type: 'line', v: R.temp, color: C_TEMP, fmt: v => Math.round(v) + '°', minSpan: 4, h: 58 },
    { key: 'feel', title: 'Sensación térmica', unit: '°C', type: 'line', v: R.feel, color: C_TEMP, fmt: v => Math.round(v) + '°', minSpan: 4, h: 58 },
    { key: 'rain', title: 'Precipitación', unit: hasPop ? 'probabilidad % · mm' : 'mm', type: 'bars', v: R.rain.map(v => v == null ? null : round(v, 1)), v2: hasPop ? R.pop : null, color: C_BLUE, fmt: v => nf(v, 1), max: 2, h: hasPop ? 60 : 46 },
    { key: 'wind', title: 'Viento', unit: 'km/h', type: 'line', v: R.wind, color: C_GREY, fmt: v => Math.round(v), zero: true, minSpan: 20 },
    { key: 'wind', title: '', unit: '', type: 'arrows', v: R.dir },
    { key: 'gust', title: 'Ráfagas', unit: 'km/h', type: 'line', v: R.gust, color: C_GREY, fmt: v => Math.round(v), zero: true, minSpan: 20 },
    { key: 'hum', title: 'Humedad', unit: '%', type: 'line', v: R.hum, color: C_BLUE, fmt: v => Math.round(v), zero: true, max: 100 },
    { key: 'uv', title: 'Índice UV', unit: '', type: 'bars', v: R.uv.map(v => v == null ? null : Math.round(v)), colorFn: v => uvLevel(v)[2], fmt: v => Math.round(v), max: 8, h: 50 },
  ].filter(r => r.type === 'arrows' ? r.v.some(x => x != null) : r.v.some(x => x != null));
  return chartTable(cols, rows, 46);
}

// Previsión diaria: agregados por modelo y día, y mediana entre modelos
function dailyChart() {
  const ms = active(); if (!ms.length) return '';
  const dk = (t) => fmt(t, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map(); // key -> {t (mediodía), per: {m: agregados}}
  for (const m of ms) {
    const s = S.data[m], by = new Map();
    s.t.forEach((t, i) => { const k = dk(t); if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
    for (const [k, idx] of by) {
      if (idx.length < 12) continue;
      const pick = (f) => idx.map(i => s[f][i]).filter(v => v != null);
      const T = pick('temp'), F = pick('feel'), P = pick('precip'), Wn = pick('wind'), G = pick('gust'), Hm = pick('hum');
      if (!T.length) continue;
      if (!days.has(k)) days.set(k, { t: s.t[idx[Math.floor(idx.length / 2)]], per: {} });
      days.get(k).per[m] = {
        tmax: Math.max(...T), tmin: Math.min(...T), fmax: F.length ? Math.max(...F) : null, fmin: F.length ? Math.min(...F) : null,
        rain: P.length ? P.reduce((a, b) => a + b, 0) : null, wind: Wn.length ? Math.max(...Wn) : null, gust: G.length ? Math.max(...G) : null,
        hum: Hm.length ? Hm.reduce((a, b) => a + b, 0) / Hm.length : null,
        dir: circMean(idx.map(i => s.dir[i]), idx.map(i => s.wind[i] || 1)),
        wet: P.filter(v => v >= 0.1).length / Math.max(1, P.length),
      };
    }
  }
  const today = dk(Date.now()), tomorrow = dk(Date.now() + 864e5);
  const keys = [...days.keys()].sort((x, y) => days.get(x).t - days.get(y).t)
    .filter(k => days.get(k).t >= floorHour(Date.now()) - 12 * HOUR).slice(0, 8);
  const cols = [], R = { tmax: [], tmin: [], fmax: [], fmin: [], pop: [], rain: [], wind: [], dir: [], gust: [], hum: [], uv: [] };
  for (const k of keys) {
    const d = days.get(k), per = Object.values(d.per), med = (f) => median(per.map(x => x[f]));
    // icono del día: estado más frecuente entre 8 y 20 h; si hay lluvia/tormenta/nieve 3 h o más, manda
    const cnt = {};
    for (let h = 8; h <= 20; h++) { const t = zoned(k.split('/').reverse().join('-'), h, S.tz); const c = catAt(t); if (c) cnt[c] = (cnt[c] || 0) + 1; }
    const wetCat = ['storm', 'snow', 'rain', 'drizzle'].find(c => (cnt[c] || 0) >= 3);
    const cat = wetCat || Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0] || 'partly';
    // probabilidad diaria: máximo de la probabilidad horaria de consenso en el día
    let pmax = null; for (let h = 0; h < 24; h++) { const p = popAt(zoned(k.split('/').reverse().join('-'), h, S.tz)); if (p != null) pmax = Math.max(pmax ?? 0, p); }
    cols.push({ top: k === today ? 'Hoy' : k === tomorrow ? 'Mañana' : fmt(d.t, { weekday: 'short' }), icon: icon(cat, false), label: fmt(d.t, { day: 'numeric' }) + `<small>${per.length} mod.</small>` });
    R.tmax.push(med('tmax')); R.tmin.push(med('tmin')); R.fmax.push(med('fmax')); R.fmin.push(med('fmin'));
    R.pop.push(pmax); R.rain.push(med('rain')); R.wind.push(med('wind')); R.gust.push(med('gust')); R.hum.push(med('hum'));
    R.dir.push(circMean(per.map(x => x.dir)));
    const ui = S.uv ? S.uv.dt.findIndex(t => dk(t) === k) : -1; R.uv.push(ui < 0 ? null : S.uv.dmax[ui]);
  }
  if (!cols.length) return '';
  const rows = [
    { key: 'temp', title: 'Temperatura máx. / mín.', unit: '°C', type: 'dual', v: R.tmax, v2: R.tmin, color: C_TEMP, color2: C_MIN, fmt: v => Math.round(v) + '°', h: 78, minSpan: 6 },
    { key: 'feel', title: 'Sensación máx. / mín.', unit: '°C', type: 'dual', v: R.fmax, v2: R.fmin, color: C_TEMP, color2: C_MIN, fmt: v => Math.round(v) + '°', h: 78, minSpan: 6 },
    { key: 'rain', title: 'Precipitación', unit: 'probabilidad % · mm', type: 'bars', v: R.rain.map(v => v == null ? null : round(v, 1)), v2: R.pop, color: C_BLUE, fmt: v => nf(v, 1), max: 5, h: 60 },
    { key: 'wind', title: 'Viento máx.', unit: 'km/h', type: 'line', v: R.wind, color: C_GREY, fmt: v => Math.round(v), zero: true, minSpan: 20 },
    { key: 'wind', title: '', unit: '', type: 'arrows', v: R.dir },
    { key: 'gust', title: 'Ráfagas máx.', unit: 'km/h', type: 'line', v: R.gust, color: C_GREY, fmt: v => Math.round(v), zero: true, minSpan: 20 },
    { key: 'hum', title: 'Humedad media', unit: '%', type: 'line', v: R.hum, color: C_BLUE, fmt: v => Math.round(v), zero: true, max: 100 },
    { key: 'uv', title: 'Índice UV máx.', unit: '', type: 'bars', v: R.uv.map(v => v == null ? null : Math.round(v)), colorFn: v => uvLevel(v)[2], fmt: v => Math.round(v), max: 8, h: 50 },
  ];
  return chartTable(cols, rows.filter(r => r.v.some(x => x != null)), 56, true);
}

// ───────────────────────── render: Ahora ─────────────────────────
// diferencia con la normal climática del día (máx. o mín.)
function anom(v, f) {
  const n = S.normals?.[f]?.[DOY(Date.now())]; if (n == null || v == null) return '';
  const d = Math.round((v - n) * 10) / 10, cls = d > 0.4 ? 'up' : d < -0.4 ? 'dn' : 'eq';
  return ` <span class="an ${cls}" title="Normal: ${nf(n, 1)}°">${d > 0 ? '+' : d < 0 ? '−' : '±'}${nf(Math.abs(d), 1)}°</span>`;
}
// UV y calidad del aire actuales
function extraLine() {
  const parts = [];
  if (S.uv?.cur != null) { const l = uvLevel(S.uv.cur); parts.push(`<span><i style="background:${l[2]}"></i>UV ${Math.round(S.uv.cur)} · ${l[1].toLowerCase()}</span>`); }
  const q = S.air?.cur?.european_aqi; if (q != null) { const l = aqiLevel(q); parts.push(`<span><i style="background:${l[2]}"></i>Aire ${Math.round(q)} · ${l[1].toLowerCase()}</span>`); }
  return parts.length ? `<div class="xl num">${parts.join('')}</div>` : '';
}
function renderNow() {
  const v = $('#v-now');
  const ms = active();
  if (!ms.length) { v.innerHTML = '<div class="skel">No hay datos disponibles.<br>Comprueba la conexión.</div>'; return; }
  const now = floorHour(Date.now() + 30 * 60e3);
  const temps = ms.map(m => { const i = nearestIdx(S.data[m], now); return i < 0 ? null : S.data[m].temp[i]; }).filter(x => x != null);
  const ct = median(temps);
  const spread = temps.length > 1 ? Math.max(...temps) - Math.min(...temps) : 0;
  const ag = spread <= 1.5 ? ['Alta', '#34c759'] : spread <= 3 ? ['Media', '#ff9f0a'] : ['Baja', '#ff453a'];
  const cat = catAt(now), night = !dayAt(now);
  const feel = consensusAt(now, 'feel'), wind = consensusAt(now, 'wind'), hum = consensusAt(now, 'hum');

  // máx/mín de hoy (mediana entre modelos)
  const dk = (t) => fmt(t, { year: 'numeric', month: '2-digit', day: '2-digit' }), today = dk(Date.now());
  const hiLo = ms.map(m => { const s = S.data[m]; const v = s.t.map((t, i) => dk(t) === today ? s.temp[i] : null).filter(x => x != null); return v.length >= 12 ? [Math.max(...v), Math.min(...v)] : null; }).filter(Boolean);
  const hi = median(hiLo.map(x => x[0])), lo = median(hiLo.map(x => x[1]));
  let html = `<div class="hero-wrap"><div class="hero">
    <div class="t num">${fmtT(ct)}</div>
    <div><div class="ico">${icon(cat, night)}</div></div></div>
  <div class="d">${CAT_TXT[cat] || '—'}</div>
  ${hi != null ? `<div class="hl num">Máx. ${fmtT(hi)}${anom(hi, 'mx')} · Mín. ${fmtT(lo)}${anom(lo, 'mn')}${S.normals ? '<span class="anl">vs. media 1991–2020</span>' : ''}</div>` : ''}
  ${extraLine()}
  <div class="sub num">Sensación ${fmtT(feel)} · Viento ${wind == null ? '–' : Math.round(wind)} km/h · Humedad ${hum == null ? '–' : Math.round(hum)}%</div>
  <div><div class="agree"><i style="background:${ag[1]}"></i>Coincidencia ${ag[0].toLowerCase()} · ${temps.length} modelos · ±${round(spread / 2, 1).toString().replace('.', ',')}°</div></div></div>`;

  // próximas horas y días (consenso entre modelos)
  html += `<div class="sec"><h3>Próximas horas · consenso</h3><div class="card wchart">${hourlyChart(now)}</div></div>`;
  html += `<div class="sec"><h3>Próximos días · consenso</h3><div class="card wchart">${dailyChart()}</div></div>`;

  html += renderExtras(now);

  // por modelo (con gráfico horario desplegable de cada uno)
  const CHEV = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';
  html += `<div class="sec"><h3>Ahora por modelo</h3><div class="card mcard">`;
  for (const m of ORDER) {
    const s = S.data[m]; const M = MODELS[m];
    if (!s || !S.enabled[m]) {
      html += `<div class="row off"><span></span><i class="dot" style="background:${mcolor(m)}"></i><div><div class="nm">${M.name}</div><div class="ds">${M.sub}</div></div><div class="tp">${esc(S.status[m] || 'Sin datos')}</div></div>`;
      continue;
    }
    const i = nearestIdx(s, now);
    const p6 = sumPrecip(m, now, now + 6 * HOUR);
    const label = s.label ? `${M.sub} · ${esc(s.label)}` : M.sub;
    const open = S.openModels.has(m);
    html += `<div class="row${open ? ' open' : ''}" data-exp="${m}" role="button" aria-expanded="${open}" aria-label="Ver gráfico de ${M.name}">
      <span class="exp">${CHEV}</span><i class="dot" style="background:${mcolor(m)}"></i>
      <div style="min-width:0"><div class="nm">${M.name}</div><div class="ds">${label}</div></div>
      <div class="ic">${i < 0 ? '' : icon(s.cat[i], s.day[i] === 0)}</div>
      <div class="tp num">${i < 0 ? '–' : fmtT(s.temp[i])}</div>
      <div class="xt num">${i < 0 || s.wind[i] == null ? '–' : Math.round(s.wind[i]) + ' km/h ' + windDir(s.dir[i])}<br>${p6 == null ? '' : (round(p6, 1) + ' mm/6h').replace('.', ',')}</div></div>
      <div class="mchart" id="mc-${m}">${open ? hourlyChart(now, m) : ''}</div>`;
  }
  html += `</div></div>`;

  // hoy: máx / mín / lluvia
  const todayKey = fmt(Date.now(), { year: 'numeric', month: '2-digit', day: '2-digit' });
  let mx = [], mn = [], pr = [];
  for (const m of ms) {
    const s = S.data[m]; const idx = s.t.map((t, i) => fmt(t, { year: 'numeric', month: '2-digit', day: '2-digit' }) === todayKey ? i : -1).filter(i => i >= 0);
    if (idx.length < 12) continue;
    mx.push(Math.max(...idx.map(i => s.temp[i]))); mn.push(Math.min(...idx.map(i => s.temp[i])));
    pr.push(idx.reduce((a, i) => a + (s.precip[i] || 0), 0));
  }
  if (mx.length) {
    const rng = (a) => a.length > 1 && Math.round(Math.max(...a)) !== Math.round(Math.min(...a)) ? `${Math.round(Math.min(...a))}–${Math.round(Math.max(...a))}°` : fmtT(a[0]);
    html += `<div class="sec"><h3>Hoy · rango entre modelos</h3><div class="mm num">
      <div><span>Máxima</span><b>${rng(mx)}</b></div><div><span>Mínima</span><b>${rng(mn)}</b></div>
      <div><span>Lluvia</span><b>${(round(median(pr), 1) + ' mm').replace('.', ',')}</b></div></div></div>`;
  }
  html += `<p class="note">Temperatura principal: mediana de los modelos disponibles. La coincidencia mide la dispersión de temperatura entre ellos ahora mismo. Índice UV: modelo GFS. Variación de máx./mín.: diferencia con la media de 1991–2020 para este día (reanálisis ERA5, rejilla de ~25 km, por lo que en costa o montaña puede desviarse algo).</p>`;
  v.innerHTML = html;
  v.querySelectorAll('[data-exp]').forEach(r => r.onclick = () => {
    const m = r.dataset.exp, box = $('#mc-' + m), open = !S.openModels.has(m);
    open ? S.openModels.add(m) : S.openModels.delete(m);
    r.classList.toggle('open', open); r.setAttribute('aria-expanded', open);
    box.innerHTML = open ? hourlyChart(floorHour(Date.now() + 30 * 60e3), m) : '';
  });
  // fondo de paisaje acorde al tiempo y la hora
  const todayNoon = zoned(fmt(Date.now(), { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-'), 12, S.tz);
  const sn = sunTimes(todayNoon, S.loc.lat, S.loc.lon);
  Scene.set(cat || 'partly', Date.now(), sn.rise, sn.set).then(syncTheme);
}
function syncTheme() {
  const scenic = document.body.classList.contains('scenic');
  document.querySelectorAll('meta[name=theme-color]').forEach(m => m.setAttribute('content', scenic ? Scene.topColor() : (m.media.includes('dark') ? '#0e0f11' : '#f6f6f4')));
}

function renderExtras(now) {
  const { lat, lon } = S.loc;
  const todayNoon = zoned(fmt(Date.now(), { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-'), 12, S.tz);
  const sun = sunTimes(todayNoon, lat, lon), tom = sunTimes(todayNoon + 864e5, lat, lon), yest = sunTimes(todayNoon - 864e5, lat, lon);
  const nowMs = Date.now(), t2 = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dur = (ms) => { const m = Math.round(ms / 60e3); return `${Math.floor(m / 60)} h ${m % 60} min`; };
  const dmin = (a, b) => { const d = Math.round(((b.set - b.rise) - (a.set - a.rise)) / 60e3); return d === 0 ? 'la misma luz' : `${Math.abs(d)} min ${d > 0 ? 'más' : 'menos'}`; };
  const isDay = nowMs >= sun.rise && nowMs < sun.set;
  // de noche: tramo entre la última puesta y la próxima salida
  const nSet = nowMs >= sun.set ? sun.set : yest.set, nRise = nowMs >= sun.set ? tom.rise : sun.rise;
  const HZ = 40; // horizonte
  let mark = '', left, right, foot;
  if (isDay) {
    const f = (nowMs - sun.rise) / (sun.set - sun.rise);
    const x = 8 + f * 124, y = HZ - Math.sin(f * Math.PI) * 32;
    mark = `<circle cx="${x}" cy="${y}" r="6" fill="#f5b83d"/>`;
    left = ['Salida', t2(sun.rise)]; right = ['Puesta', t2(sun.set)];
    foot = `${dur(sun.set - sun.rise)} de luz hoy<br>Mañana, ${dmin(sun, tom)}`;
  } else {
    const f = (nowMs - nSet) / (nRise - nSet);
    const x = 8 + f * 124, y = HZ + Math.sin(f * Math.PI) * 20;
    mark = `<path transform="translate(${x - 6} ${y - 6})" d="M8.5 0.8a6 6 0 1 0 3.2 9.6 4.6 4.6 0 0 1-3.2-9.6z" fill="var(--ink)" opacity=".85"/>`;
    left = ['Puesta', t2(nSet)]; right = [nRise > todayNoon + 12 * HOUR ? 'Salida mañana' : 'Salida', t2(nRise)];
    const nextDay = nowMs >= sun.set ? tom : sun, prevDay = nowMs >= sun.set ? sun : yest;
    foot = `Amanece en ${dur(nRise - nowMs)}<br>${nowMs >= sun.set ? 'Mañana' : 'Hoy'}: ${dur(nextDay.set - nextDay.rise)} de luz (${dmin(prevDay, nextDay)})`;
  }
  const arc = `<svg viewBox="0 0 140 64" class="arc">
    <path d="M8 ${HZ} Q70 ${HZ - 64} 132 ${HZ}" fill="none" stroke="${isDay ? '#f5b83d' : 'var(--line)'}" stroke-width="1.5" stroke-dasharray="3 3" opacity="${isDay ? .7 : 1}"/>
    <path d="M8 ${HZ} Q70 ${HZ + 40} 132 ${HZ}" fill="none" stroke="${isDay ? 'var(--line)' : 'var(--mute)'}" stroke-width="1.5" stroke-dasharray="3 3" opacity="${isDay ? 1 : .6}"/>
    <line x1="2" x2="138" y1="${HZ}" y2="${HZ}" stroke="var(--mute)" stroke-width=".8" opacity=".6"/>${mark}</svg>`;

  let html = `<div class="sec"><h3>Sol y aire</h3><div class="duo">
    <div class="tile">${arc}
      <div class="sunrow num"><div><span>${left[0]}</span><b>${left[1]}</b></div><div style="text-align:right"><span>${right[0]}</span><b>${right[1]}</b></div></div>
      <div class="foot num">${foot}</div></div>`;

  const a = S.air?.cur;
  if (a && a.european_aqi != null) {
    const lv = aqiLevel(a.european_aqi);
    const i0 = S.air.t.findIndex(t => t >= now);
    const next = i0 < 0 ? [] : S.air.aqi.slice(i0, i0 + 24).filter(x => x != null);
    const worst = next.length ? Math.max(...next) : null;
    const pol = [['PM2,5', a.pm2_5], ['PM10', a.pm10], ['NO₂', a.nitrogen_dioxide], ['O₃', a.ozone]].filter(p => p[1] != null);
    html += `<div class="tile"><span class="lbl">Calidad del aire</span>
      <div class="aqi num"><b>${Math.round(a.european_aqi)}</b><i style="background:${lv[2]}"></i></div>
      <div class="aqil">${lv[1]}</div>
      <div class="aqibar"><i style="left:${Math.min(100, a.european_aqi) }%"></i></div>
      <div class="foot num">${pol.map(p => `${p[0]} ${Math.round(p[1])}`).join(' · ')} µg/m³${worst != null && aqiLevel(worst) !== lv ? `<br>Próx. 24 h: hasta ${aqiLevel(worst)[1].toLowerCase()}` : ''}</div></div>`;
  } else {
    html += `<div class="tile"><span class="lbl">Calidad del aire</span><div class="foot" style="margin-top:20px">No disponible</div></div>`;
  }
  html += `</div></div>`;

  // tormenta
  const st = stormRisk(now);
  const LV = [['Bajo', '#34c759', 'Sin tormentas previstas en las próximas 24 h'], ['Moderado', '#ff9f0a', 'Posibles tormentas'], ['Alto', '#ff453a', 'Tormentas probables']];
  const L = LV[st.lvl];
  const win = st.win ? ` · ${fmt(st.win[0], { weekday: 'short' })} ${hh(st.win[0])}–${hh(st.win[1])}` : '';
  const cells = st.perHour.map((c, k) => `<i title="${hh(now + k * HOUR)}" style="opacity:${c ? 0.35 + 0.65 * c / Math.max(1, st.n) : 1};background:${c ? L[1] : 'var(--soft)'}"></i>`).join('');
  const facts = [
    `${st.who.length}/${st.n} modelos con tormenta${st.who.length ? ' (' + st.who.map(m => MODELS[m].name).join(', ') + ')' : ''}`,
    st.aemetP != null ? `AEMET prob. ${Math.round(st.aemetP)}%` : null,
    st.capeMax != null ? `CAPE máx. ${Math.round(st.capeMax)} J/kg` : null,
    st.liMin != null && st.liMin < 99 ? `Índ. de elevación ${String(round(st.liMin, 1)).replace('.', ',')}` : null,
  ].filter(Boolean);
  html += `<div class="sec"><h3>Tormenta · próximas 24 h</h3><div class="tile storm">
    <div class="sth"><div class="sti" style="color:${L[1]}">${icon('storm')}</div>
      <div><div class="stl">Riesgo ${L[0].toLowerCase()}</div><div class="foot" style="margin:0">${st.lvl ? L[2] + win : L[2]}</div></div></div>
    <div class="cells">${cells}</div>
    <div class="cellax num"><span>${hh(now)}</span><span>${hh(now + 12 * HOUR)}</span><span>${hh(now + 24 * HOUR)}</span></div>
    <div class="foot num">${facts.join(' · ')}</div></div></div>`;
  return html;
}

// ───────────────────────── render: Meteograma ─────────────────────────
function renderMG() {
  const v = $('#v-mg');
  const ms = active();
  if (!ms.length) { v.innerHTML = '<div class="skel">Sin datos.</div>'; return; }
  const start = floorHour(Date.now());
  const end = Math.min(start + 7 * 24 * HOUR, Math.max(...ms.map(m => S.data[m].t.at(-1))));
  const N = Math.round((end - start) / HOUR) + 1;
  const PX = 7, W = N * PX, padTop = 22;
  const vis = ms.filter(m => !S.hidden.has(m));
  const X = (t) => (t - start) / HOUR * PX;

  // escalas
  const allT = vis.flatMap(m => S.data[m].t.map((t, i) => t >= start && t <= end ? S.data[m].temp[i] : null)).filter(x => x != null);
  let tmin = Math.floor(Math.min(...allT) / 2) * 2 - 1, tmax = Math.ceil(Math.max(...allT) / 2) * 2 + 1;
  if (!isFinite(tmin)) { tmin = 0; tmax = 20; }
  const H1 = 170, H2 = 80, H3 = 80, GAP = 44;
  const y0 = padTop, y1 = y0 + H1 + GAP, y2 = y1 + H2 + GAP, HT = y2 + H3 + 6;
  const YT = (v) => y0 + H1 - (v - tmin) / (tmax - tmin) * H1;
  const pr = []; for (let k = 0; k < N; k++) { const t = start + k * HOUR; const vals = vis.map(m => { const i = at(S.data[m], t); return i < 0 ? null : S.data[m].precip[i]; }).filter(x => x != null); pr.push({ med: median(vals), max: vals.length ? Math.max(...vals) : null }); }
  const pmax = Math.max(4, ...pr.map(p => p.max || 0));
  const YP = (v) => y1 + H2 - Math.min(v, pmax) / pmax * H2;
  const allW = vis.flatMap(m => S.data[m].t.map((t, i) => t >= start && t <= end ? Math.max(S.data[m].wind[i] || 0, S.data[m].gust[i] || 0) : 0));
  const wmax = Math.max(30, Math.ceil(Math.max(...allW) / 10) * 10);
  const YW = (v) => y2 + H3 - v / wmax * H3;

  const line = (m, field, Y, extra = '') => {
    const s = S.data[m]; let d = '', prev = null;
    s.t.forEach((t, i) => {
      const val = s[field][i]; if (t < start || t > end || val == null) return;
      d += (prev == null || t - prev > 6 * HOUR ? 'M' : 'L') + X(t).toFixed(1) + ' ' + Y(val).toFixed(1); prev = t;
    });
    return d ? `<path d="${d}" fill="none" stroke="${mcolor(m)}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" ${extra}/>` : '';
  };

  let g = '';
  // fondo noche + separadores de día
  for (let k = 0; k < N; k++) {
    const t = start + k * HOUR;
    if (!dayAt(t)) g += `<rect x="${X(t)}" y="${y0}" width="${PX + .5}" height="${HT - y0}" fill="var(--soft)" opacity=".7"/>`;
    const h = localHour(t);
    if (h === 0) g += `<line x1="${X(t)}" x2="${X(t)}" y1="0" y2="${HT}" stroke="var(--line)"/>`;
    if (h === 0 || (k === 0 && h < 20)) g += `<text x="${X(t) + 4}" y="12" style="font-weight:600;fill:var(--ink)">${fmt(t, { weekday: 'short', day: 'numeric' })}</text>`;
    if (h % 6 === 0 && h) g += `<text x="${X(t)}" y="${y0 + H1 + 14}" text-anchor="middle">${h}h</text>`;
  }
  // rejilla temperatura
  for (let v = tmin; v <= tmax; v += (tmax - tmin > 16 ? 4 : 2)) g += `<line x1="0" x2="${W}" y1="${YT(v)}" y2="${YT(v)}" stroke="var(--line)" stroke-width=".6"/>`;
  // banda min–max entre modelos
  if (vis.length > 1) {
    const up = [], dn = [];
    for (let k = 0; k < N; k++) { const t = start + k * HOUR; const vals = vis.map(m => { const i = at(S.data[m], t); return i < 0 ? null : S.data[m].temp[i]; }).filter(x => x != null); if (vals.length > 1) { up.push([X(t), YT(Math.max(...vals))]); dn.push([X(t), YT(Math.min(...vals))]); } }
    if (up.length) g += `<path d="M${up.map(p => p.join(' ')).join('L')}L${dn.reverse().map(p => p.join(' ')).join('L')}Z" fill="var(--ink)" opacity=".06"/>`;
  }
  vis.forEach(m => g += line(m, 'temp', YT));
  // precipitación
  g += `<line x1="0" x2="${W}" y1="${y1 + H2}" y2="${y1 + H2}" stroke="var(--line)"/>`;
  g += `<text x="${($('#mgsc')?.scrollLeft || 0) + 4}" y="${y1 - 8}" class="ptl" style="font-weight:600">Precipitación · mm/h</text>`;
  pr.forEach((p, k) => {
    const x = k * PX + 1;
    if (p.max > 0.05) g += `<rect x="${x}" y="${YP(p.max)}" width="${PX - 2}" height="${y1 + H2 - YP(p.max)}" rx="1" fill="${mcolor('arome')}" opacity=".25"/>`;
    if (p.med > 0.05) g += `<rect x="${x}" y="${YP(p.med)}" width="${PX - 2}" height="${y1 + H2 - YP(p.med)}" rx="1" fill="${mcolor('arome')}"/>`;
  });
  // viento
  g += `<line x1="0" x2="${W}" y1="${y2 + H3}" y2="${y2 + H3}" stroke="var(--line)"/>`;
  g += `<text x="4" y="${y2 - 8}" class="ptl" style="font-weight:600">Viento · km/h (rachas punteadas)</text>`;
  vis.forEach(m => { g += line(m, 'gust', YW, 'stroke-dasharray="2 3" opacity=".6"'); g += line(m, 'wind', YW); });
  // ahora
  const xn = X(Date.now());
  g += `<line x1="${xn}" x2="${xn}" y1="${y0}" y2="${HT}" stroke="var(--ink)" stroke-width="1" opacity=".5"/>`;
  g += `<line id="cursor" x1="-10" x2="-10" y1="${y0}" y2="${HT}" stroke="var(--ink)" stroke-width="1.2"/>`;

  // ejes Y
  let ya = '';
  for (let v = tmin; v <= tmax; v += (tmax - tmin > 16 ? 4 : 2)) ya += `<text x="28" y="${YT(v) + 3}" text-anchor="end">${v}°</text>`;
  ya += `<text x="28" y="${y1 + 4}" text-anchor="end">${pmax}</text><text x="28" y="${y1 + H2}" text-anchor="end">0</text>`;
  ya += `<text x="28" y="${y2 + 4}" text-anchor="end">${wmax}</text><text x="28" y="${y2 + H3}" text-anchor="end">0</text>`;

  const chips = ORDER.map(m => {
    const has = !!S.data[m] && S.enabled[m];
    return `<button class="chip ${!has || S.hidden.has(m) ? 'off' : ''}" data-m="${m}" ${has ? '' : 'disabled'}><i style="background:${mcolor(m)}"></i>${MODELS[m].name}</button>`;
  }).join('');

  v.innerHTML = `<div class="legend">${chips}</div>
    <div class="readout num" id="ro">Desliza sobre el gráfico para comparar los modelos hora a hora.</div>
    <div class="mg"><svg class="yax" width="34" height="${HT}">${ya}</svg>
      <div class="sc" id="mgsc"><svg id="mgsvg" width="${W}" height="${HT}" style="display:block">${g}</svg></div></div>
    <p class="note">Líneas: un color por modelo · banda gris: rango entre modelos · barras: mediana de precipitación (sólida) y máximo de cualquier modelo (clara) · fondo sombreado: noche. AROME llega a ~2 días, AEMET a ~3; ECMWF e ICON completan la semana.</p>`;

  v.querySelectorAll('.chip').forEach(b => b.onclick = () => { const m = b.dataset.m; S.hidden.has(m) ? S.hidden.delete(m) : S.hidden.add(m); LS.set('hidden', [...S.hidden]); const sl = $('#mgsc').scrollLeft; renderMG(); $('#mgsc').scrollLeft = sl; });
  const svg = $('#mgsvg'), cur = $('#cursor'), ro = $('#ro');
  const sc = $('#mgsc'); sc.addEventListener('scroll', () => svg.querySelectorAll('.ptl').forEach(t => t.setAttribute('x', sc.scrollLeft + 4)), { passive: true });
  const scrub = (ev) => {
    const r = svg.getBoundingClientRect(); const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    const k = Math.max(0, Math.min(N - 1, Math.floor(x / PX))); const t = start + k * HOUR;
    cur.setAttribute('x1', k * PX + PX / 2); cur.setAttribute('x2', k * PX + PX / 2);
    const parts = ms.filter(m => !S.hidden.has(m)).map(m => { const i = at(S.data[m], t); if (i < 0) return ''; const s = S.data[m]; return `<span><b style="color:${mcolor(m)}">${MODELS[m].name}</b> ${fmtT(s.temp[i])}${s.precip[i] >= 0.1 ? ' · ' + String(round(s.precip[i], 1)).replace('.', ',') + 'mm' : ''}${s.wind[i] != null ? ' · ' + Math.round(s.wind[i]) : ''}</span>`; }).filter(Boolean);
    ro.innerHTML = `<span><b>${fmt(t, { weekday: 'short', day: 'numeric' })} ${hh(t)}</b></span>` + parts.join('');
  };
  svg.addEventListener('pointerdown', scrub); svg.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' || e.buttons) scrub(e); });
  svg.addEventListener('click', scrub);
}

// ───────────────────────── render: Mapa ─────────────────────────
const MAP = { map: null, marker: null, labels: null, radar: null, radarOn: false, frames: [], play: null, radarAt: 0, model: LS.get('mapModel', 'arome'), cache: {} };
function initMap() {
  if (MAP.map) { if (Date.now() - MAP.radarAt > 10 * 60e3) loadRadar(); return; }
  if (!window.L) { toast('El mapa necesita conexión la primera vez'); return; }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  MAP.map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 4, maxZoom: 11, zoomSnap: 0.5, bounceAtZoomLimits: false })
    .setView([S.loc.lat, S.loc.lon], 7); // x4 respecto a la vista de toda España (zoom 5)
  baseLayers(dark).forEach(l => l.addTo(MAP.map));
  MAP.map.on('click', (e) => setLocation({ lat: e.latlng.lat, lon: e.latlng.lng, name: null }));
  placeMarker();
  $('#mapt').oninput = () => { stopPlay(); showFrame(+$('#mapt').value); };
  $('#play').onclick = togglePlay; $('#play').innerHTML = PLAY_ICON;
  loadRadar();
}
// Cartografía base: CARTO si hay clave (gratuita, carto.com/basemaps/apikey); si no, Esri Canvas, que no necesita clave
function baseLayers(dark) {
  const key = (S.keys.carto || '').trim();
  if (key) return [L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/${dark ? 'dark' : 'light'}_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
    { attribution: '© OpenStreetMap · © CARTO', maxZoom: 19 })];
  const g = dark ? 'Dark' : 'Light', base = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_' + g + '_Gray_';
  return [
    L.tileLayer(base + 'Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri, HERE, Garmin, © OpenStreetMap', maxNativeZoom: 16, maxZoom: 19 }),
    L.tileLayer(base + 'Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, opacity: dark ? 0.75 : 0.9 }),
  ];
}
function placeMarker() {
  if (!MAP.map) return;
  if (MAP.centeredOn !== S.loc.lat + ',' + S.loc.lon) { MAP.centeredOn = S.loc.lat + ',' + S.loc.lon; MAP.map.setView([S.loc.lat, S.loc.lon], Math.max(MAP.map.getZoom(), 7)); }
  const ll = [S.loc.lat, S.loc.lon];
  if (!MAP.marker) MAP.marker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 }).addTo(MAP.map);
  else MAP.marker.setLatLng(ll);
}
// Radar (RainViewer): solo ofrece las últimas 2 horas, en imágenes cada 10 minutos; no hay predicción.
function setSlider(min, max, val) { const r = $('#mapt'); r.min = min; r.max = max; r.value = val; }
function radarLayer(f) {
  return L.tileLayer(`${MAP.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    opacity: 0.75, maxNativeZoom: 7, maxZoom: 11, updateWhenZooming: false, keepBuffer: 0, attribution: 'Radar © RainViewer' });
}
function showFrame(k) {
  const f = MAP.frames[k]; if (!f || !MAP.map) return;
  // una sola capa de radar en pantalla: la nueva se añade y la anterior se quita al cargar
  const prev = MAP.radar, next = radarLayer(f);
  MAP.radar = next; next.addTo(MAP.map);
  if (prev) { const drop = () => { if (MAP.map.hasLayer(prev)) MAP.map.removeLayer(prev); }; next.once('load', drop); setTimeout(drop, 1500); }
  const ago = Math.round((Date.now() - f.time) / 60e3);
  $('#mapt-l').innerHTML = `<b>${fmt(f.time, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</b>${k === MAP.frames.length - 1 ? ' · última imagen' : ` · hace ${ago} min`}`;
}
const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.8v10.4L12 7z"/></svg>';
const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2.5" y="2" width="3" height="10" rx="1"/><rect x="8.5" y="2" width="3" height="10" rx="1"/></svg>';
function stopPlay() { clearInterval(MAP.play); MAP.play = null; $('#play').innerHTML = PLAY_ICON; }
function togglePlay() {
  if (MAP.play) return stopPlay();
  if (!MAP.frames.length) return;
  $('#play').innerHTML = PAUSE_ICON;
  MAP.play = setInterval(() => { const r = $('#mapt'); const v = (+r.value + 1) % MAP.frames.length; r.value = v; showFrame(v); }, 1000);
}
async function loadRadar() {
  stopPlay();
  try {
    const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
    const frames = [...(j.radar?.past || []), ...(j.radar?.nowcast || [])];
    if (!frames.length) throw new Error('vacío');
    MAP.host = j.host;
    MAP.frames = frames.map(f => ({ time: f.time * 1000, path: f.path }));
    MAP.radarAt = Date.now();
    setSlider(0, MAP.frames.length - 1, MAP.frames.length - 1);
    showFrame(MAP.frames.length - 1);
  } catch { toast('Radar no disponible'); $('#mapt-l').textContent = 'Sin radar'; }
}

// ───────────────────────── navegación / UI ─────────────────────────
function show(view) {
  S.view = view; LS.set('view', view);
  document.body.classList.toggle('scenic', view === 'now');
  if (view === 'now') Scene.start(); else Scene.stop();
  syncTheme();
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + view));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  if (view === 'map') { initMap(); setTimeout(() => MAP.map && MAP.map.invalidateSize(), 50); }
  if (view === 'mg' && Object.keys(S.data).length) renderMG();
}
function render() {
  updateFavBtn();
  $('#pname').textContent = S.loc.name || `${S.loc.lat.toFixed(2)}, ${S.loc.lon.toFixed(2)}`;
  const n = active().length;
  $('#pstat').textContent = S.fetchedAt ? `${n} modelos · actualizado ${new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(S.fetchedAt)}` : '';
  renderNow();
  if (S.view === 'mg') renderMG();
  placeMarker();
}
// ───────────────────────── favoritas ─────────────────────────
const STAR = (on) => `<svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>`;
S.favs = LS.get('favs', []);
const sameLoc = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
const favIndex = (loc = S.loc) => S.favs.findIndex(f => sameLoc(f, loc));
const FAVWX = { at: 0, key: '', list: [] };
function updateFavBtn() { const on = favIndex() >= 0; const b = $('#btn-fav'); b.innerHTML = STAR(on); b.classList.toggle('on', on); b.setAttribute('aria-label', on ? 'Quitar de favoritas' : 'Guardar en favoritas'); }
function toggleFav() {
  const i = favIndex();
  if (i >= 0) { S.favs.splice(i, 1); toast(`${S.loc.name} eliminada de favoritas`); }
  else { S.favs.push({ name: S.loc.name, admin: S.loc.admin || '', lat: S.loc.lat, lon: S.loc.lon }); toast(`${S.loc.name} guardada en favoritas`); }
  LS.set('favs', S.favs); updateFavBtn();
}
async function loadFavWeather() {
  const key = S.favs.map(f => f.lat.toFixed(2) + ',' + f.lon.toFixed(2)).join(';');
  if (!S.favs.length || (key === FAVWX.key && Date.now() - FAVWX.at < 15 * 60e3)) return;
  try {
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${S.favs.map(f => f.lat).join(',')}&longitude=${S.favs.map(f => f.lon).join(',')}&current=temperature_2m,weather_code,is_day&timezone=auto`);
    FAVWX.list = Array.isArray(j) ? j : [j]; FAVWX.key = key; FAVWX.at = Date.now();
  } catch { /* sin conexión: la lista se muestra sin tiempo */ }
}
let favEdit = false;
function renderFavs() {
  const box = $('#favs');
  box.classList.toggle('edit', favEdit);
  if (!S.favs.length) {
    box.innerHTML = `<div class="favh"><h3>Favoritas</h3></div><div class="favempty">Aún no tienes favoritas. Toca la ${STAR(false).replace('<svg', '<svg width="13" height="13" style="vertical-align:-2px"')} junto al nombre de la población para guardarla aquí.</div>`;
    return;
  }
  const wxOk = FAVWX.key === S.favs.map(f => f.lat.toFixed(2) + ',' + f.lon.toFixed(2)).join(';');
  box.innerHTML = `<div class="favh"><h3>Favoritas</h3><button id="fav-edit">${favEdit ? 'Hecho' : 'Editar'}</button></div><div class="card">` +
    S.favs.map((f, i) => {
      const w = wxOk ? FAVWX.list[i]?.current : null;
      return `<div class="fav"><button class="del" data-del="${i}" aria-label="Eliminar ${esc(f.name)}"><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="2"><path d="M2.5 6h7"/></svg></button>
        <button class="go" data-go="${i}">${sameLoc(f, S.loc) ? '<i class="cur"></i>' : ''}<div style="min-width:0"><div class="nm">${esc(f.name)}</div><div class="ad">${esc(f.admin || `${f.lat.toFixed(2)}, ${f.lon.toFixed(2)}`)}</div></div></button>
        <div class="wx num">${w ? icon(catWMO(w.weather_code), w.is_day === 0) + fmtT(w.temperature_2m) : ''}</div>
        <button class="mv" data-up="${i}" aria-label="Subir" ${i ? '' : 'style="visibility:hidden"'}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7.5l3-3 3 3"/></svg></button></div>`;
    }).join('') + `</div>`;
  $('#fav-edit').onclick = () => { favEdit = !favEdit; renderFavs(); };
  box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { if (favEdit) return; const f = S.favs[+b.dataset.go]; setLocation({ ...f }); });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.favs.splice(+b.dataset.del, 1); LS.set('favs', S.favs); updateFavBtn(); renderFavs(); });
  box.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; [S.favs[i - 1], S.favs[i]] = [S.favs[i], S.favs[i - 1]]; LS.set('favs', S.favs); FAVWX.key = ''; renderFavs(); });
}
async function openLocSheet() {
  favEdit = false; renderFavs(); openSheet('#sh-loc');
  await loadFavWeather(); renderFavs();
}

async function setLocation(loc) {
  if (!loc.name) {
    loc.name = `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`;
    try {
      const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${loc.lat}&lon=${loc.lon}&zoom=10&accept-language=es`);
      const a = j.address || {}; loc.name = a.city || a.town || a.village || a.municipality || a.county || loc.name; loc.admin = a.state || '';
    } catch {}
  }
  S.loc = loc; LS.set('loc', loc); closeSheets();
  $('#pname').textContent = loc.name;
  updateFavBtn();
  placeMarker();
  load(true);
}

// sheets
function openSheet(id) { $('#sheet-bg').style.display = 'block'; requestAnimationFrame(() => $(id).classList.add('on')); }
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => s.classList.remove('on')); $('#sheet-bg').style.display = 'none'; }
$('#sheet-bg').onclick = closeSheets;
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
$('#place').onclick = openLocSheet;
$('#btn-fav').onclick = toggleFav;
$('#btn-refresh').onclick = () => { load(true); if (MAP.map) loadRadar(); };
$('#btn-gps').onclick = () => {
  if (!navigator.geolocation) return toast('Geolocalización no disponible');
  navigator.geolocation.getCurrentPosition(p => setLocation({ lat: p.coords.latitude, lon: p.coords.longitude, name: null }),
    () => toast('Permiso de ubicación denegado'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
};
let qT;
$('#q').oninput = (e) => {
  clearTimeout(qT); const q = e.target.value.trim(); if (q.length < 2) { $('#res').innerHTML = ''; return; }
  qT = setTimeout(async () => {
    try {
      const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=es&countryCode=ES`);
      const r = j.results || [];
      $('#res').innerHTML = r.length ? r.map((x, i) => `<button data-i="${i}">${esc(x.name)} <span>${esc([x.admin2, x.admin1].filter(Boolean).join(', '))}</span></button>`).join('') : '<p class="note">Sin resultados</p>';
      $('#res').querySelectorAll('button').forEach(b => b.onclick = () => { const x = r[+b.dataset.i]; setLocation({ lat: x.latitude, lon: x.longitude, name: x.name, admin: x.admin1 }); $('#q').value = ''; $('#res').innerHTML = ''; });
    } catch { $('#res').innerHTML = '<p class="note">Sin conexión</p>'; }
  }, 280);
};
$('#btn-set').onclick = () => {
  $('#k-aemet').value = S.keys.aemet; $('#k-carto').value = S.keys.carto || ''; $('#k-proxy').value = S.keys.proxy;
  $('#mtog').innerHTML = ORDER.map(m => `<div class="tog"><span><i class="dot" style="display:inline-block;margin-right:8px;background:${mcolor(m)}"></i>${MODELS[m].name} <span style="color:var(--mute);font-size:12px">${MODELS[m].sub}</span></span><button class="sw ${S.enabled[m] ? 'on' : ''}" data-m="${m}" aria-label="${MODELS[m].name}"></button></div>`).join('');
  $('#mtog').querySelectorAll('.sw').forEach(b => b.onclick = () => b.classList.toggle('on'));
  openSheet('#sh-set');
};
$('#btn-save').onclick = () => {
  S.keys = { aemet: $('#k-aemet').value.trim(), proxy: $('#k-proxy').value.trim(), carto: $('#k-carto').value.trim() };
  $('#mtog').querySelectorAll('.sw').forEach(b => S.enabled[b.dataset.m] = b.classList.contains('on'));
  const mapChanged = (LS.get('keys', {}).carto || '') !== S.keys.carto;
  LS.set('keys', S.keys); LS.set('enabled', S.enabled);
  if (mapChanged && MAP.map) { MAP.map.eachLayer(l => { if (l instanceof L.TileLayer && l !== MAP.radar) MAP.map.removeLayer(l); }); baseLayers(matchMedia('(prefers-color-scheme: dark)').matches).forEach(l => l.addTo(MAP.map).bringToBack()); }
  closeSheets(); load(true);
};
// gesto: deslizar la hoja hacia abajo para cerrar
document.querySelectorAll('.sheet').forEach(sh => {
  let y0 = null;
  sh.addEventListener('touchstart', e => { if (sh.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 != null && e.touches[0].clientY - y0 > 80) { y0 = null; closeSheets(); } }, { passive: true });
  sh.addEventListener('touchend', () => y0 = null);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.fetchedAt && Date.now() - S.fetchedAt > 20 * 60e3) load(true); });

// ───────────────────────── arranque ─────────────────────────
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
show(S.view);
load();
