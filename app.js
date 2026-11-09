/* Cielo — PWA del tiempo multimodelo para España
   Fuentes: AEMET OpenData (predicción municipal horaria), Meteocat (predicció municipal horària),
   Open-Meteo (AROME Météo-France, ECMWF IFS, DWD ICON). */
'use strict';

// ───────────────────────── configuración ─────────────────────────
const MODELS = {
  aemet:    { name: 'AEMET',    sub: 'Predicción municipal',   css: '--m-aemet' },
  arome:    { name: 'AROME',    sub: 'Météo-France · 2,5 km',  css: '--m-arome' },
  meteocat: { name: 'Meteocat', sub: 'Predicció municipal',    css: '--m-meteocat' },
  ecmwf:    { name: 'ECMWF',    sub: 'IFS · 0,25°',            css: '--m-ecmwf' },
  icon:     { name: 'ICON',     sub: 'DWD · seamless',         css: '--m-icon' },
};
const ORDER = ['aemet', 'arome', 'meteocat', 'ecmwf', 'icon'];
const OM_MODELS = { arome: 'meteofrance_arome_france', ecmwf: 'ecmwf_ifs025', icon: 'icon_seamless' };
const OM_VARS = 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,cloud_cover,is_day,cape,lifted_index,lightning_potential';
const CAT_BBOX = { s: 40.50, n: 42.90, w: 0.15, e: 3.35 };
const HOUR = 3600e3;

const CITIES = [
  ['A Coruña',43.37,-8.40],['Oviedo',43.36,-5.85],['Santander',43.46,-3.80],['Bilbao',43.26,-2.93],['Donostia',43.32,-1.98],
  ['Pamplona',42.81,-1.64],['Logroño',42.47,-2.45],['Vigo',42.24,-8.72],['Lugo',43.01,-7.56],['Ourense',42.34,-7.86],['León',42.60,-5.57],
  ['Burgos',42.34,-3.70],['Huesca',42.14,-0.41],['Girona',41.98,2.82],['Lleida',41.62,0.62],['Barcelona',41.39,2.17],['Tarragona',41.12,1.25],
  ['Zaragoza',41.65,-0.88],['Soria',41.76,-2.46],['Valladolid',41.65,-4.72],['Zamora',41.50,-5.75],['Salamanca',40.96,-5.66],['Segovia',40.95,-4.12],
  ['Madrid',40.42,-3.70],['Guadalajara',40.63,-3.16],['Teruel',40.34,-1.11],['Castelló',39.99,-0.05],['Cuenca',40.07,-2.14],['Cáceres',39.47,-6.37],
  ['Toledo',39.86,-4.03],['València',39.47,-0.38],['Palma',39.57,2.65],['Maó',39.89,4.27],['Eivissa',38.91,1.43],['Badajoz',38.88,-6.97],
  ['Ciudad Real',38.98,-3.93],['Albacete',38.99,-1.86],['Alacant',38.35,-0.48],['Murcia',37.99,-1.13],['Córdoba',37.88,-4.78],['Jaén',37.78,-3.79],
  ['Huelva',37.26,-6.95],['Sevilla',37.39,-5.98],['Granada',37.18,-3.60],['Almería',36.84,-2.46],['Málaga',36.72,-4.42],['Cádiz',36.53,-6.29],
  ['Ceuta',35.89,-5.32],['Melilla',35.29,-2.94],['Sta. Cruz de Tenerife',28.47,-16.25],['Las Palmas',28.12,-15.43],['Arrecife',28.96,-13.55],
  ['Pto. del Rosario',28.50,-13.86],['S. Sebastián Gomera',28.09,-17.11],['Sta. Cruz de La Palma',28.68,-17.76],['Valverde',27.81,-17.92],
];

// ───────────────────────── estado ─────────────────────────
const LS = {
  get(k, d) { try { const v = localStorage.getItem('cielo.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cielo.' + k, JSON.stringify(v)); } catch {} },
};
const S = {
  loc: LS.get('loc', { name: 'Madrid', admin: 'Comunidad de Madrid', lat: 40.4168, lon: -3.7038 }),
  keys: LS.get('keys', { aemet: '', meteocat: '', proxy: '' }),
  enabled: LS.get('enabled', { aemet: true, arome: true, meteocat: true, ecmwf: true, icon: true }),
  data: {},       // modelo -> serie normalizada
  status: {},     // modelo -> mensaje si no hay datos
  tz: 'Europe/Madrid',
  view: LS.get('view', 'now'),
  hidden: new Set(LS.get('hidden', [])), // ocultos en meteograma
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
function catMeteocat(v) { // símbolos de estat del cel de Meteocat (aproximado)
  const c = parseInt(v, 10); if (isNaN(c)) return null;
  const map = { 1: 'clear', 2: 'clear', 3: 'partly', 4: 'partly', 20: 'partly', 21: 'cloudy', 22: 'overcast', 5: 'cloudy', 6: 'drizzle', 7: 'drizzle',
    8: 'storm', 9: 'storm', 10: 'rain', 11: 'fog', 12: 'fog', 23: 'rain', 24: 'rain', 25: 'storm', 26: 'snow', 27: 'snow', 28: 'snow', 29: 'snow', 30: 'rain', 31: 'storm', 32: 'storm', 33: 'storm' };
  return map[c] || null;
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
  const want = Object.keys(OM_MODELS).filter(m => S.enabled[m]);
  if (!want.length) return {};
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${OM_VARS}`
    + `&models=${want.map(m => OM_MODELS[m]).join(',')}&timezone=auto&timeformat=unixtime&forecast_days=7&wind_speed_unit=kmh`;
  const j = await getJSON(url);
  if (j.timezone) S.tz = j.timezone;
  const h = j.hourly, out = {};
  for (const m of want) {
    const sfx = want.length > 1 ? '_' + OM_MODELS[m] : '';
    const g = (v) => h[v + sfx] || [];
    const map = new Map();
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
    else S.status[m] = m === 'arome' ? 'Fuera del dominio AROME' : 'Sin datos';
  }
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

// Meteocat
async function meteocat(path) {
  const p = proxy();
  if (!p && !S.keys.meteocat) throw new Error('nokey');
  return p ? getJSON(`${p}/meteocat${path}`) : getJSON(`https://api.meteo.cat${path}`, { headers: { 'X-Api-Key': S.keys.meteocat } });
}
async function fetchMeteocat(lat, lon) {
  if (lat < CAT_BBOX.s || lat > CAT_BBOX.n || lon < CAT_BBOX.w || lon > CAT_BBOX.e) throw new Error('fuera');
  let list = LS.get('meteocat.mun', null);
  if (!list || list.length < 500) {
    const raw = await meteocat('/referencia/v1/municipis');
    list = raw.map(m => [m.codi, +m.coordenades?.latitud, +m.coordenades?.longitud, m.nom]).filter(m => !isNaN(m[1]));
    LS.set('meteocat.mun', list);
  }
  const nn = nearest(list, lat, lon);
  if (!nn || nn.km > 12) throw new Error('fuera');
  const j = await meteocat('/pronostic/v1/municipalHoraria/' + nn.m[0]);
  const map = new Map();
  const KEY = { temp: 'temp', tempXafogor: 'feel', precipitacio: 'precip', humitat: 'hum', velVent: 'wind', dirVent: 'dir', estatCel: 'cat' };
  for (const d of j.dies || []) {
    for (const [name, obj] of Object.entries(d.variables || {})) {
      const k = KEY[name]; if (!k) continue;
      const arr = obj.valors || obj.valor || [];
      const ms = /m\/s/.test(obj.unitat || '') ? 3.6 : 1;
      for (const x of arr) {
        const t = floorHour(Date.parse(x.data)); if (isNaN(t)) continue;
        if (!map.has(t)) map.set(t, {});
        let v = x.valor;
        if (k === 'cat') v = catMeteocat(v);
        else { v = parseFloat(v); if (isNaN(v)) v = null; else if (k === 'wind') v *= ms; }
        map.get(t)[k] = v;
      }
    }
  }
  for (const [t, o] of map) if (o.temp == null) map.delete(t);
  const s = fromMap(map); s.label = nn.m[3];
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
    S.data = cache.data; S.status = cache.status; S.tz = cache.tz; S.air = cache.air; S.fetchedAt = cache.at; render(); return;
  }
  $('#pstat').textContent = 'Actualizando…';
  S.status = {};
  const jobs = [
    fetchOpenMeteo(lat, lon).then(r => r, e => { ['arome', 'ecmwf', 'icon'].forEach(m => S.status[m] = 'Error de red'); return {}; }),
    S.enabled.aemet ? fetchAEMET(lat, lon).then(r => ({ aemet: r }), e => { S.status.aemet = e.message === 'nokey' ? 'Añade la API key en Ajustes' : e.message === 'lejos' ? 'Sin municipio cercano' : (e instanceof TypeError ? 'Bloqueado (CORS): usa proxy' : 'Error: ' + e.message); return {}; }) : Promise.resolve({}),
    S.enabled.meteocat ? fetchMeteocat(lat, lon).then(r => ({ meteocat: r }), e => { S.status.meteocat = e.message === 'fuera' ? 'Solo Catalunya' : e.message === 'nokey' ? 'Añade la API key en Ajustes' : (e instanceof TypeError ? 'Bloqueado (CORS): usa proxy' : 'Error: ' + e.message); return {}; }) : Promise.resolve({}),
  ];
  const airJob = fetchAir(lat, lon).then(a => { S.air = a; }, () => { S.air = null; });
  const res = await Promise.all(jobs); await airJob;
  S.data = Object.assign({}, ...res);
  for (const m of ORDER) if (!S.enabled[m]) S.status[m] = 'Desactivado';
  S.fetchedAt = Date.now();
  if (Object.keys(S.data).length) LS.set('cache', { key, at: S.fetchedAt, data: S.data, status: S.status, tz: S.tz, air: S.air });
  else if (cache && cache.key === key) { S.data = cache.data; S.tz = cache.tz; S.air = cache.air; S.fetchedAt = cache.at; toast('Sin conexión: mostrando la última predicción'); }
  render();
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

// ───────────────────────── render: Ahora ─────────────────────────
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

  let html = `<div class="hero">
    <div class="t num">${fmtT(ct)}</div>
    <div><div class="ico">${icon(cat, night)}</div></div></div>
  <div class="d">${CAT_TXT[cat] || '—'}</div>
  <div class="sub num">Sensación ${fmtT(feel)} · Viento ${wind == null ? '–' : Math.round(wind)} km/h · Humedad ${hum == null ? '–' : Math.round(hum)}%</div>
  <div class="agree"><i style="background:${ag[1]}"></i>Coincidencia ${ag[0].toLowerCase()} · ${temps.length} modelos · ±${round(spread / 2, 1).toString().replace('.', ',')}°</div>`;

  // próximas 24 h (consenso)
  html += `<div class="sec"><h3>Próximas horas · consenso</h3><div class="card strip">`;
  for (let k = 0; k < 24; k++) {
    const t = now + k * HOUR; const tc = consensusAt(t, 'temp'); if (tc == null) continue;
    const p = consensusAt(t, 'precip'); const c = catAt(t);
    html += `<div class="h num">${k ? hh(t) : 'Ahora'}${icon(c, !dayAt(t))}<b>${fmtT(tc)}</b><div class="p">${p >= 0.1 ? round(p, 1).toString().replace('.', ',') : ''}</div></div>`;
  }
  html += `</div></div>`;

  html += renderExtras(now);

  // por modelo
  html += `<div class="sec"><h3>Ahora por modelo</h3><div class="card">`;
  for (const m of ORDER) {
    const s = S.data[m]; const M = MODELS[m];
    if (!s || !S.enabled[m]) {
      html += `<div class="row off"><i class="dot" style="background:${mcolor(m)}"></i><div><div class="nm">${M.name}</div><div class="ds">${M.sub}</div></div><div class="tp">${esc(S.status[m] || 'Sin datos')}</div></div>`;
      continue;
    }
    const i = nearestIdx(s, now);
    const p6 = sumPrecip(m, now, now + 6 * HOUR);
    const label = s.label ? `${M.sub} · ${esc(s.label)}` : M.sub;
    html += `<div class="row"><i class="dot" style="background:${mcolor(m)}"></i>
      <div style="min-width:0"><div class="nm">${M.name}</div><div class="ds">${label}</div></div>
      <div class="ic">${i < 0 ? '' : icon(s.cat[i], s.day[i] === 0)}</div>
      <div class="tp num">${i < 0 ? '–' : fmtT(s.temp[i])}</div>
      <div class="xt num">${i < 0 || s.wind[i] == null ? '–' : Math.round(s.wind[i]) + ' km/h ' + windDir(s.dir[i])}<br>${p6 == null ? '' : (round(p6, 1) + ' mm/6h').replace('.', ',')}</div></div>`;
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
  html += `<p class="note">Temperatura principal: mediana de los modelos disponibles. La coincidencia mide la dispersión de temperatura entre ellos ahora mismo.</p>`;
  v.innerHTML = html;
}

function renderExtras(now) {
  const { lat, lon } = S.loc;
  const todayNoon = zoned(fmt(Date.now(), { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-'), 12, S.tz);
  const sun = sunTimes(todayNoon, lat, lon), tom = sunTimes(todayNoon + 864e5, lat, lon);
  const len = sun.set - sun.rise, lenStr = `${Math.floor(len / HOUR)} h ${Math.round(len % HOUR / 60e3)} min`;
  const diff = Math.round(((tom.set - tom.rise) - len) / 60e3);
  // arco solar
  const f = Math.max(0, Math.min(1, (Date.now() - sun.rise) / len)), up = Date.now() > sun.rise && Date.now() < sun.set;
  const ax = 8 + f * 124, ay = 52 - Math.sin(f * Math.PI) * 40;
  const arc = `<svg viewBox="0 0 140 58" class="arc"><path d="M8 52 Q70 -28 132 52" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-dasharray="3 3"/>
    <line x1="2" x2="138" y1="52" y2="52" stroke="var(--line)"/>${up ? `<circle cx="${ax}" cy="${ay}" r="6" fill="#f5b83d"/>` : ''}</svg>`;
  const t2 = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  let html = `<div class="sec"><h3>Sol y aire</h3><div class="duo">
    <div class="tile">${arc}
      <div class="sunrow num"><div><span>Salida</span><b>${t2(sun.rise)}</b></div><div style="text-align:right"><span>Puesta</span><b>${t2(sun.set)}</b></div></div>
      <div class="foot num">${lenStr} de luz · ${diff >= 0 ? '+' : '−'}${Math.abs(diff)} min mañana</div></div>`;

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
    if (h === 0 || k === 0) g += `<text x="${X(t) + 4}" y="12" style="font-weight:600;fill:var(--ink)">${fmt(t, { weekday: 'short', day: 'numeric' })}</text>`;
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
    <p class="note">Líneas: un color por modelo · banda gris: rango entre modelos · barras: mediana de precipitación (sólida) y máximo de cualquier modelo (clara) · fondo sombreado: noche. AROME llega a ~2 días, AEMET y Meteocat a ~3; ECMWF e ICON completan la semana.</p>`;

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
const MAP = { map: null, marker: null, labels: null, radar: null, radarOn: false, model: LS.get('mapModel', 'arome'), cache: {} };
const MAP_MODELS = { arome: 'AROME', ecmwf: 'ECMWF', icon: 'ICON' };
function initMap() {
  const seg = $('#mapmodel');
  if (!seg.children.length) {
    seg.innerHTML = Object.entries(MAP_MODELS).map(([k, n]) => `<button data-m="${k}" class="${k === MAP.model ? 'on' : ''}">${n}</button>`).join('');
    seg.querySelectorAll('button').forEach(b => b.onclick = () => { MAP.model = b.dataset.m; LS.set('mapModel', MAP.model); seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); loadMapTemps(); });
  }
  if (MAP.map) return;
  if (!window.L) { toast('El mapa necesita conexión la primera vez'); return; }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  MAP.map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 4, maxZoom: 12 }).setView([40.2, -3.6], 5);
  baseLayers(dark).forEach(l => l.addTo(MAP.map));
  MAP.labels = L.layerGroup().addTo(MAP.map);
  MAP.map.on('click', (e) => setLocation({ lat: e.latlng.lat, lon: e.latlng.lng, name: null }));
  placeMarker();
  $('#mapt').oninput = drawMapTemps;
  $('#radar').onclick = toggleRadar;
  loadMapTemps();
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
  const ll = [S.loc.lat, S.loc.lon];
  if (!MAP.marker) MAP.marker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 }).addTo(MAP.map);
  else MAP.marker.setLatLng(ll);
}
async function loadMapTemps() {
  const m = MAP.model;
  const fresh = MAP.cache[m] && Date.now() - MAP.cache[m].at < 30 * 60e3;
  if (!fresh) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${CITIES.map(c => c[1]).join(',')}&longitude=${CITIES.map(c => c[2]).join(',')}`
        + `&hourly=temperature_2m,weather_code,is_day&models=${OM_MODELS[m]}&forecast_hours=48&timeformat=unixtime&timezone=auto`;
      const j = await getJSON(url);
      MAP.cache[m] = { at: Date.now(), list: Array.isArray(j) ? j : [j] };
    } catch { toast('No se pudo cargar el mapa de temperaturas'); return; }
  }
  drawMapTemps();
}
function drawMapTemps() {
  const c = MAP.cache[MAP.model]; if (!c || !MAP.labels) return;
  const k = +$('#mapt').value;
  const t0 = floorHour(Date.now()) + k * HOUR;
  MAP.labels.clearLayers();
  c.list.forEach((r, n) => {
    if (!r.hourly) return;
    const i = r.hourly.time.findIndex(ts => ts * 1000 >= t0);
    const v = i < 0 ? null : r.hourly.temperature_2m[i];
    if (v == null) return;
    const html = `<div class="tlab num">${icon(catWMO(r.hourly.weather_code[i]), r.hourly.is_day?.[i] === 0)}${Math.round(v)}°</div>`;
    L.marker([CITIES[n][1], CITIES[n][2]], { icon: L.divIcon({ className: '', html, iconSize: [0, 0] }), interactive: false }).addTo(MAP.labels);
  });
  $('#mapt-l').innerHTML = k === 0 ? '<b>Ahora</b>' : `<b>${fmt(t0, { weekday: 'short' })} ${hh(t0)}</b> · +${k} h`;
  $('#mapt-r').textContent = MAP_MODELS[MAP.model] + (MAP.model === 'arome' ? ' (sin Canarias)' : '');
}
async function toggleRadar() {
  MAP.radarOn = !MAP.radarOn; $('#radar').classList.toggle('on', MAP.radarOn);
  if (MAP.radar) { MAP.map.removeLayer(MAP.radar); MAP.radar = null; }
  if (!MAP.radarOn) return;
  try {
    const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
    const last = j.radar.past.at(-1);
    MAP.radar = L.tileLayer(`${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: .7, maxNativeZoom: 7, maxZoom: 12, attribution: 'Radar © RainViewer' }).addTo(MAP.map);
    toast('Radar: ' + hh(last.time * 1000));
  } catch { toast('Radar no disponible'); MAP.radarOn = false; $('#radar').classList.remove('on'); }
}

// ───────────────────────── navegación / UI ─────────────────────────
function show(view) {
  S.view = view; LS.set('view', view);
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
$('#btn-refresh').onclick = () => { load(true); if (MAP.map) { MAP.cache = {}; loadMapTemps(); } };
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
  $('#k-aemet').value = S.keys.aemet; $('#k-carto').value = S.keys.carto || ''; $('#k-meteocat').value = S.keys.meteocat; $('#k-proxy').value = S.keys.proxy;
  $('#mtog').innerHTML = ORDER.map(m => `<div class="tog"><span><i class="dot" style="display:inline-block;margin-right:8px;background:${mcolor(m)}"></i>${MODELS[m].name} <span style="color:var(--mute);font-size:12px">${MODELS[m].sub}</span></span><button class="sw ${S.enabled[m] ? 'on' : ''}" data-m="${m}" aria-label="${MODELS[m].name}"></button></div>`).join('');
  $('#mtog').querySelectorAll('.sw').forEach(b => b.onclick = () => b.classList.toggle('on'));
  openSheet('#sh-set');
};
$('#btn-save').onclick = () => {
  S.keys = { aemet: $('#k-aemet').value.trim(), meteocat: $('#k-meteocat').value.trim(), proxy: $('#k-proxy').value.trim(), carto: $('#k-carto').value.trim() };
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
