/* NEON WAKE: browser loader for neon_wake.wasm.
 *   - instantiates the wasm (no imports needed; the music is bundled inside it)
 *   - draws the vertex batch the game produces every frame with WebGL (one shader, alpha blending)
 *   - keyboard (desktop, identical keys to the Windows build) and pointer/touch input (phones, tablets)
 *   - plays the bundled 64 kbps Opus tunes with Web Audio, looping from each tune's loop point
 *   - saves progress in localStorage; fullscreen; pauses when the tab is hidden                                          */
(() => {
'use strict';

const WASM_URL = 'neon_wake.wasm';
const SLUG = window.NW_SLUG || 'neon_wake';
const SAVE_KEY = 'lorpcade:' + SLUG + ':save';          // LORPcade key convention: lorpcade:<slug>:<name>  (sealed text, see src/save_codec.rs)
const REJECT_KEY = SAVE_KEY + '.rejected';              // a save that failed its check is kept here, never deleted
const VERT_BYTES = 12;                       // x:f32 y:f32 rgba:u8x4, see gfx::Vertex
// KeyboardEvent.code -> the ids of web/src/keys.rs
const KEYMAP = { KeyW: 0, KeyA: 1, KeyS: 2, KeyD: 3, KeyG: 4, KeyM: 5, KeyP: 6, KeyR: 7, KeyC: 8, ArrowUp: 9, ArrowDown: 10, ArrowLeft: 11,
  ArrowRight: 12, ShiftLeft: 13, ShiftRight: 14, Space: 15, Enter: 16, NumpadEnter: 17, Escape: 18, Backspace: 19, Tab: 20 };

const $ = (id) => document.getElementById(id);
const canvas = $('game'), stage = $('stage');
let ex = null, mem = null, gl = null, prog = null, vbos = [], vboCap = 0, vboIdx = 0;
let touchMode = false, running = false, lastT = 0, lastHi = -1;
let resScale = 1;                                         // render-resolution factor; only drops under sustained GPU/fill-rate trouble
let cssW = 1, cssH = 1;

// ------------------------------------------------------------------ small helpers
function fatal(err, where) {
  running = false;
  let extra = '';
  try { if (ex && ex.nw_panic_len()) extra = new TextDecoder().decode(new Uint8Array(mem.buffer, ex.nw_panic_ptr(), ex.nw_panic_len())); } catch (_) {}
  console.error(where || 'fatal', err);
  $('fatal-text').textContent = (extra ? extra + '\n\n' : '') + String((err && err.stack) || err);
  $('fatal').style.display = 'flex';
  $('loading').style.display = 'none';
}
function setStatus(t, k) { $('status').textContent = t; if (k !== undefined) $('fill').style.width = Math.round(Math.max(0, Math.min(1, k)) * 100) + '%'; }
const wasmBytes = async () => {
  if (window.NW_WASM_B64) {                              // single-file build
    const bin = atob(window.NW_WASM_B64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    window.NW_WASM_B64 = null;
    return out;
  }
  const resp = await fetch(WASM_URL);
  if (!resp.ok) throw new Error('could not load ' + WASM_URL + ' (HTTP ' + resp.status + ')');
  const total = +resp.headers.get('content-length') || 0;
  if (!resp.body || !total) return new Uint8Array(await resp.arrayBuffer());
  const rd = resp.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    chunks.push(value); got += value.length; setStatus('LOADING', got / total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

// ------------------------------------------------------------------ WebGL
const VS = 'attribute vec2 a_pos; attribute vec4 a_col; varying vec4 v_col; void main(){ gl_Position = vec4(a_pos.x, -a_pos.y, 0.0, 1.0); v_col = a_col; }';
const FS = 'precision mediump float; varying vec4 v_col; void main(){ gl_FragColor = v_col; }';
function initGL() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
    || canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL is not available in this browser');
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'a_pos'); gl.bindAttribLocation(prog, 1, 'a_col');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  vbos = []; vboCap = 0; vboIdx = 0;                      // vertex buffers are created on first use (see uploadVerts)
  gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);                                   // same blend as the native renderer
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0.04, 0.02, 0.09, 1);
}
// Three vertex buffers used in rotation, each written with bufferSubData: the GPU is never asked to wait for the buffer the
// previous frame is still reading (re-specifying one buffer every frame can stall, which shows up as stutter on phones).
function uploadVerts(n) {
  const bytes = n * VERT_BYTES;
  if (!vbos.length || bytes > vboCap) {
    vboCap = Math.max(1 << 20, Math.ceil(bytes * 1.5 / 4096) * 4096);
    for (let i = 0; i < 3; i++) {
      if (!vbos[i]) vbos[i] = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbos[i]); gl.bufferData(gl.ARRAY_BUFFER, vboCap, gl.DYNAMIC_DRAW);
    }
  }
  vboIdx = (vboIdx + 1) % 3;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbos[vboIdx]);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERT_BYTES, 0);
  gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, VERT_BYTES, 8);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(mem.buffer, ex.nw_vertices(), bytes));
}
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); });
canvas.addEventListener('webglcontextrestored', () => { try { initGL(); } catch (e) { fatal(e, 'gl restore'); } });

// ------------------------------------------------------------------ size
function resize() {
  const r = stage.getBoundingClientRect();
  cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
  // phones get a lower cap: the UI is drawn on a 600-720 px tall virtual canvas anyway, and fill rate is what a phone runs out of first
  const dpr = Math.min(window.devicePixelRatio || 1, touchMode ? 1.5 : 2) * resScale;
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  if (ex) ex.nw_resize(w, h, cssH);
  const portrait = window.innerHeight > window.innerWidth;
  $('rotate').classList.toggle('on', touchMode && portrait);
}
function setTouchMode(on) {
  if (on === touchMode) return;
  touchMode = on;
  if (ex) ex.nw_set_touch(on ? 1 : 0);
  resize();
}

// ------------------------------------------------------------------ audio (Web Audio, bundled Opus)
let actx = null, master = null, cur = null, wantIdx = -1, playTok = 0;
const decoded = [];                                      // per-track Promise<AudioBuffer|null>
const lru = [];                                          // track indices, oldest first. A decoded tune is ~40 MB of float PCM, so only a few are kept.
const KEEP_TRACKS = 3;
function unlockAudio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { actx = new AC({ latencyHint: 'playback' }); } catch (_) { actx = new AC(); }
    master = actx.createGain(); master.gain.value = 0.9; master.connect(actx.destination);
    applyMusic();
  }
  if (actx.state !== 'running') { const p = actx.resume(); if (p && p.catch) p.catch(() => {}); }
}
function touchLru(i) { const k = lru.indexOf(i); if (k >= 0) lru.splice(k, 1); lru.push(i); }
function evictOld(keep) {
  for (let k = 0; k < lru.length && lru.length > KEEP_TRACKS;) {
    const old = lru[k];
    if (old === keep || old === wantIdx || (cur && cur.idx === old)) { k++; continue; }
    lru.splice(k, 1); decoded[old] = undefined;
  }
}
function getBuffer(i) {
  touchLru(i);
  if (decoded[i]) return decoded[i];
  evictOld(i);
  decoded[i] = new Promise((resolve) => {
    try {
      const ptr = ex.nw_track_ptr(i), len = ex.nw_track_len(i);
      if (!ptr || !len) return resolve(null);
      const copy = new Uint8Array(mem.buffer, ptr, len).slice().buffer;   // decodeAudioData detaches what it is given
      actx.decodeAudioData(copy, resolve, (e) => { console.warn('could not decode track', i, e); resolve(null); });
    } catch (e) { console.warn('decode failed', e); resolve(null); }
  });
  return decoded[i];
}
async function applyMusic() {
  const tok = ++playTok;
  if (!actx) return;
  if (wantIdx < 0) { stopCurrent(0.35); return; }
  const idx = wantIdx, buf = await getBuffer(idx);
  if (tok !== playTok || !buf) return;
  startTrack(idx, buf);                                    // (no eager decoding of the other tunes: that big background work hitched the game)
}
function stopCurrent(fade) {
  if (!cur) return;
  const old = cur, t = actx.currentTime;
  cur = null;
  old.g.gain.cancelScheduledValues(t); old.g.gain.setValueAtTime(old.g.gain.value, t); old.g.gain.linearRampToValueAtTime(0, t + fade);
  try { old.src.stop(t + fade + 0.05); } catch (_) {}
}
function startTrack(idx, buf) {
  stopCurrent(0.3);
  const now = actx.currentTime, ls = ex.nw_track_loop_start(idx), le = ex.nw_track_loop_end(idx);
  const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
  if (le > ls + 1) { src.loopStart = ls; src.loopEnd = Math.min(le, buf.duration); }   // intro plays once, then the body loops seamlessly
  const g = actx.createGain(); g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + 0.2);
  src.connect(g); g.connect(master); src.start(now + 0.02);
  cur = { src, g, idx };
}
function pollMusic() {
  const w = ex.nw_music();
  if (w !== wantIdx) { wantIdx = w; applyMusic(); }
}
['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'].forEach((ev) => window.addEventListener(ev, unlockAudio, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (!actx) return;
  if (document.hidden) { if (ex) ex.nw_blur(); actx.suspend().catch(() => {}); } else if (actx.state !== 'running') actx.resume().catch(() => {});
});

// ------------------------------------------------------------------ fullscreen
function toggleFullscreen() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen || document.documentElement.requestFullscreen;
    if (!req) return;                                      // iPhone Safari has none: use "Add to Home Screen"
    const p = req.call(stage.requestFullscreen ? stage : document.documentElement);
    const lockEsc = () => { try { navigator.keyboard && navigator.keyboard.lock && navigator.keyboard.lock(['Escape']); } catch (_) {} };
    const lockLandscape = () => { try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (_) {} };
    if (p && p.then) p.then(() => { lockEsc(); lockLandscape(); }).catch(() => {}); else { lockEsc(); lockLandscape(); }
  } catch (_) {}
}
document.addEventListener('fullscreenchange', resize);

// ------------------------------------------------------------------ input
function installInput() {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;       // leave browser shortcuts alone
    const id = KEYMAP[e.code];
    if (id === undefined) return;
    e.preventDefault();
    setTouchMode(false);                                   // a real keyboard: desktop UI
    ex.nw_key(id, 1, e.repeat ? 1 : 0);
  });
  window.addEventListener('keyup', (e) => {
    const id = KEYMAP[e.code];
    if (id === undefined) return;
    e.preventDefault();
    ex.nw_key(id, 0, 0);
  });
  window.addEventListener('blur', () => ex.nw_blur());

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') setTouchMode(true);     // a finger or pen: touch UI
    if (!touchMode) return;                                // desktop UI is keyboard only, exactly like the Windows build
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const [x, y] = pos(e); ex.nw_pointer(e.pointerId, 0, x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touchMode) return;
    e.preventDefault();
    const [x, y] = pos(e); ex.nw_pointer(e.pointerId, 1, x, y);
  });
  const up = (e) => { if (!touchMode) return; e.preventDefault(); const [x, y] = pos(e); ex.nw_pointer(e.pointerId, 2, x, y); };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((n) => document.addEventListener(n, (e) => e.preventDefault()));
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}

// ------------------------------------------------------------------ main loop
// ---- frame pacing. requestAnimationFrame timestamps are vsync times, but they are quantised or jittered in some browsers (Firefox rounds to
// 1 ms), and the old code then averaged them, so motion drifted away from the real frame cadence (stutter). Instead: find the display's
// refresh period (median of recent frame gaps, snapped to a standard refresh rate) and advance the game by a whole number of periods:
// 1 for a normal frame, 2 after a dropped one. Motion is then exactly as even as the display itself.
const STD_HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
const pace = { gaps: [], T: 1 / 60, ok: false };
function pacedDt(raw) {
  const g = pace.gaps; g.push(raw); if (g.length > 48) g.shift();
  if (g.length >= 12) {
    const s = g.slice().sort((a, b) => a - b), med = s[s.length >> 1];   // late frames sit in the upper tail, so the median is the refresh period
    let best = med, bd = 0.04;
    for (const hz of STD_HZ) { const p = 1 / hz, d = Math.abs(med - p) / p; if (d < bd) { bd = d; best = p; } }
    pace.T = best; pace.ok = true;
  }
  if (!pace.ok) return Math.min(raw, 0.05);
  const k = Math.max(1, Math.round(raw / pace.T));
  if (k <= 6 && Math.abs(raw - k * pace.T) < 0.35 * pace.T) return k * pace.T;
  return Math.min(raw, 0.1);                               // tab was away, or a very long hitch
}

// ---- F3 (or ?debug in the address): live frame statistics, so stutter can be told apart (slow CPU? slow GPU? uneven display?)
let perfEl = null, perfOn = /[?&]debug\b/.test(location.search);
const pf = { gap: [], cpu: [], gpu: [], n: 0, shown: 0, drops: 0, win: 0 };
function perfPush(arr, v) { arr.push(v); if (arr.length > 60) arr.shift(); }
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, mx = (a) => a.length ? Math.max.apply(null, a) : 0;
function perfShow(now, verts) {
  if (!perfOn) { if (perfEl) perfEl.style.display = 'none'; return; }
  if (!perfEl) {
    perfEl = document.createElement('pre');
    perfEl.style.cssText = 'position:fixed;left:6px;top:6px;margin:0;padding:6px 8px;z-index:40;background:rgba(0,0,0,.7);color:#7dffb0;font:11px/1.35 monospace;pointer-events:none;white-space:pre';
    document.body.appendChild(perfEl);
  }
  perfEl.style.display = 'block';
  if (now - pf.shown < 250) return;
  pf.shown = now;
  const gap = avg(pf.gap);
  perfEl.textContent = 'fps ' + (gap ? (1000 / gap).toFixed(0) : '-') + '   refresh ' + (pace.ok ? (1 / pace.T).toFixed(0) + ' Hz' : '?') +
    '\nframe gap  avg ' + gap.toFixed(1) + '  max ' + mx(pf.gap).toFixed(1) + ' ms' +
    '\ngame cpu   avg ' + avg(pf.cpu).toFixed(1) + '  max ' + mx(pf.cpu).toFixed(1) + ' ms' +
    '\ngl submit  avg ' + avg(pf.gpu).toFixed(1) + '  max ' + mx(pf.gpu).toFixed(1) + ' ms' +
    '\nvertices ' + verts + '   canvas ' + canvas.width + 'x' + canvas.height + '  res ' + resScale.toFixed(2) + (touchMode ? '  touch' : '');
}
window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); perfOn = !perfOn; } });

// ---- adaptive resolution: if frames keep arriving late while the game's own CPU time is small, the GPU / fill rate is the limit:
// render fewer pixels (the canvas is scaled up by the browser). Never raised again within a session, so it cannot oscillate.
let lastScaleAt = 0;
function adaptResolution(now, gap) {
  if (!pace.ok) return;
  pf.win++; if (gap > pace.T * 1500 * 1.0) pf.drops++;
  if (pf.win < 90) return;
  const dropRatio = pf.drops / pf.win, cpu = avg(pf.cpu) / 1000;
  pf.win = 0; pf.drops = 0;
  if (dropRatio > 0.2 && cpu < pace.T * 0.6 && resScale > 0.56 && now - lastScaleAt > 2500) {
    resScale = Math.max(0.55, resScale * 0.85); lastScaleAt = now; resize();
  }
}

function frame(ts) {
  if (!running) return;
  requestAnimationFrame(frame);
  const gapMs = lastT ? ts - lastT : 1000 / 60;
  lastT = ts;
  const dt = lastT && gapMs > 0 ? pacedDt(gapMs / 1000) : 1 / 60;
  perfPush(pf.gap, gapMs);
  const t0 = performance.now();
  let n = 0;
  try { n = ex.nw_frame(dt); } catch (e) { fatal(e, 'frame'); return; }
  const t1 = performance.now();
  if (!gl || gl.isContextLost()) return;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (n > 0) {
    uploadVerts(n);
    gl.drawArrays(gl.TRIANGLES, 0, n);
  }
  const t2 = performance.now();
  perfPush(pf.cpu, t1 - t0); perfPush(pf.gpu, t2 - t1);
  adaptResolution(t2, gapMs / 1000 * 1000);
  perfShow(t2, n);
  flushStorage();
  const fl = ex.nw_flags();
  if (fl & 1) toggleFullscreen();
  if (fl & 2) { running = false; goHome(); return; }       // QUIT: the save was flushed just above
  pollMusic();
}

// ------------------------------------------------------------------ LORPcade: saves, high score, quit, cloud sync
function flushStorage() {
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len));
  try {
    if (ex.nw_reject_dirty()) localStorage.setItem(REJECT_KEY, text(ex.nw_reject_ptr(), ex.nw_reject_len()));   // before the next save overwrites anything
    if (ex.nw_save_dirty()) localStorage.setItem(SAVE_KEY, text(ex.nw_save_ptr(), ex.nw_save_len()));
  } catch (_) {}                                           // no storage (private mode): just play without saving
  const hi = ex.nw_hiscore();
  if (hi !== lastHi) { lastHi = hi; if (window.esHiscore) window.esHiscore(hi); }
}
function goHome() {
  if (window.esGoHome) window.esGoHome(); else location.assign(new URL('../', location.href).href);
}
async function cloudStart() {
  const SYNC = window.LorpSync || null;
  if (!SYNC) return;
  try {
    // refuse cloud data that isn't a real sealed save of this game
    SYNC.validators[SLUG] = (name, t) => name === 'save' ? /^NWSAVE1:[A-Za-z0-9_-]+$/.test(t) : name !== 'hiscore' || /^[0-9]{1,15}$/.test(t);
    await SYNC.ready;
    if (!SYNC.enabled) return;
    if (SYNC.getCode()) await SYNC.syncGame(SLUG, { timeout: 4000 });      // never rejects; gives up after 4 s
    SYNC.watch(SLUG, { onRemote: () => { const bar = $('stale'); if (bar) bar.hidden = false; } });   // later saves are pushed; tell me if another device changed it
  } catch (_) {}
}

async function boot() {
  try {
    setStatus('LOADING', 0);
    const cloud = cloudStart();                            // runs while the wasm downloads
    const bytes = await wasmBytes();
    setStatus('STARTING', 1);
    const module = await WebAssembly.compile(bytes);
    const imports = {};                                    // the module needs none; stub any the toolchain might add
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.kind === 'function') (imports[imp.module] = imports[imp.module] || {})[imp.name] = () => 0;
    }
    const inst = await WebAssembly.instantiate(module, imports);
    ex = inst.exports; mem = ex.memory;
    initGL();
    const mq = window.matchMedia && window.matchMedia('(pointer: coarse)');
    touchMode = !!(mq && mq.matches);
    resize();
    await cloud;                                           // the game reads its save once, at boot: sync first
    let saved = null;
    try { saved = localStorage.getItem(SAVE_KEY); } catch (_) {}
    let sp = 0, sl = 0;
    if (saved) {
      const enc = new TextEncoder().encode(saved);
      sl = enc.length; sp = ex.nw_alloc(sl);
      new Uint8Array(mem.buffer, sp, sl).set(enc);
    }
    ex.nw_init(sp, sl, canvas.width, canvas.height, cssH, touchMode ? 1 : 0);
    if (sp) ex.nw_free(sp, sl);
    const setToday = () => { try { ex.nw_set_today(Math.floor(Date.now() / 86400000)); } catch (_) {} };   // the daily challenge follows the UTC day
    setToday(); setInterval(setToday, 60000);
    flushStorage();                                        // an old or rejected save is re-sealed / set aside right away; publish HI
    installInput();
    new ResizeObserver(resize).observe(stage);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 150));
    $('loading').style.display = 'none';
    running = true;
    requestAnimationFrame(frame);
    canvas.focus();
  } catch (e) { fatal(e, 'boot'); }
}
boot();
})();
