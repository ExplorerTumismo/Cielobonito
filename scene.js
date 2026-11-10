/* Cielo — fondos de paisaje animados según el tiempo y la hora del día (estilo «foto del tiempo»).
   Todo se dibuja en un canvas: cielo, sol/luna/estrellas, nubes, montes, lluvia, nieve, niebla y relámpagos. */
'use strict';

const Scene = (() => {
  const cv = document.getElementById('scene'), ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, raf = null, last = 0, running = false;
  let st = { group: 'clear', phase: 'day', cat: 'clear' };
  let bg = null, hills = null, shade = null, clouds = [], drops = [], flakes = [], fog = [], flash = 0, nextFlash = 0;
  let rnd = mulberry(7);

  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => { const A = hex(a), B = hex(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };

  // grupo visual a partir de la categoría del tiempo
  const GROUP = { clear: 'clear', partly: 'partly', cloudy: 'cloudy', overcast: 'cloudy', fog: 'fog', drizzle: 'rain', rain: 'rain', snow: 'snow', storm: 'storm' };
  // [arriba, abajo] del cielo por grupo y fase
  const SKY = {
    clear:  { day: ['#2a78d2', '#9fd0f4'], dawn: ['#34407e', '#f5ad8c'], dusk: ['#262a66', '#f2875a'], night: ['#050817', '#1a2a4d'] },
    partly: { day: ['#3b80cc', '#b3d4ee'], dawn: ['#3c4680', '#e9a991'], dusk: ['#2c2f66', '#e0896a'], night: ['#070b1b', '#202c46'] },
    cloudy: { day: ['#6c7f93', '#c3ccd5'], dawn: ['#4d536e', '#c3a49c'], dusk: ['#3c3f58', '#a98a86'], night: ['#0d1119', '#283140'] },
    rain:   { day: ['#46525f', '#8d98a3'], dawn: ['#3b4150', '#857f86'], dusk: ['#30343f', '#6f6d76'], night: ['#090c11', '#1e252e'] },
    storm:  { day: ['#272b36', '#5d6270'], dawn: ['#25283a', '#5f5866'], dusk: ['#1f2130', '#4f4a58'], night: ['#05060a', '#171b23'] },
    snow:   { day: ['#8fa3b8', '#e7edf3'], dawn: ['#6d7896', '#e3cfd0'], dusk: ['#5b6283', '#cdb7bd'], night: ['#0f1522', '#3a4558'] },
    fog:    { day: ['#97a0a6', '#d6d9da'], dawn: ['#8a8c96', '#d7c9c3'], dusk: ['#76777f', '#bdb0ad'], night: ['#15181d', '#353a40'] },
  };

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
    cv.width = W; cv.height = H;
    build();
  }

  function sky() { return SKY[st.group][st.phase]; }
  function topColor() { return sky()[0]; }

  function build() {
    if (!W) return;
    rnd = mulberry(11);
    const [top, bot] = sky();
    // --- fondo estático: cielo + astros ---
    bg = document.createElement('canvas'); bg.width = W; bg.height = H;
    const b = bg.getContext('2d');
    const g = b.createLinearGradient(0, 0, 0, H); g.addColorStop(0, top); g.addColorStop(0.72, bot); g.addColorStop(1, bot);
    b.fillStyle = g; b.fillRect(0, 0, W, H);
    const clearish = st.group === 'clear' || st.group === 'partly';
    if (st.phase === 'night' && (clearish || st.group === 'snow')) {
      for (let i = 0; i < 160; i++) { const x = rnd() * W, y = rnd() * H * 0.6, r = (rnd() * 1.1 + 0.3) * dpr; b.globalAlpha = 0.25 + rnd() * 0.7; b.fillStyle = '#fff'; b.beginPath(); b.arc(x, y, r, 0, 7); b.fill(); }
      b.globalAlpha = 1;
      glow(b, W * 0.76, H * 0.14, 90 * dpr, 'rgba(220,230,255,.35)');
      b.fillStyle = '#f4f1e6'; b.beginPath(); b.arc(W * 0.76, H * 0.14, 17 * dpr, 0, 7); b.fill();
      b.fillStyle = top; b.beginPath(); b.arc(W * 0.76 + 8 * dpr, H * 0.14 - 5 * dpr, 15 * dpr, 0, 7); b.fill();
    } else if (st.phase === 'day' && clearish) {
      glow(b, W * 0.78, H * 0.13, 260 * dpr, 'rgba(255,248,220,.55)');
      glow(b, W * 0.78, H * 0.13, 40 * dpr, 'rgba(255,255,245,.95)');
    } else if ((st.phase === 'dawn' || st.phase === 'dusk') && st.group !== 'storm') {
      const x = st.phase === 'dawn' ? W * 0.22 : W * 0.78;
      glow(b, x, H * 0.66, 380 * dpr, clearish ? 'rgba(255,190,120,.55)' : 'rgba(255,190,140,.25)');
      if (clearish) glow(b, x, H * 0.66, 34 * dpr, 'rgba(255,236,190,.95)');
    }
    // --- montes en capas ---
    hills = document.createElement('canvas'); hills.width = W; hills.height = H;
    const h = hills.getContext('2d');
    const dark = st.phase === 'night' ? 0.55 : 0.32;
    const layers = [
      { base: 0.70, amp: 0.07, col: mix(bot, '#1c2430', dark * 0.9), alpha: 0.55 },
      { base: 0.78, amp: 0.05, col: mix(bot, '#141a22', dark + 0.15), alpha: 0.85 },
      { base: 0.87, amp: 0.035, col: mix(bot, '#0c1016', dark + 0.35), alpha: 1 },
    ];
    layers.forEach((L, k) => {
      const f = [rnd() * 2 + 1.5, rnd() * 4 + 4, rnd() * 9 + 9], p = [rnd() * 6, rnd() * 6, rnd() * 6];
      h.beginPath(); h.moveTo(0, H);
      for (let x = 0; x <= W; x += 4 * dpr) {
        const u = x / W;
        const y = H * (L.base - L.amp * (0.6 * Math.sin(u * f[0] + p[0]) + 0.3 * Math.sin(u * f[1] + p[1]) + 0.1 * Math.sin(u * f[2] + p[2])));
        h.lineTo(x, y);
      }
      h.lineTo(W, H); h.closePath();
      let col = L.col;
      if (st.group === 'snow') col = mix(col, '#eef3f8', k === 0 ? 0.75 : k === 1 ? 0.55 : 0.35);
      if (st.group === 'fog') col = mix(col, bot, 0.5 - k * 0.12);
      h.globalAlpha = L.alpha; h.fillStyle = col; h.fill();
    });
    h.globalAlpha = 1;
    // --- sombreado para que el texto blanco se lea sobre cielos claros ---
    shade = document.createElement('canvas'); shade.width = W; shade.height = H;
    const sh = shade.getContext('2d');
    // velo general (más fuerte en cielos claros) + degradado más oscuro hacia abajo, donde van los datos
    const bright = (st.group === 'snow' || st.group === 'fog' || (st.phase === 'day' && st.group !== 'storm' && st.group !== 'rain')) ? 1 : 0.6;
    sh.fillStyle = `rgba(0,0,0,${0.22 + 0.2 * bright})`; sh.fillRect(0, 0, W, H);
    let sg = sh.createLinearGradient(0, 0, 0, H);
    sg.addColorStop(0, `rgba(0,0,0,${0.18 * bright})`); sg.addColorStop(0.2, 'rgba(0,0,0,0)');
    sg.addColorStop(0.4, 'rgba(0,0,0,0)'); sg.addColorStop(0.7, `rgba(0,0,0,${0.3 * bright + 0.1})`); sg.addColorStop(1, `rgba(0,0,0,${0.45 * bright + 0.15})`);
    sh.fillStyle = sg; sh.fillRect(0, 0, W, H);
    // --- partículas ---
    const nC = { clear: 1, partly: 5, cloudy: 11, rain: 10, storm: 10, snow: 8, fog: 4 }[st.group];
    clouds = Array.from({ length: nC }, () => newCloud(true));
    const nR = st.cat === 'drizzle' ? 60 : st.group === 'storm' ? 220 : st.group === 'rain' ? 150 : 0;
    drops = Array.from({ length: nR }, () => ({ x: rnd() * W, y: rnd() * H, l: (10 + rnd() * 16) * dpr, v: (13 + rnd() * 9) * dpr }));
    flakes = st.group === 'snow' ? Array.from({ length: 140 }, () => ({ x: rnd() * W, y: rnd() * H, r: (1 + rnd() * 2.4) * dpr, v: (0.6 + rnd() * 1.2) * dpr, p: rnd() * 6 })) : [];
    fog = st.group === 'fog' ? Array.from({ length: 6 }, (_, i) => ({ y: H * (0.35 + i * 0.1), x: rnd() * W, h: (60 + rnd() * 70) * dpr, v: (0.15 + rnd() * 0.25) * dpr })) : [];
    nextFlash = performance.now() + 3000;
  }

  function glow(c, x, y, r, col) { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col); g.addColorStop(1, col.replace(/[\d.]+\)$/, '0)')); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }

  function newCloud(init) {
    const s = (0.6 + rnd() * 0.9) * dpr;
    // nube en forma de cúpula: base ancha y plana, más volumen en el centro
    const n = 9, puffs = Array.from({ length: n }, (_, i) => { const u = i / (n - 1); const dome = Math.sin(u * Math.PI);
      return { dx: (u - 0.5) * 230 * s + (rnd() - 0.5) * 14 * s, dy: -dome * 26 * s + (rnd() - 0.5) * 8 * s, r: (26 + dome * 34 + rnd() * 10) * s }; });
    return { x: init ? rnd() * W * 1.2 - W * 0.1 : -260 * dpr, y: H * (0.06 + rnd() * 0.42), v: (0.08 + rnd() * 0.18) * dpr, puffs, a: 0.5 + rnd() * 0.4 };
  }
  function cloudColor() {
    const n = st.phase === 'night';
    return { clear: n ? '120,130,155' : '255,255,255', partly: n ? '110,120,145' : '255,255,255', cloudy: n ? '70,78,92' : '232,236,240',
      rain: n ? '50,56,66' : '170,178,188', storm: n ? '35,38,46' : '88,94,106', snow: n ? '120,130,148' : '240,244,248', fog: '220,224,226' }[st.group];
  }

  function frame(t) {
    raf = running ? requestAnimationFrame(frame) : null;
    if (t - last < 33) return; // ~30 fps
    last = t;
    if (!bg) return;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg, 0, 0);
    const cc = cloudColor();
    for (const c of clouds) {
      if (!reduce) c.x += c.v;
      if (c.x - 300 * dpr > W) Object.assign(c, newCloud(false));
      for (const p of c.puffs) {
        const x = c.x + p.dx, y = c.y + p.dy;
        const g = ctx.createRadialGradient(x, y, 0, x, y, p.r);
        g.addColorStop(0, `rgba(${cc},${c.a})`); g.addColorStop(0.55, `rgba(${cc},${c.a * 0.55})`); g.addColorStop(1, `rgba(${cc},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, p.r, 0, 7); ctx.fill();
      }
    }
    ctx.drawImage(hills, 0, 0);
    ctx.drawImage(shade, 0, 0);
    if (drops.length) {
      ctx.strokeStyle = st.phase === 'night' ? 'rgba(200,210,230,.28)' : 'rgba(255,255,255,.38)'; ctx.lineWidth = 1.1 * dpr; ctx.beginPath();
      for (const d of drops) { if (!reduce) { d.y += d.v; d.x -= d.v * 0.18; if (d.y > H) { d.y = -d.l; d.x = rnd() * W * 1.2; } } ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * 0.18, d.y - d.l); }
      ctx.stroke();
    }
    if (flakes.length) {
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (const f of flakes) { if (!reduce) { f.y += f.v; f.p += 0.02; f.x += Math.sin(f.p) * 0.5 * dpr; if (f.y > H) { f.y = -5; f.x = rnd() * W; } } ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
    }
    for (const b of fog) {
      if (!reduce) b.x = (b.x + b.v) % W;
      for (const ox of [b.x - W, b.x]) { const g = ctx.createLinearGradient(0, b.y - b.h, 0, b.y + b.h); g.addColorStop(0, 'rgba(230,232,233,0)'); g.addColorStop(0.5, 'rgba(230,232,233,.28)'); g.addColorStop(1, 'rgba(230,232,233,0)'); ctx.fillStyle = g; ctx.fillRect(ox, b.y - b.h, W, b.h * 2); }
    }
    if (st.group === 'storm' && !reduce) {
      if (t > nextFlash) { flash = 1; nextFlash = t + 4000 + Math.random() * 7000; }
      if (flash > 0) { ctx.fillStyle = `rgba(235,240,255,${flash * 0.45})`; ctx.fillRect(0, 0, W, H); flash -= 0.12; }
    }
    if (reduce) { running = false; }
  }

  function start() { if (running || document.hidden) return; running = true; raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (document.body.classList.contains('scenic')) start(); });
  addEventListener('resize', () => { if (document.body.classList.contains('scenic')) resize(); });

  // fase del día a partir de salida/puesta (±50 min = amanecer/atardecer)
  function phaseOf(now, rise, set) {
    const m = 50 * 60e3;
    if (Math.abs(now - rise) < m) return 'dawn';
    if (Math.abs(now - set) < m) return 'dusk';
    return now > rise && now < set ? 'day' : 'night';
  }

  // Las fotos propias se eliminaron: se borra la base de datos que usaban versiones anteriores.
  try { indexedDB.deleteDatabase('cielo'); } catch {}

  async function set(cat, now, rise, set_) {
    const group = GROUP[cat] || 'partly', phase = phaseOf(now, rise, set_);
    const changed = group !== st.group || phase !== st.phase || cat !== st.cat || !bg;
    st = { group, phase, cat };
    // color de la barra de estado de iOS
    if (changed || !W) resize();
    if (document.body.classList.contains('scenic')) start();
  }

  return { set, start: () => { if (!W) resize(); start(); }, stop, topColor };
})();
