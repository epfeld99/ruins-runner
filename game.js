/* =========================================================================
 * RUINS RUNNER — a Temple Run–inspired 3D endless runner
 * -------------------------------------------------------------------------
 * Pure client-side: HTML + CSS + JavaScript, rendered with Three.js (CDN).
 *
 * High-level architecture
 *   CFG         tunable constants (speeds, physics, timings)
 *   Save        localStorage persistence (bank, upgrades, high scores…)
 *   Sfx         Web Audio API synthesiser (all sounds generated in code)
 *   World       procedural track "segments" (straight run + corner junction)
 *   Player (P)  logical runner state in *track space* (s = distance along
 *               the segment, x = lateral offset, y = height)
 *   G           per-run game state (score, coins, timers, chase distance…)
 *   UI          DOM menus / HUD
 *   state       START | PLAYING | PAUSED | GAMEOVER
 *   Touch       swipe / hold / tap gestures, optional tilt + on-screen buttons
 *
 * Track model
 *   The track is a chain of straight segments, each ending in a junction
 *   that turns 90° left, right, or both (a T-split). Every segment owns a
 *   THREE.Group whose local frame is: -Z = forward, +X = right. So content
 *   at track coords (s, x, y) sits at local position (x, y, -s).
 *   When the player enters a segment, its child segment(s) beyond the
 *   junction are generated so the path ahead is always visible. On a turn
 *   the un-chosen branch and old segments are disposed.
 *
 * Biomes
 *   Every 500 m the world cycles Ruins → Lava Cavern → Jungle. Each segment
 *   takes the biome of the distance at which it starts (seg.d0), which picks
 *   its materials, scenery and obstacle mix. Fog, sky and lights blend to
 *   the new biome when the runner enters its first segment.
 * ========================================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Bail out gracefully if Three.js didn't load (offline, CDN blocked…)
  if (typeof THREE === 'undefined') {
    $('screen-start').classList.add('hidden');
    $('load-error').classList.remove('hidden');
    return;
  }

  /* =======================================================================
   * 1. CONFIGURATION
   * ===================================================================== */
  const CFG = {
    PATH_W: 6,            // walkable path width
    HALF_W: 3,
    LANE_LIMIT: 2.3,      // max |x| for the runner's centre
    LANES: [-2, 0, 2],    // lane centres used for content placement
    STEER_SPEED: 9,       // lateral units / second while holding A/D

    BASE_SPEED: 13,       // starting forward speed (units/s ≈ metres/s)
    MAX_SPEED: 34,
    SPEED_RAMP: 0.0045,   // speed gained per metre run
    BOOST_MUL: 1.75,

    GRAVITY: 34,
    JUMP_V: 11.5,
    SLIDE_TIME: 0.75,
    COYOTE: 0.1,          // grace period to jump after leaving an edge
    JUMP_BUFFER: 0.15,    // pressing jump slightly before landing still counts

    TURN_EARLY: 4.5,      // how far before the junction centre a turn is accepted
    TURN_LATE: 2.6,       // how far past the centre (then you hit the wall)
    TURN_BUFFER: 0.35,    // seconds a turn key press is remembered

    MONKEY_SAFE: 13,      // chase gap when running cleanly (off-screen)
    MONKEY_CLOSE: 1.9,    // chase gap right after a stumble
    RECOVER_TIME: 5,      // seconds of clean running to shake the monkeys

    MAGNET_TIME: 8,
    MAGNET_RANGE: 10,
    BOOST_TIME: 5,
    METER_BASE: 30,       // coin points to fill the power meter

    CAM_BACK: 7,
    CAM_UP: 4,
    FOG_COLOR: 0xb4c4a0,
    SUBSTEP: 1 / 120,     // physics sub-step to avoid tunnelling at high speed

    BIOME_LENGTH: 500,    // metres per biome (Ruins → Lava Cavern → Jungle → …)
    GRAPPLE_RANGE: 14,    // how far before a canyon the hook can be fired
    GRAPPLE_ARC: 3.4,     // extra height at the top of the swing
    GRAPPLE_SPEED: 1.1,   // speed multiplier while swinging
  };

  const State = { START: 'START', PLAYING: 'PLAYING', PAUSED: 'PAUSED', GAMEOVER: 'GAMEOVER' };
  let state = State.START;

  /* =======================================================================
   * 2. SMALL UTILITIES
   * ===================================================================== */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  /** Frame-rate independent exponential smoothing. */
  const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
  const escapeHTML = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Pick from [[value, weight], …] */
  function weighted(entries) {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = Math.random() * total;
    for (const e of entries) { if ((r -= e[1]) <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  }

  // Cardinal directions in world space: 0=N(-Z) 1=E(+X) 2=S(+Z) 3=W(-X)
  const DIRS = [
    new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0),
  ];

  /* =======================================================================
   * 3. PERSISTENCE (localStorage)
   * ===================================================================== */
  const SAVE_KEY = 'ruinsRunner.save.v1';
  const Save = {
    data: null,
    defaults() {
      return {
        bank: 0,
        highScores: [],
        upgrades: { magnet: 0, boost: 0, meter: 0, multi: 0, shieldStart: 0 },
        character: 'jack',
        unlocked: ['jack'],
        meterPower: 'boost',
        muted: false,
        playerName: '',       // asked for on the first run (name overlay)
        touchButtons: null,   // null = auto (on for touch devices)
        tilt: false,          // device-tilt steering
      };
    },
    load() {
      const d = this.defaults();
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          Object.assign(d, p);
          d.upgrades = Object.assign(this.defaults().upgrades, p.upgrades || {});
          if (!Array.isArray(d.highScores)) d.highScores = [];
          if (!Array.isArray(d.unlocked)) d.unlocked = ['jack'];
          if (!d.unlocked.includes('jack')) d.unlocked.push('jack');
        }
      } catch (e) { /* corrupted or blocked storage → defaults */ }
      this.data = d;
    },
    save() {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    },
    get best() { return this.data.highScores.length ? this.data.highScores[0].score : 0; },
  };
  Save.load();

  /* =======================================================================
   * 4. AUDIO — everything synthesised with the Web Audio API
   * ===================================================================== */
  const Sfx = {
    ctx: null, master: null, music: null, noiseBuf: null,
    musicTimer: null, nextBeat: 0, beat: 0,

    /** Must be called from a user gesture (browsers block autoplay). */
    init() {
      if (this.ctx) { this.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      this.master = this.ctx.createGain();
      this.master.gain.value = Save.data.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      this.music = this.ctx.createGain();
      this.music.gain.value = 0.32;
      this.music.connect(this.master);
      // 1 second of white noise, reused for whooshes / crashes / hats
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const ch = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    },
    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    setMuted(m) {
      Save.data.muted = m; Save.save();
      if (this.master) this.master.gain.value = m ? 0 : 0.55;
    },

    /** Simple enveloped oscillator, optional pitch slide. */
    tone(freq, dur, type = 'sine', vol = 0.25, slideTo = 0, delay = 0, dest = null) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + Math.max(0, delay);
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest || this.master);
      o.start(t); o.stop(t + dur + 0.05);
    },
    /** Filtered noise burst. */
    noise(dur, vol = 0.3, freq = 1000, delay = 0, type = 'lowpass', dest = null) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + Math.max(0, delay);
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(dest || this.master);
      src.start(t); src.stop(t + dur + 0.05);
    },

    // ---- game sound effects ----
    jump()   { this.tone(320, 0.18, 'square', 0.12, 760); },
    slide()  { this.noise(0.3, 0.22, 900); },
    turn()   { this.noise(0.16, 0.16, 2400, 0, 'bandpass'); },
    coin(v)  {
      const f = v === 3 ? 1568 : v === 2 ? 1319 : 988;
      this.tone(f, 0.08, 'sine', 0.2);
      this.tone(f * 1.5, 0.14, 'sine', 0.16, 0, 0.055);
    },
    stumble() { this.tone(150, 0.25, 'triangle', 0.45, 55); this.noise(0.2, 0.3, 500); },
    crash()  { this.noise(0.7, 0.6, 700); this.tone(120, 0.6, 'sawtooth', 0.25, 35); },
    splash() { this.tone(500, 0.9, 'sine', 0.25, 60); },
    power()  { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.13, 'square', 0.1, 0, i * 0.07)); },
    shieldBreak() { this.tone(900, 0.3, 'triangle', 0.25, 200); this.noise(0.3, 0.25, 3000, 0, 'highpass'); },
    smash()  { this.noise(0.25, 0.35, 1200); },
    roar()   { this.tone(90, 0.5, 'sawtooth', 0.22, 160); this.noise(0.4, 0.18, 600); },
    click()  { this.tone(660, 0.05, 'square', 0.08); },
    grapple() { this.noise(0.25, 0.25, 1800, 0, 'bandpass'); this.tone(500, 0.2, 'square', 0.1, 1400); },
    whiff()  { this.tone(220, 0.08, 'triangle', 0.12, 160); },
    crumble() { this.noise(0.45, 0.25, 350); },
    swoosh() { this.noise(0.18, 0.12, 1500, 0, 'bandpass'); },
    biome()  { [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.12, 0, i * 0.11)); },
    gameOver() { [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.22, 0, 0.3 + i * 0.18)); },

    // ---- tribal drum loop (scheduled ahead with a look-ahead timer) ----
    startMusic() {
      if (!this.ctx || this.musicTimer) return;
      this.nextBeat = this.ctx.currentTime + 0.1;
      this.beat = 0;
      this.musicTimer = setInterval(() => this.scheduleMusic(), 50);
    },
    stopMusic() { clearInterval(this.musicTimer); this.musicTimer = null; },
    scheduleMusic() {
      const step = 60 / 132 / 2; // eighth notes at 132 BPM
      const bass = [55, 55, 65.4, 55, 73.4, 55, 65.4, 49];
      while (this.nextBeat < this.ctx.currentTime + 0.2) {
        const b = this.beat % 16;
        const d = this.nextBeat - this.ctx.currentTime;
        if (b % 4 === 0) this.tone(130, 0.22, 'sine', 0.5, 40, d, this.music);         // kick
        if (b === 6 || b === 14 || b === 15) this.tone(190, 0.15, 'sine', 0.3, 110, d, this.music); // tom
        if (b % 2 === 1) this.noise(0.04, 0.05, 7000, d, 'highpass', this.music);       // shaker
        if (b % 2 === 0) this.tone(bass[b >> 1] * 2, 0.2, 'triangle', 0.1, 0, d, this.music);
        this.nextBeat += step;
        this.beat++;
      }
    },
  };

  /* =======================================================================
   * 5. RENDERER, SCENE, CAMERA, LIGHTS
   * ===================================================================== */
  // Touch-first device? (phones / tablets) — drives UI layout, pixel ratio and defaults.
  const IS_TOUCH = /[?&]touch\b/.test(location.search) ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer: fine)').matches;
  if (IS_TOUCH) document.body.classList.add('touch');

  const canvas = $('game-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  // Phones have very high DPRs; cap lower there to hold 60 FPS.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_TOUCH ? 1.5 : 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CFG.FOG_COLOR);
  scene.fog = new THREE.Fog(CFG.FOG_COLOR, 25, 125);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 400);

  const hemi = new THREE.HemisphereLight(0xfff1d6, 0x2d3b22, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe2b0, 0.75);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  // Jungle floor far below the floating causeway; follows the camera.
  const jungleFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshLambertMaterial({ color: 0x2f4a2a })
  );
  jungleFloor.rotation.x = -Math.PI / 2;
  jungleFloor.position.y = -30;
  scene.add(jungleFloor);

  /**
   * Viewport-dependent camera settings. In portrait the horizontal view gets
   * very narrow, so we widen the vertical FOV and pull the camera back/up to
   * keep all three lanes and the turns visible.
   */
  const View = { back: CFG.CAM_BACK, up: CFG.CAM_UP, fovScale: 1 };
  function fitViewport() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const aspect = w / h;
    const p = clamp((1.15 - aspect) / 0.7, 0, 1); // 0 = landscape … 1 = tall portrait phone
    View.fovScale = 1 + 0.42 * p;
    View.back = CFG.CAM_BACK + 1.8 * p;
    View.up = CFG.CAM_UP + 1.2 * p;
    camera.aspect = aspect;
    camera.fov = 65 * View.fovScale;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false); // CSS controls the displayed size
    document.body.classList.toggle('portrait', aspect < 1);
  }
  window.addEventListener('resize', fitViewport);
  window.addEventListener('orientationchange', () => setTimeout(fitViewport, 250));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
  fitViewport();

  /* =======================================================================
   * 6. PROCEDURAL TEXTURES, MATERIALS & SHARED GEOMETRY
   * ===================================================================== */
  const TEX_SIZE = 3; // world units covered by one texture tile

  function canvasTexture(size, draw) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }

  /** Staggered stone blocks with grime and optional moss. */
  function stoneTexture(hue, sat, light, mortar, moss) {
    return canvasTexture(256, (g, n) => {
      g.fillStyle = mortar; g.fillRect(0, 0, n, n);
      const rows = 4, rh = n / rows;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * (n / 4);
        for (let c = -1; c < 3; c++) {
          g.fillStyle = `hsl(${hue},${sat}%,${light + rand(-7, 7)}%)`;
          g.fillRect(c * (n / 2) + off + 3, r * rh + 3, n / 2 - 6, rh - 6);
        }
      }
      for (let i = 0; i < 700; i++) {
        g.fillStyle = `rgba(0,0,0,${Math.random() * 0.13})`;
        g.fillRect(Math.random() * n, Math.random() * n, 2, 2);
      }
      if (moss) {
        for (let i = 0; i < 45; i++) {
          g.fillStyle = `rgba(70,115,40,${rand(0.15, 0.45)})`;
          g.beginPath(); g.arc(Math.random() * n, Math.random() * n, rand(3, 13), 0, Math.PI * 2); g.fill();
        }
      }
    });
  }

  const barkTexture = canvasTexture(128, (g, n) => {
    g.fillStyle = '#6b4626'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(${rand(30, 70)},${rand(20, 40)},10,0.6)`;
      g.fillRect(0, Math.random() * n, n, rand(1, 4));
    }
  });

  const MAT = {
    floor: new THREE.MeshLambertMaterial({ map: stoneTexture(38, 18, 58, '#4a4234', true) }),
    curb: new THREE.MeshLambertMaterial({ map: stoneTexture(35, 12, 44, '#2f2a22', true) }),
    wall: new THREE.MeshLambertMaterial({ map: stoneTexture(30, 14, 40, '#2a251d', true) }),
    pillar: new THREE.MeshLambertMaterial({ color: 0x6f6a5c }),
    log: new THREE.MeshLambertMaterial({ map: barkTexture }),
    trunk: new THREE.MeshLambertMaterial({ color: 0x4a3622 }),
    leaves: [0x2f6b2a, 0x3d7d33, 0x285a24, 0x4a8a3a].map((c) => new THREE.MeshPhongMaterial({ color: c, flatShading: true, shininess: 0 })),
    flame: new THREE.MeshBasicMaterial({ color: 0xff6a10, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    flameCore: new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    monkey: new THREE.MeshLambertMaterial({ color: 0x2b1d17 }),
    monkeyFace: new THREE.MeshLambertMaterial({ color: 0x6a4a36 }),
    monkeyEye: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
    shield: new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
    magnetRing: new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
    halo: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  // Coin colours: Gold = 1pt, Red = 2pt, Blue = 3pt
  const COIN_MATS = {
    1: new THREE.MeshLambertMaterial({ color: 0xffc933, emissive: 0x6a4800 }),
    2: new THREE.MeshLambertMaterial({ color: 0xff4a3a, emissive: 0x6a1008 }),
    3: new THREE.MeshLambertMaterial({ color: 0x45a6ff, emissive: 0x0d3a70 }),
  };
  const COIN_HEX = { 1: 0xffd34d, 2: 0xff5a4a, 3: 0x5ab4ff };

  const GEO = {
    box: new THREE.BoxGeometry(1, 1, 1),
    coin: new THREE.CylinderGeometry(0.42, 0.42, 0.12, 20).rotateX(Math.PI / 2),
    log: new THREE.CylinderGeometry(0.45, 0.45, CFG.PATH_W + 0.8, 12).rotateZ(Math.PI / 2),
    rubble: new THREE.DodecahedronGeometry(0.5, 0),
    trunk: new THREE.CylinderGeometry(0.45, 0.8, 38, 7),
    canopy: new THREE.IcosahedronGeometry(3.1, 0),
    pillar: new THREE.BoxGeometry(2.4, 26, 2.4),
    column: new THREE.BoxGeometry(0.75, 1.7, 0.75),
    columnCap: new THREE.BoxGeometry(1.0, 0.25, 1.0),
    flame: new THREE.ConeGeometry(0.36, 1.15, 6),
    flameCore: new THREE.ConeGeometry(0.18, 0.8, 6),
    archPillar: new THREE.BoxGeometry(0.9, 3.6, 0.9),
    archTop: new THREE.BoxGeometry(CFG.PATH_W + 2.2, 0.7, 1.0),
    shadow: new THREE.CircleGeometry(0.6, 16).rotateX(-Math.PI / 2),
    sphere: new THREE.SphereGeometry(1, 12, 10),
    halo: new THREE.TorusGeometry(0.75, 0.05, 6, 24),
    magnet: new THREE.TorusGeometry(0.35, 0.13, 8, 16, Math.PI),
    boost: new THREE.OctahedronGeometry(0.45, 0),
    shieldGem: new THREE.IcosahedronGeometry(0.42, 0),
  };

  // Extra materials / geometry for traps, the grappling hook and scenery
  Object.assign(MAT, {
    blade: new THREE.MeshLambertMaterial({ color: 0xc0c4cc, emissive: 0x202428 }),
    bladeHot: new THREE.MeshLambertMaterial({ color: 0xff7a30, emissive: 0x902800 }),
    chain: new THREE.MeshLambertMaterial({ color: 0x3a3a3a }),
    rope: new THREE.MeshLambertMaterial({ color: 0xd8b070, emissive: 0x302010 }),
    ring: new THREE.MeshLambertMaterial({ color: 0xffc933, emissive: 0x7a5200 }),
    vine: new THREE.MeshLambertMaterial({ color: 0x2f6b2a }),
    spire: new THREE.MeshPhongMaterial({ color: 0x2a1610, flatShading: true, shininess: 0 }),
    rune: new THREE.MeshBasicMaterial({ color: 0x6fe0ff }),
  });
  Object.assign(GEO, {
    blade: new THREE.BoxGeometry(2.1, 1.1, 0.16),
    spikeBall: new THREE.IcosahedronGeometry(0.8, 0),
    spike: new THREE.ConeGeometry(0.14, 0.5, 5),
    swingLog: new THREE.CylinderGeometry(0.55, 0.55, 2.1, 10).rotateZ(Math.PI / 2),
    tallPillar: new THREE.BoxGeometry(0.9, 9, 0.9),
    ring: new THREE.TorusGeometry(0.45, 0.1, 8, 20),
    rope: new THREE.CylinderGeometry(0.04, 0.04, 1, 5).translate(0, 0.5, 0), // unit length along +Y
    spire: new THREE.ConeGeometry(2.2, 34, 6),
  });
  const SWING_PIVOT = 7.6;  // height of a swinging trap's pivot
  const SWING_LEN = 6.7;    // pivot → trap head (head hangs at ~0.9m)
  const UP = new THREE.Vector3(0, 1, 0);

  /* ---------- Biomes: atmosphere, materials, scenery & obstacle mix ---------- */
  const BIOME_ORDER = ['ruins', 'lava', 'jungle'];
  const BIOMES = {
    ruins: {
      name: 'Ancient Ruins', fog: 0xb4c4a0, near: 25, far: 125,
      ground: 0x2f4a2a, groundGlow: 0x000000, sky: 0xfff1d6, skyGround: 0x2d3b22, sun: 0xffe2b0,
      mats: { floor: MAT.floor, curb: MAT.curb, wall: MAT.wall, pillar: MAT.pillar },
      deco: 'trees',
      weights: { log: 3, overhead: 2, rock: 3, gap: 1.8, halfgap: 1.4, swing: 1.6, slider: 1.6, collapse: 1.5, canyon: 1.1, coins: 2.4, powerup: 0.4 },
    },
    lava: {
      name: 'Lava Cavern', fog: 0x3a1610, near: 18, far: 105,
      ground: 0xff5a14, groundGlow: 0xff3a00, sky: 0xffa070, skyGround: 0x401008, sun: 0xff8a4a,
      mats: {
        floor: new THREE.MeshLambertMaterial({ map: stoneTexture(12, 18, 24, '#ff5a10', false), emissive: 0x1a0500 }),
        curb: new THREE.MeshLambertMaterial({ map: stoneTexture(10, 14, 16, '#c43a08', false) }),
        wall: new THREE.MeshLambertMaterial({ map: stoneTexture(8, 16, 18, '#8a2a06', false) }),
        pillar: new THREE.MeshLambertMaterial({ color: 0x2a1a14 }),
      },
      deco: 'spires',
      weights: { log: 0, overhead: 3.5, rock: 2.5, gap: 2.5, halfgap: 1.5, swing: 1.4, slider: 2, collapse: 2.6, canyon: 1.6, coins: 2, powerup: 0.4 },
    },
    jungle: {
      name: 'Deep Jungle', fog: 0x6f9a68, near: 20, far: 115,
      ground: 0x1d3a1a, groundGlow: 0x000000, sky: 0xe6ffd0, skyGround: 0x1f3a12, sun: 0xfff2c0,
      mats: {
        floor: new THREE.MeshLambertMaterial({ map: stoneTexture(80, 14, 40, '#24301a', true) }),
        curb: new THREE.MeshLambertMaterial({ map: stoneTexture(95, 20, 30, '#18220f', true) }),
        wall: new THREE.MeshLambertMaterial({ map: stoneTexture(85, 15, 32, '#1a2410', true) }),
        pillar: new THREE.MeshLambertMaterial({ color: 0x3a4a2a }),
      },
      deco: 'jungle',
      weights: { log: 3.5, overhead: 2.5, rock: 2, gap: 1.6, halfgap: 1.6, swing: 2.6, slider: 1, collapse: 1.2, canyon: 1.4, coins: 2.4, powerup: 0.4 },
    },
  };
  const biomeAt = (d) => BIOME_ORDER[Math.floor(Math.max(0, d) / CFG.BIOME_LENGTH) % BIOME_ORDER.length];
  // Cracked (collapsing) tiles: same stone, darker with a reddish glow — the visual tell
  for (const b of Object.values(BIOMES)) {
    b.mats.cracked = b.mats.floor.clone();
    b.mats.cracked.color = new THREE.Color(0x9a6a50);
    b.mats.cracked.emissive = new THREE.Color(0x3a1000);
  }

  /**
   * Box mesh with UVs scaled so the texture keeps a constant world size
   * on every face (no stretching on long floor pieces).
   */
  function boxUV(seg, w, h, d, mat) {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv;
    // Face order in BoxGeometry: +x, -x, +y, -y, +z, -z (4 vertices each)
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, uv.getX(i) * dims[f][0] / TEX_SIZE, uv.getY(i) * dims[f][1] / TEX_SIZE);
      }
    }
    seg.geos.push(g); // disposed with the segment
    return new THREE.Mesh(g, mat);
  }

  /* =======================================================================
   * 7. PARTICLES (pooled debris / sparkles)
   * ===================================================================== */
  const Particles = {
    pools: { solid: [], glow: [] }, // glow = additive sparkles that fade out
    init() {
      for (const kind of ['solid', 'glow']) {
        for (let i = 0; i < 110; i++) {
          const mat = kind === 'glow'
            ? new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
            : new THREE.MeshBasicMaterial({ color: 0xffffff });
          const m = new THREE.Mesh(GEO.box, mat);
          m.visible = false;
          scene.add(m);
          this.pools[kind].push({ m, v: new THREE.Vector3(), life: 0, max: 1, g: 20 });
        }
      }
    },
    /** opts: { glow: additive sparkle, gravity: units/s² (negative rises), life: multiplier } */
    spawn(pos, color, n, speed = 6, size = 0.18, opts = {}) {
      const pool = this.pools[opts.glow ? 'glow' : 'solid'];
      for (const p of pool) {
        if (n <= 0) break;
        if (p.life > 0) continue;
        p.m.material.color.setHex(color);
        p.m.position.copy(pos);
        p.m.scale.setScalar(size * rand(0.6, 1.3));
        p.v.set(rand(-1, 1), rand(0.3, 1.4), rand(-1, 1)).multiplyScalar(speed);
        p.g = opts.gravity !== undefined ? opts.gravity : 20;
        p.life = p.max = (opts.life || 1) * rand(0.4, 0.9);
        p.m.visible = true;
        n--;
      }
    },
    update(dt) {
      for (const kind in this.pools) {
        for (const p of this.pools[kind]) {
          if (p.life <= 0) continue;
          p.life -= dt;
          p.v.y -= p.g * dt;
          p.m.position.addScaledVector(p.v, dt);
          p.m.rotation.x += dt * 8; p.m.rotation.y += dt * 6;
          if (kind === 'glow') p.m.material.opacity = clamp(p.life / p.max, 0, 1);
          if (p.life <= 0) p.m.visible = false;
        }
      }
    },
  };
  Particles.init();

  /* =======================================================================
   * 8. CHARACTERS, UPGRADES
   * ===================================================================== */
  const CHARACTERS = [
    { id: 'jack', name: 'Jack Rook', title: 'Explorer', cost: 0, perk: 'Balanced all-rounder', emoji: '🤠', style: 'hat',
      colors: { shirt: 0xc9a66b, pants: 0x6b5236, skin: 0xe8b98f, hair: 0x4a3220, boots: 0x3b2a1c, accent: 0x7b5530 } },
    { id: 'mara', name: 'Mara Vance', title: 'Treasure Hunter', cost: 300, perk: 'Coin Magnet lasts +2s', emoji: '🧭', style: 'ponytail',
      colors: { shirt: 0xb8322c, pants: 0x2f3a4a, skin: 0xf0c4a0, hair: 0x8a3a1a, boots: 0x2a1c14, accent: 0x8a3a1a } },
    { id: 'kenji', name: 'Kenji Sato', title: 'Daredevil', cost: 600, perk: 'Jumps 12% higher', emoji: '🥷', style: 'bandana',
      colors: { shirt: 0x2f6fb5, pants: 0x2b2b2b, skin: 0xe2b08a, hair: 0x121212, boots: 0x1a1a1a, accent: 0xd8302c } },
    { id: 'zara', name: 'Zara Okoye', title: 'Scholar', cost: 1000, perk: 'Power meter charges 20% faster', emoji: '📜', style: 'glasses',
      colors: { shirt: 0x3e8f5a, pants: 0x6b4a2b, skin: 0x8a5a3c, hair: 0x1a1010, boots: 0x2a1c14, accent: 0x111111 } },
  ];
  const charById = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];

  const UPGRADES = [
    { id: 'magnet', name: 'Coin Magnet', icon: '🧲', desc: '+2s magnet duration per level', max: 5, cost: (l) => 150 * (l + 1) },
    { id: 'boost', name: 'Boost', icon: '⚡', desc: '+1s boost duration per level', max: 5, cost: (l) => 150 * (l + 1) },
    { id: 'meter', name: 'Quick Charge', icon: '🔋', desc: 'Power meter fills 12% faster per level', max: 4, cost: (l) => 250 * (l + 1) },
    { id: 'multi', name: 'Score Multiplier', icon: '✖️', desc: '+1x score multiplier per level', max: 4, cost: (l) => 400 * (l + 1) },
    { id: 'shieldStart', name: 'Starting Shield', icon: '🛡️', desc: 'Begin every run with a shield', max: 1, cost: () => 800 },
  ];
  const POWER_NAMES = { boost: 'Boost', magnet: 'Coin Magnet', shield: 'Shield' };

  const upg = (id) => Save.data.upgrades[id] || 0;
  const magnetDuration = () => CFG.MAGNET_TIME + 2 * upg('magnet') + (Save.data.character === 'mara' ? 2 : 0);
  const boostDuration = () => CFG.BOOST_TIME + upg('boost');
  const meterMax = () => Math.round(CFG.METER_BASE * (1 - 0.12 * upg('meter')) * (Save.data.character === 'zara' ? 0.8 : 1));
  const jumpMul = () => (Save.data.character === 'kenji' ? 1.06 : 1); // sqrt(1.12) on velocity ≈ 12% higher apex

  /* =======================================================================
   * 9. 3D MODELS — runner & demon monkeys (built from primitives)
   * ===================================================================== */
  function boxMesh(w, h, d, mat) {
    const m = new THREE.Mesh(GEO.box, mat);
    m.scale.set(w, h, d);
    return m;
  }

  /** Blocky low-poly runner. Faces -Z. Returns handles for animation. */
  function buildRunner(ch) {
    const c = ch.colors;
    const M = (col) => new THREE.MeshLambertMaterial({ color: col });
    const skin = M(c.skin), shirt = M(c.shirt), pants = M(c.pants), boots = M(c.boots), hair = M(c.hair), accent = M(c.accent);

    const root = new THREE.Group();   // position + yaw
    const body = new THREE.Group();   // lean / slide / tumble
    root.add(body);

    const torso = boxMesh(0.62, 0.72, 0.36, shirt); torso.position.y = 1.3; body.add(torso);
    const belt = boxMesh(0.64, 0.1, 0.38, boots); belt.position.y = 0.97; body.add(belt);
    const pack = boxMesh(0.45, 0.5, 0.18, accent); pack.position.set(0, 1.35, 0.27); body.add(pack);
    const head = boxMesh(0.4, 0.42, 0.4, skin); head.position.y = 1.9; body.add(head);
    const hairTop = boxMesh(0.43, 0.13, 0.43, hair); hairTop.position.y = 2.12; body.add(hairTop);
    const hairBack = boxMesh(0.43, 0.3, 0.08, hair); hairBack.position.set(0, 1.98, 0.2); body.add(hairBack);
    const eyeMat = M(0x111111);
    for (const ex of [-0.09, 0.09]) { const e = boxMesh(0.06, 0.06, 0.02, eyeMat); e.position.set(ex, 1.93, -0.205); body.add(e); }

    if (ch.style === 'hat') {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 16), accent); brim.position.y = 2.17; body.add(brim);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.24, 16), accent); crown.position.y = 2.3; body.add(crown);
    } else if (ch.style === 'ponytail') {
      const tail = boxMesh(0.14, 0.42, 0.14, hair); tail.position.set(0, 1.85, 0.28); body.add(tail);
    } else if (ch.style === 'bandana') {
      const band = boxMesh(0.45, 0.1, 0.45, accent); band.position.y = 2.03; body.add(band);
      const knot = boxMesh(0.08, 0.22, 0.05, accent); knot.position.set(0.08, 1.93, 0.25); knot.rotation.z = 0.5; body.add(knot);
    } else if (ch.style === 'glasses') {
      const gl = boxMesh(0.42, 0.08, 0.04, accent); gl.position.set(0, 1.93, -0.215); body.add(gl);
    }

    function limb(px, py, w, h, mat, endMat) {
      const pivot = new THREE.Group();
      pivot.position.set(px, py, 0);
      const l = boxMesh(w, h, w, mat); l.position.y = -h / 2; pivot.add(l);
      const end = boxMesh(w + 0.03, 0.16, w + 0.1, endMat); end.position.set(0, -h + 0.05, -0.04); pivot.add(end);
      body.add(pivot);
      return pivot;
    }
    const armL = limb(-0.42, 1.62, 0.17, 0.62, shirt, skin);
    const armR = limb(0.42, 1.62, 0.17, 0.62, shirt, skin);
    const legL = limb(-0.17, 0.95, 0.22, 0.88, pants, boots);
    const legR = limb(0.17, 0.95, 0.22, 0.88, pants, boots);

    return { root, body, armL, armR, legL, legR, mats: [skin, shirt, pants, boots, hair, accent, eyeMat] };
  }

  /** Hunched, long-armed demon monkey with glowing red eyes. */
  function buildMonkey() {
    const root = new THREE.Group();
    const body = new THREE.Group(); root.add(body);
    const torso = boxMesh(0.85, 0.85, 0.65, MAT.monkey); torso.position.set(0, 1.0, 0.05); torso.rotation.x = -0.35; body.add(torso);
    const head = new THREE.Mesh(GEO.sphere, MAT.monkey); head.scale.setScalar(0.36); head.position.set(0, 1.55, -0.3); body.add(head);
    const face = new THREE.Mesh(GEO.sphere, MAT.monkeyFace); face.scale.set(0.25, 0.22, 0.15); face.position.set(0, 1.5, -0.6); body.add(face);
    for (const ex of [-0.12, 0.12]) {
      const e = new THREE.Mesh(GEO.sphere, MAT.monkeyEye); e.scale.setScalar(0.06); e.position.set(ex, 1.62, -0.62); body.add(e);
      const ear = new THREE.Mesh(GEO.sphere, MAT.monkeyFace); ear.scale.set(0.1, 0.12, 0.06); ear.position.set(ex * 3.2, 1.62, -0.3); body.add(ear);
    }
    function limb(px, py, len, w) {
      const p = new THREE.Group(); p.position.set(px, py, -0.1);
      const l = boxMesh(w, len, w, MAT.monkey); l.position.y = -len / 2; p.add(l);
      body.add(p); return p;
    }
    const armL = limb(-0.5, 1.3, 1.15, 0.2), armR = limb(0.5, 1.3, 1.15, 0.2);
    const legL = limb(-0.25, 0.65, 0.6, 0.24), legR = limb(0.25, 0.65, 0.6, 0.24);
    root.scale.setScalar(0.95);
    scene.add(root);
    return { root, body, armL, armR, legL, legR, phase: Math.random() * 6 };
  }

  let runner = null;
  function setRunnerModel() {
    if (runner) { scene.remove(runner.root); runner.mats.forEach((m) => m.dispose()); }
    runner = buildRunner(charById(Save.data.character));
    scene.add(runner.root);
  }
  setRunnerModel();

  const playerShadow = new THREE.Mesh(GEO.shadow, MAT.shadow);
  scene.add(playerShadow);
  const shieldBubble = new THREE.Mesh(GEO.sphere, MAT.shield);
  shieldBubble.scale.setScalar(1.25);
  scene.add(shieldBubble);
  const magnetRing = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.05, 6, 32), MAT.magnetRing);
  magnetRing.rotation.x = Math.PI / 2;
  scene.add(magnetRing);

  const ropeMesh = new THREE.Mesh(GEO.rope, MAT.rope);
  ropeMesh.visible = false;
  scene.add(ropeMesh);

  const MONKEY_OFFS = [{ x: -1.1, d: 0 }, { x: 1.1, d: 0.7 }, { x: 0, d: 1.6 }];
  const monkeys = MONKEY_OFFS.map(() => buildMonkey());

  /* =======================================================================
   * 10. GAME STATE
   * ===================================================================== */
  /** Player, in track space. */
  const P = {
    seg: null, s: 0, x: 0, y: 0, vy: 0,
    onGround: true, falling: false, coyote: 0, jumpBuffer: 0, fastFall: false, slideQueued: false,
    sliding: false, slideT: 0,
    yaw: 0, yawVis: 0, lean: 0,
    visOff: new THREE.Vector3(), // decays to 0, smooths snaps on turns
    shield: false, phase: 0,
    grapple: null, // { c: canyon, sStart, sEnd, y0 } while swinging
    laneTarget: null, // lane x to glide to after a touch swipe
  };

  /** Per-run state. */
  const G = {
    segments: [],
    distance: 0, coins: 0, score: 0, mult: 1,
    baseSpeed: CFG.BASE_SPEED, speed: CFG.BASE_SPEED, speedMul: 1,
    meter: 0, meterMax: CFG.METER_BASE,
    magnetT: 0, boostT: 0, invulnT: 0,
    stumbleT: 0, chase: 3, introT: 3,
    turnBuffer: null,
    dying: null, deathReason: '',
    trail: [],
    camYaw: 0, camY: 0, shake: 0, fov: 65, fovKick: 0,
    biome: 'ruins',
    time: 0, menuAngle: 0,
  };

  /* =======================================================================
   * 11. TRACK GENERATION
   * ===================================================================== */
  /** World position of track coords on a segment. */
  function segPoint(seg, s, x, out) {
    return out.copy(seg.start).addScaledVector(seg.fwd, s).addScaledVector(seg.right, x);
  }
  function junctionCenter(seg) {
    return seg.start.clone().addScaledVector(seg.fwd, seg.L);
  }

  /**
   * Create a segment starting at `start` (world) heading `dir`.
   * `d0` is the run distance at which the runner will reach its start.
   */
  function createSegment(start, dir, first, d0) {
    const biome = biomeAt(d0);
    const seg = {
      start: start.clone(), dir, first, d0, biome, B: BIOMES[biome],
      fwd: DIRS[dir], right: DIRS[(dir + 1) % 4],
      L: first ? 120 : randInt(75, 135),
      junction: weighted([['L', 3], ['R', 3], ['T', 2]]),
      obstacles: [], coins: [], pickups: [], gaps: [], halfGaps: [], flames: [], geos: [],
      movers: [], collapses: [], canyons: [],
      childL: null, childR: null,
      group: new THREE.Group(),
    };
    seg.group.position.copy(seg.start);
    seg.group.rotation.y = -dir * Math.PI / 2;
    scene.add(seg.group);
    populateSegment(seg);
    buildSegmentGeometry(seg);
    G.segments.push(seg);
    return seg;
  }

  function disposeSegment(seg) {
    scene.remove(seg.group);
    for (const c of seg.coins) if (c.mesh.parent) c.mesh.parent.remove(c.mesh); // magnet-flying coins
    for (const g of seg.geos) g.dispose();
    const i = G.segments.indexOf(seg);
    if (i >= 0) G.segments.splice(i, 1);
  }

  /** Generate the branch segment(s) after this segment's junction. */
  function buildChildren(seg) {
    const c = junctionCenter(seg);
    const d0 = seg.d0 + seg.L;
    if (seg.junction !== 'R') seg.childL = createSegment(c, (seg.dir + 3) % 4, false, d0);
    if (seg.junction !== 'L') seg.childR = createSegment(c, (seg.dir + 1) % 4, false, d0);
  }
  const allowsTurn = (seg, side) => (side < 0 ? !!seg.childL : !!seg.childR);

  // ---------- content placement ----------
  const coinValue = () => weighted([[1, 80], [2, 15], [3, 5]]);

  function addCoin(seg, s, x, y, value) {
    const m = new THREE.Mesh(GEO.coin, COIN_MATS[value]);
    m.position.set(x, y, -s);
    m.rotation.y = Math.random() * Math.PI;
    seg.group.add(m);
    seg.coins.push({ s, x, y, value, mesh: m, taken: false, flying: false });
  }
  function coinLine(seg, x, s0, n, y = 1.0, step = 2) {
    const v = coinValue();
    for (let i = 0; i < n; i++) addCoin(seg, s0 + i * step, x, y, v);
  }
  /** Arc of coins following a jump over `center`. */
  function coinArc(seg, x, center, half = 5, n = 7, peak = 1.5) {
    const v = coinValue();
    for (let i = 0; i < n; i++) {
      const t = -1 + (2 * i) / (n - 1);
      addCoin(seg, center + t * half, x, 0.9 + peak * (1 - t * t), v);
    }
  }

  function makePickupMesh(type) {
    const g = new THREE.Group();
    let core;
    if (type === 'magnet') {
      core = new THREE.Mesh(GEO.magnet, new THREE.MeshLambertMaterial({ color: 0xe8333a, emissive: 0x501010 }));
      core.rotation.z = Math.PI;
    } else if (type === 'boost') {
      core = new THREE.Mesh(GEO.boost, new THREE.MeshLambertMaterial({ color: 0xffb020, emissive: 0x6a3a00 }));
    } else {
      core = new THREE.Mesh(GEO.shieldGem, new THREE.MeshLambertMaterial({ color: 0x4aa8ff, emissive: 0x103a70 }));
    }
    g.add(core);
    const halo = new THREE.Mesh(GEO.halo, MAT.halo);
    g.add(halo);
    g.userData.core = core;
    return g;
  }
  function addPickup(seg, s, x, type) {
    const m = makePickupMesh(type);
    m.position.set(x, 1.2, -s);
    seg.group.add(m);
    seg.pickups.push({ s, x, type, mesh: m, taken: false });
  }

  function addLog(seg, s) {
    const m = new THREE.Mesh(GEO.log, MAT.log);
    m.position.set(0, 0.45, -s);
    m.rotation.x = rand(-0.3, 0.3);
    seg.group.add(m);
    seg.obstacles.push({ type: 'log', s0: s - 0.45, s1: s + 0.45, x0: -3, x1: 3, mesh: m, hit: false, color: 0x6b4626 });
  }

  /** Stone gate with a curtain of fire hanging from the beam — slide under it. */
  function addFire(seg, s) {
    const g = new THREE.Group();
    g.position.set(0, 0, -s);
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(GEO.archPillar, seg.B.mats.wall);
      p.position.set(side * (CFG.HALF_W + 0.45), 1.8, 0);
      g.add(p);
    }
    const beam = new THREE.Mesh(GEO.archTop, seg.B.mats.wall);
    beam.position.y = 2.55;
    g.add(beam);
    for (let i = 0; i < 9; i++) {
      const x = -2.8 + i * 0.7;
      const f = new THREE.Mesh(GEO.flame, MAT.flame);
      f.rotation.x = Math.PI; f.position.set(x, 1.62, 0);
      const core = new THREE.Mesh(GEO.flameCore, MAT.flameCore);
      core.rotation.x = Math.PI; core.position.set(x, 1.8, 0);
      g.add(f, core);
      seg.flames.push(f, core);
    }
    seg.group.add(g);
    seg.obstacles.push({ type: 'overhead', reason: 'burn', s0: s - 0.5, s1: s + 0.5, x0: -3, x1: 3, mesh: g, hit: false, color: 0xff8a20 });
  }

  /** Jungle variant of the overhead obstacle: a low fallen tree — slide under it. */
  function addBranch(seg, s) {
    const g = new THREE.Group();
    g.position.set(0, 0, -s);
    const trunk = new THREE.Mesh(GEO.log, MAT.log);
    trunk.position.y = 1.6;
    trunk.rotation.x = rand(-0.2, 0.2);
    g.add(trunk);
    for (const side of [-1, 1]) {
      const post = boxMesh(0.8, 2.2, 0.8, MAT.trunk);
      post.position.set(side * (CFG.HALF_W + 0.45), 1.1, 0);
      g.add(post);
    }
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(GEO.canopy, pick(MAT.leaves));
      leaf.scale.setScalar(rand(0.16, 0.26));
      leaf.position.set(rand(-3, 3), 2.05 + rand(0, 0.2), rand(-0.3, 0.3));
      g.add(leaf);
    }
    seg.group.add(g);
    seg.obstacles.push({ type: 'overhead', reason: 'branch', s0: s - 0.5, s1: s + 0.5, x0: -3, x1: 3, mesh: g, hit: false, color: 0x6b4626 });
  }

  /**
   * Swinging trap on a tall gantry: an axe blade (Ruins), spiked lava ball
   * (Lava Cavern) or battering log (Jungle) sweeping across every lane.
   * Time your lane change — or jump it at the bottom of the swing.
   */
  function addSwing(seg, s, phase = rand(0, Math.PI * 2)) {
    const g = new THREE.Group();
    g.position.set(0, 0, -s);
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(GEO.tallPillar, seg.B.mats.wall);
      p.position.set(side * (CFG.HALF_W + 0.45), 4.5, 0);
      g.add(p);
    }
    const beam = new THREE.Mesh(GEO.archTop, seg.B.mats.wall);
    beam.position.y = SWING_PIVOT + 0.45;
    g.add(beam);
    const pivot = new THREE.Group();
    pivot.position.y = SWING_PIVOT;
    g.add(pivot);
    const rod = boxMesh(0.12, SWING_LEN, 0.12, MAT.chain);
    rod.position.y = -SWING_LEN / 2;
    pivot.add(rod);
    let head;
    if (seg.biome === 'jungle') {
      head = new THREE.Mesh(GEO.swingLog, MAT.log);
    } else if (seg.biome === 'lava') {
      head = new THREE.Group();
      head.add(new THREE.Mesh(GEO.spikeBall, MAT.bladeHot));
      for (let i = 0; i < 10; i++) {
        const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
        const sp = new THREE.Mesh(GEO.spike, MAT.bladeHot);
        sp.position.copy(d).multiplyScalar(0.85);
        sp.quaternion.setFromUnitVectors(UP, d);
        head.add(sp);
      }
    } else {
      head = new THREE.Mesh(GEO.blade, MAT.blade);
    }
    head.position.y = -SWING_LEN;
    pivot.add(head);
    seg.group.add(g);
    const o = {
      type: 'swing', s0: s - 0.45, s1: s + 0.45, x0: -3, x1: 3, mesh: g, pivot, hit: false, color: 0x9a9aa0,
      amp: 0.46, omega: 2.1, phase, bx: 0, by: 0.9, lastSide: 0,
    };
    seg.obstacles.push(o);
    seg.movers.push(o);
  }

  /** Stone block sliding back and forth across the lanes on a rail. */
  function addSlider(seg, s) {
    const rail = boxMesh(CFG.PATH_W, 0.06, 0.35, MAT.chain);
    rail.position.set(0, 0.03, -s);
    seg.group.add(rail);
    const g = new THREE.Group();
    g.position.set(0, 0, -s);
    const block = boxMesh(1.8, 1.1, 1.3, seg.B.mats.wall);
    block.position.y = 0.55;
    g.add(block);
    const rune = boxMesh(1.2, 0.16, 0.02, MAT.rune); // faces the runner (+Z)
    rune.position.set(0, 0.75, 0.66);
    g.add(rune);
    seg.group.add(g);
    const o = {
      type: 'slider', s0: s - 0.65, s1: s + 0.65, x0: -0.95, x1: 0.95, mesh: g, hit: false, clipped: false,
      color: 0x7a7060, jumpH: 1.1, range: 2.05, omega: rand(1.4, 2.0), phase: rand(0, Math.PI * 2),
    };
    seg.obstacles.push(o);
    seg.movers.push(o);
  }

  /**
   * Collapsing floor: a run of tiles where the cracked (dark, glowing) ones
   * shake as you approach and drop away just before you reach them — jump!
   * The rest crumble behind you. Returns the length used.
   */
  function addCollapse(seg, s, speed) {
    const n = 5, len = 2.4;
    const cracked = speed > 18 ? 3 : 2;
    const first = randInt(1, n - cracked - 1);
    const sec = { s0: s, s1: s + n * len, tiles: [] };
    for (let i = 0; i < n; i++) {
      const isCracked = i >= first && i < first + cracked;
      const t0 = s + i * len;
      const m = boxUV(seg, CFG.PATH_W - 0.06, 1.2, len - 0.08, isCracked ? seg.B.mats.cracked : seg.B.mats.floor);
      m.position.set(0, -0.6, -(t0 + len / 2));
      seg.group.add(m);
      sec.tiles.push({ s0: t0, s1: t0 + len, cracked: isCracked, mesh: m, state: 'solid', t: 0, vy: 0 });
    }
    seg.collapses.push(sec);
    coinArc(seg, pick(CFG.LANES), s + (first + cracked / 2) * len, 4.5, 6, 1.5);
    return n * len;
  }

  /**
   * Canyon: far too wide to jump. A golden hook ring hangs from a gantry
   * above the middle — fire the grappling hook (E / Shift) to swing across.
   */
  function addCanyon(seg, s, speed) {
    const len = canyonLength(speed);
    const c = { s0: s, s1: s + len, anchorS: s + len / 2, anchorY: 9 };
    seg.canyons.push(c);
    const g = new THREE.Group();
    g.position.set(0, 0, -c.anchorS);
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(GEO.pillar, seg.B.mats.pillar);
      p.position.set(side * (CFG.HALF_W + 1.4), -3, 0);
      g.add(p);
    }
    const beam = boxMesh(CFG.PATH_W + 5.2, 0.8, 1.4, seg.B.mats.wall);
    beam.position.y = 10.4;
    g.add(beam);
    const chain = boxMesh(0.1, 0.6, 0.1, MAT.chain);
    chain.position.y = 9.75;
    g.add(chain);
    const ring = new THREE.Mesh(GEO.ring, MAT.ring);
    ring.position.y = c.anchorY;
    g.add(ring);
    const halo = new THREE.Mesh(GEO.halo, MAT.halo);
    halo.position.y = c.anchorY;
    halo.scale.setScalar(1.3);
    g.add(halo);
    c.ring = ring; c.halo = halo;
    seg.group.add(g);
    // reward coins along a typical swing arc
    const a = s - 6, b = c.s1 + 2.5;
    const v = coinValue();
    for (let sc = s + 1; sc < c.s1; sc += 2.2) {
      const t = (sc - a) / (b - a);
      addCoin(seg, sc, 0, 0.9 + 0.5 * t + CFG.GRAPPLE_ARC * Math.sin(Math.PI * t), v);
    }
    return len;
  }
  /** Canyon width grows with speed so it always out-ranges a normal jump. */
  const canyonLength = (speed) => clamp(speed * 1.05, 14, 32);

  /** Rubble block filling one lane — dodge sideways or jump. */
  function addRock(seg, s, lane) {
    const cx = CFG.LANES[lane];
    const g = new THREE.Group();
    g.position.set(cx, 0, -s);
    const block = boxMesh(1.8, 1.3, 1.4, seg.B.mats.wall); block.position.y = 0.65; g.add(block);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(GEO.rubble, seg.B.mats.wall);
      r.position.set(rand(-0.6, 0.6), 1.3 + rand(0, 0.2), rand(-0.4, 0.4));
      r.scale.setScalar(rand(0.5, 0.9)); r.rotation.set(rand(0, 3), rand(0, 3), 0);
      g.add(r);
    }
    seg.group.add(g);
    seg.obstacles.push({ type: 'rock', s0: s - 0.7, s1: s + 0.7, x0: cx - 0.95, x1: cx + 0.95, mesh: g, hit: false, clipped: false, color: 0x7a7060, jumpH: 1.25 });
  }

  /**
   * Fill a segment with obstacle / coin patterns. Spacing scales with the
   * current speed so there's always time to react.
   */
  function populateSegment(seg) {
    // Difficulty and speed estimated for when the runner will actually get here.
    const diff = clamp(seg.d0 / 2500, 0, 1);
    const speed = Math.min(CFG.MAX_SPEED, CFG.BASE_SPEED + seg.d0 * CFG.SPEED_RAMP);
    const W = seg.B.weights;
    let s = seg.first ? 45 : 22;
    const end = seg.L - 18;

    while (true) {
      s += Math.max(speed * 0.85, 11) * rand(1.0, 1.7 - diff * 0.5);
      if (s > end) break;
      let type = weighted([
        ['log', W.log], ['overhead', W.overhead], ['rock', W.rock],
        ['gap', diff > 0.04 ? W.gap : W.gap * 0.3], ['halfgap', W.halfgap],
        ['swing', W.swing], ['slider', W.slider], ['collapse', W.collapse], ['canyon', W.canyon],
        ['coins', W.coins - diff], ['powerup', W.powerup],
      ]);
      // long features must fit before the junction
      if (type === 'canyon' && s + canyonLength(speed) + 4 > end) type = 'coins';
      if (type === 'collapse' && s + 12 > end) type = 'coins';
      const lane = randInt(0, 2);
      switch (type) {
        case 'log':
          addLog(seg, s);
          if (Math.random() < 0.6) coinArc(seg, CFG.LANES[lane], s);
          s += 1;
          break;
        case 'overhead':
          if (seg.biome === 'jungle') addBranch(seg, s); else addFire(seg, s);
          if (Math.random() < 0.6) coinLine(seg, CFG.LANES[lane], s - 4, 5, 0.55);
          s += 1;
          break;
        case 'rock': {
          // block one or two lanes, always leave at least one free
          const blocked = [0, 1, 2].sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.35 + diff * 0.4 ? 2 : 1);
          blocked.forEach((l) => addRock(seg, s, l));
          const free = [0, 1, 2].filter((l) => !blocked.includes(l));
          coinLine(seg, CFG.LANES[pick(free)], s - 6, 7);
          s += 2;
          break;
        }
        case 'gap': {
          const len = rand(2.8, 3.6 + diff * 1.2);
          seg.gaps.push({ s0: s, s1: s + len });
          if (Math.random() < 0.7) coinArc(seg, CFG.LANES[lane], s + len / 2, 5, 7, 1.4);
          s += len;
          break;
        }
        case 'halfgap': {
          const len = rand(6, 11);
          const side = Math.random() < 0.5 ? -1 : 1; // which half is missing
          seg.halfGaps.push({ s0: s, s1: s + len, side });
          coinLine(seg, -side * 1.6, s, Math.floor(len / 2) + 1);
          s += len;
          break;
        }
        case 'swing': {
          const ph = rand(0, Math.PI * 2);
          addSwing(seg, s, ph);
          coinLine(seg, CFG.LANES[lane], s - 4, 5);
          // later on: a second trap swinging in opposition — no safe lane to wait in
          if (diff > 0.25 && s + 7 < end) { addSwing(seg, s + 6, ph + Math.PI); s += 6; }
          s += 1;
          break;
        }
        case 'slider':
          addSlider(seg, s);
          coinArc(seg, 0, s, 4, 5, 1.6);
          s += 1.5;
          break;
        case 'collapse':
          s += addCollapse(seg, s, speed);
          break;
        case 'canyon':
          s += addCanyon(seg, s, speed) + 4; // landing room
          break;
        case 'coins': {
          const n = Math.max(3, Math.min(randInt(7, 11), Math.floor((end + 8 - s) / 2)));
          if (Math.random() < 0.4) {
            // zig-zag across lanes to reward leaning
            const v = coinValue();
            for (let i = 0; i < n; i++) addCoin(seg, s + i * 2, Math.sin(i * 0.6) * 2, 1.0, v);
          } else coinLine(seg, CFG.LANES[lane], s, n);
          s += n * 2;
          break;
        }
        case 'powerup':
          addPickup(seg, s, CFG.LANES[lane], weighted([['magnet', 3], ['boost', 2], ['shield', 2]]));
          s += 1;
          break;
      }
    }
  }

  /** Floors, curbs, support pillars, the junction wall and jungle trees. */
  function buildSegmentGeometry(seg) {
    const grp = seg.group;
    const H = CFG.HALF_W;
    const sA = seg.first ? -25 : H;
    const sB = seg.L + H;
    const openL = seg.junction !== 'R';
    const openR = seg.junction !== 'L';
    const M = seg.B.mats;

    function floor(s0, s1, x0, x1) {
      if (s1 - s0 < 0.01) return;
      const m = boxUV(seg, x1 - x0, 1.2, s1 - s0, M.floor);
      m.position.set((x0 + x1) / 2, -0.6, -(s0 + s1) / 2);
      grp.add(m);
      for (let s = Math.ceil(s0 / 16) * 16; s < s1 - 1; s += 16) {
        const p = new THREE.Mesh(GEO.pillar, M.pillar);
        p.position.set((x0 + x1) / 2, -14.2, -s);
        grp.add(p);
      }
    }
    function curb(side, s0, s1) {
      // Leave the junction side open where the path turns
      if ((side < 0 && openL) || (side > 0 && openR)) s1 = Math.min(s1, seg.L - H);
      else if (s1 >= sB - 0.01) s1 = sB + 0.6; // close the corner
      if (s1 - s0 < 0.3) return;
      const m = boxUV(seg, 0.6, 1.75, s1 - s0, M.curb);
      m.position.set(side * (H + 0.3), -0.325, -(s0 + s1) / 2);
      grp.add(m);
      for (let s = Math.ceil(s0 / 14) * 14 + 7; s < s1 - 1; s += 14) {
        const col = new THREE.Mesh(GEO.column, M.curb);
        col.position.set(side * (H + 0.3), 1.4, -s);
        const cap = new THREE.Mesh(GEO.columnCap, M.curb);
        cap.position.set(side * (H + 0.3), 2.35, -s);
        grp.add(col, cap);
      }
    }

    // Walk along the segment cutting out gaps.
    // (collapse sections build their own tiles but keep the side curbs)
    const cuts = seg.gaps.map((g) => ({ ...g, full: true }))
      .concat(seg.canyons.map((c) => ({ s0: c.s0, s1: c.s1, full: true })))
      .concat(seg.collapses.map((c) => ({ s0: c.s0, s1: c.s1, full: true, keepCurbs: true })))
      .concat(seg.halfGaps.map((g) => ({ ...g, full: false })))
      .sort((a, b) => a.s0 - b.s0);
    let cur = sA, curbFrom = sA;
    for (const c of cuts) {
      floor(cur, c.s0, -H, H);
      if (!c.keepCurbs) {
        curb(-1, curbFrom, c.s0); curb(1, curbFrom, c.s0);
        curbFrom = c.s1;
      }
      if (!c.full) {
        // keep the solid half
        if (c.side < 0) { floor(c.s0, c.s1, 0, H); curb(1, c.s0, c.s1); }
        else { floor(c.s0, c.s1, -H, 0); curb(-1, c.s0, c.s1); }
      }
      cur = c.s1;
    }
    floor(cur, sB, -H, H);
    curb(-1, curbFrom, sB); curb(1, curbFrom, sB);

    // Carved wall at the end of the junction — you must turn.
    const wall = boxUV(seg, CFG.PATH_W + 1.8, 5, 1.2, M.wall);
    wall.position.set(0, 1.3, -(sB + 0.6));
    grp.add(wall);
    const glyph = boxMesh(1.2, 1.2, 0.1, MAT.flameCore);
    glyph.position.set(0, 2.4, -(sB - 0.02));
    glyph.rotation.z = Math.PI / 4;
    grp.add(glyph);

    // Scenery rising from far below (kept clear of neighbouring paths):
    // trees in the Ruins, dense trees + vines in the Jungle, basalt spires in Lava.
    const deco = seg.B.deco;
    const tStart = seg.first ? -20 : 10;
    for (let s = tStart; s < seg.L - 9; s += deco === 'jungle' ? rand(4, 8) : rand(7, 13)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (deco === 'jungle' ? rand(7, 14) : rand(8, 16));
      if (deco === 'spires') {
        const sp = new THREE.Mesh(GEO.spire, MAT.spire);
        sp.position.set(x, -16 + rand(-4, 6), -s);
        sp.scale.set(rand(0.6, 1.3), rand(0.8, 1.1), rand(0.6, 1.3));
        grp.add(sp);
        if (Math.random() < 0.35) { // stalactite hanging out of the dark
          const st = new THREE.Mesh(GEO.spire, MAT.spire);
          st.rotation.x = Math.PI;
          st.scale.set(0.35, 0.4, 0.35);
          st.position.set(-side * rand(5, 10), 16, -s - rand(0, 5));
          grp.add(st);
        }
        continue;
      }
      if (deco === 'jungle' && Math.random() < 0.6) {
        const vine = boxMesh(0.08, rand(2.5, 4.5), 0.08, MAT.vine);
        vine.position.set(side * rand(3.3, 4.3), 7.5 - vine.scale.y / 2, -s);
        grp.add(vine);
      }
      const trunk = new THREE.Mesh(GEO.trunk, MAT.trunk);
      trunk.position.set(x, -12, -s);
      grp.add(trunk);
      const leaf = pick(MAT.leaves);
      for (let k = 0; k < 2; k++) {
        const c = new THREE.Mesh(GEO.canopy, leaf);
        c.position.set(x + rand(-1.5, 1.5), 6.5 + k * 1.8, -s + rand(-1.5, 1.5));
        c.scale.setScalar(rand(0.75, 1.15));
        c.rotation.set(rand(0, 3), rand(0, 3), 0);
        grp.add(c);
      }
    }
  }

  /** Is there solid ground under the runner's centre? */
  function floorAt(seg, s, x) {
    if (s < CFG.HALF_W && !seg.first) return true; // previous junction tile
    if (s > seg.L + CFG.HALF_W) return false;
    for (const g of seg.gaps) if (s > g.s0 + 0.3 && s < g.s1 - 0.3) return false;
    for (const c of seg.canyons) if (s > c.s0 + 0.3 && s < c.s1 - 0.3) return false;
    for (const sec of seg.collapses) {
      // unsupported only if both edges of a 0.6m footprint are over fallen tiles
      if (s > sec.s0 - 0.3 && s < sec.s1 + 0.3 && tileGone(sec, s - 0.3) && tileGone(sec, s + 0.3)) return false;
    }
    for (const h of seg.halfGaps) {
      if (s > h.s0 + 0.3 && s < h.s1 - 0.3 && (h.side < 0 ? x < -0.35 : x > 0.35)) return false;
    }
    return true;
  }

  function tileGone(sec, s) {
    for (const t of sec.tiles) if (s >= t.s0 && s < t.s1) return t.state === 'falling' || t.state === 'gone';
    return false;
  }

  /** Swing pendulums and slide blocks (deterministic from G.time). */
  function updateMovers(seg) {
    for (const o of seg.movers) {
      if (o.hit) continue;
      if (o.type === 'swing') {
        const a = o.amp * Math.sin(G.time * o.omega + o.phase);
        o.pivot.rotation.z = a;
        o.bx = SWING_LEN * Math.sin(a);
        o.by = SWING_PIVOT - SWING_LEN * Math.cos(a);
        // whoosh as it sweeps through the centre near the runner
        const side = Math.sign(o.bx);
        if (seg === P.seg && side !== o.lastSide && Math.abs(o.s0 - P.s) < 18 && state === State.PLAYING) Sfx.swoosh();
        o.lastSide = side;
      } else {
        const x = o.range * Math.sin(G.time * o.omega + o.phase);
        o.mesh.position.x = x;
        o.x0 = x - 0.95; o.x1 = x + 0.95;
      }
    }
  }

  /**
   * Collapsing tiles: cracked tiles start shaking ~1.3s before you arrive and
   * drop ~0.7s before; solid tiles crumble once you're past. Only the current
   * segment triggers, but falling tiles animate everywhere.
   */
  function updateCollapses(seg, dt, isCurrent) {
    for (const sec of seg.collapses) {
      for (const t of sec.tiles) {
        if (t.state === 'gone') continue;
        const ahead = t.s0 - P.s;
        if (t.state === 'solid' && isCurrent) {
          if (t.cracked && ahead < G.speed * 1.3) { t.state = 'shaking'; t.t = 0; }
          else if (!t.cracked && P.s > t.s1 + 1.5) { t.state = 'shaking'; t.t = 0; }
        } else if (t.state === 'shaking') {
          t.t += dt;
          t.mesh.position.x = rand(-0.07, 0.07);
          t.mesh.position.y = -0.6 + rand(-0.05, 0.05);
          if ((t.cracked && ahead < G.speed * 0.7) || (!t.cracked && t.t > 0.3) || !isCurrent) {
            t.state = 'falling';
            t.vy = 0;
            t.mesh.getWorldPosition(_a);
            Particles.spawn(_a, 0x8a7a66, 10, 4, 0.25);
            if (t.cracked) { Sfx.crumble(); G.shake = Math.max(G.shake, 0.18); }
          }
        } else if (t.state === 'falling') {
          t.vy -= 30 * dt;
          t.mesh.position.y += t.vy * dt;
          t.mesh.rotation.x += dt * 0.9;
          if (t.mesh.position.y < -40) { t.state = 'gone'; t.mesh.visible = false; }
        }
      }
    }
  }

  /** Blend fog, sky, lights and the ground far below toward a biome (k=1 snaps). */
  const _col = new THREE.Color();
  function applyAtmosphere(biome, k) {
    const B = BIOMES[biome];
    scene.background.lerp(_col.setHex(B.fog), k);
    scene.fog.color.copy(scene.background);
    scene.fog.near += (B.near - scene.fog.near) * k;
    scene.fog.far += (B.far - scene.fog.far) * k;
    jungleFloor.material.color.lerp(_col.setHex(B.ground), k);
    jungleFloor.material.emissive.lerp(_col.setHex(B.groundGlow), k);
    hemi.color.lerp(_col.setHex(B.sky), k);
    hemi.groundColor.lerp(_col.setHex(B.skyGround), k);
    sun.color.lerp(_col.setHex(B.sun), k);
  }

  /* =======================================================================
   * 12. RUN LIFECYCLE
   * ===================================================================== */
  /** Clear the world and set up a fresh run (also used for the menu backdrop). */
  function resetRun() {
    for (const s of G.segments.slice()) disposeSegment(s);
    G.segments.length = 0;

    Object.assign(G, {
      distance: 0, coins: 0, score: 0, mult: 1 + upg('multi'),
      baseSpeed: CFG.BASE_SPEED, speed: CFG.BASE_SPEED, speedMul: 1,
      meter: 0, meterMax: meterMax(),
      magnetT: 0, boostT: 0, invulnT: 0,
      stumbleT: 0, chase: 2, introT: 3,
      turnBuffer: null, dying: null, deathReason: '',
      camYaw: 0, camY: 0, shake: 0, fovKick: 0, time: 0, biome: 'ruins',
    });
    Object.assign(P, {
      s: 0, x: 0, y: 0, vy: 0, onGround: true, falling: false, coyote: 0, jumpBuffer: 0,
      fastFall: false, slideQueued: false, sliding: false, slideT: 0,
      yaw: 0, yawVis: 0, lean: 0, shield: upg('shieldStart') > 0, phase: 0, grapple: null, laneTarget: null,
    });
    P.visOff.set(0, 0, 0);
    ropeMesh.visible = false;
    applyAtmosphere('ruins', 1);

    const first = createSegment(new THREE.Vector3(0, 0, 0), 0, true, 0);
    P.seg = first;
    buildChildren(first);

    // Pre-fill the chase trail behind the start line so the monkeys have a path.
    G.trail.length = 0;
    for (let k = 40; k >= 0; k -= 0.5) G.trail.push({ d: -k, x: 0, z: k });

    runner.body.rotation.set(0, 0, 0);
    runner.body.position.set(0, 0, 0);
    updateVisuals(0);
  }

  /** Start, but ask for the player's name first if we don't have one yet. */
  function requestStart() {
    if (!Save.data.playerName) { UI.showNameOverlay(true); return; }
    startGame();
  }

  function startGame() {
    Sfx.init();
    resetRun();
    Touch.reset();
    Tilt.calibrate();
    state = State.PLAYING;
    UI.show(null);
    $('hud').classList.remove('hidden');
    $('meter-power-name').textContent = POWER_NAMES[Save.data.meterPower].toUpperCase();
    Sfx.roar();
    Sfx.startMusic();
    UI.toast('RUN!', 'warn');
  }

  function pauseGame() {
    if (state !== State.PLAYING || G.dying) return;
    state = State.PAUSED;
    Sfx.stopMusic();
    UI.updateMuteButton();
    UI.show('screen-pause');
  }
  function resumeGame() {
    if (state !== State.PAUSED) return;
    state = State.PLAYING;
    UI.show(null);
    Sfx.startMusic();
    lastTime = performance.now(); // avoid a huge dt after the pause
  }

  function goToMenu() {
    state = State.START;
    Sfx.stopMusic();
    $('hud').classList.add('hidden');
    resetRun();
    for (const m of monkeys) m.root.visible = false;
    UI.refreshMenu();
    UI.show('screen-start');
  }

  function gameOver() {
    state = State.GAMEOVER;
    Sfx.stopMusic();
    Sfx.gameOver();
    const final = Math.floor(G.distance * G.mult) + G.coins;
    G.score = final;
    const prevBest = Save.best;
    Save.data.bank += G.coins;
    Save.data.highScores.push({
      score: final, distance: Math.floor(G.distance), coins: G.coins,
      character: charById(Save.data.character).name, name: Save.data.playerName || 'Runner', date: Date.now(),
    });
    Save.data.highScores.sort((a, b) => b.score - a.score);
    Save.data.highScores = Save.data.highScores.slice(0, 10);
    Save.save();

    const titles = { caught: 'Caught!', fall: 'You Fell!', wall: 'Splat!', crash: 'Crashed!', burn: 'Scorched!', swing: 'Smacked!', branch: 'Bonk!' };
    const reasons = {
      caught: 'The Demon Monkeys got you.',
      fall: 'You plunged into the abyss.',
      wall: 'You ran straight into a wall. Turn at the corners!',
      crash: 'You ran into an obstacle.',
      burn: 'Slide under the fire traps!',
      swing: 'Time your dodge past swinging traps — or jump them at the bottom of the swing.',
      branch: 'Slide under low branches!',
    };
    $('go-title').textContent = titles[G.deathReason] || 'Game Over';
    $('go-reason').textContent = reasons[G.deathReason] || '';
    $('go-score').textContent = final.toLocaleString();
    $('go-distance').textContent = Math.floor(G.distance).toLocaleString() + ' m';
    $('go-coins').textContent = G.coins.toLocaleString();
    $('go-best').textContent = Save.best.toLocaleString();
    $('go-newbest').classList.toggle('hidden', !(final > prevBest && final > 0));
    $('hud').classList.add('hidden');
    UI.show('screen-gameover');
  }

  /* =======================================================================
   * 13. PLAYER ACTIONS
   * ===================================================================== */
  function jump() {
    if (G.dying || P.grapple) return;
    const canCoyote = P.falling && P.coyote > 0;
    if (P.onGround || canCoyote) {
      P.vy = CFG.JUMP_V * jumpMul();
      P.onGround = false; P.falling = false; P.coyote = 0;
      P.sliding = false; P.slideQueued = false; P.fastFall = false;
      Sfx.jump();
    } else {
      P.jumpBuffer = CFG.JUMP_BUFFER;
    }
  }

  function slide() {
    if (G.dying || P.grapple) return;
    if (P.onGround) {
      P.sliding = true;
      P.slideT = CFG.SLIDE_TIME;
      Sfx.slide();
    } else if (!P.falling) {
      // in the air: slam down, then slide on landing
      P.fastFall = true;
      P.slideQueued = true;
    }
  }

  /** Canyon whose hook is within reach right now (or null). */
  function grappleTarget() {
    for (const c of P.seg.canyons) {
      if (P.s > c.s0 - CFG.GRAPPLE_RANGE && P.s < c.s0 + 4 && P.y > -1.6) return c;
    }
    return null;
  }

  /**
   * Fire the grappling hook (E / Shift). `forced` is a canyon to latch onto
   * regardless of range (used by the Shield to rescue a fall).
   */
  function grapple(forced) {
    if (G.dying || P.grapple) return false;
    const c = forced || grappleTarget();
    if (!c) { Sfx.whiff(); return false; }
    P.grapple = { c, sStart: P.s, sEnd: c.s1 + 2.5, y0: P.y };
    P.onGround = false; P.falling = false; P.vy = 0;
    P.sliding = false; P.slideQueued = false; P.fastFall = false;
    G.fovKick = Math.max(G.fovKick, 9);
    G.shake = Math.max(G.shake, 0.15);
    Sfx.grapple();
    return true;
  }

  /** While swinging: follow an arc from the launch point to the far rim. */
  function stepGrapple(h) {
    const g = P.grapple;
    const v = G.speed * CFG.GRAPPLE_SPEED;
    P.s += v * h;
    G.distance += v * h;
    P.x = damp(P.x, 0, 4, h);
    const t = clamp((P.s - g.sStart) / (g.sEnd - g.sStart), 0, 1);
    P.y = g.y0 + (0.6 - g.y0) * t + CFG.GRAPPLE_ARC * Math.sin(Math.PI * t);
    if (t >= 1) {
      P.grapple = null;
      P.vy = 3;
      P.onGround = false; P.falling = false;
      G.shake = Math.max(G.shake, 0.2);
    }
  }

  /** A turn key was pressed: turn now if possible, otherwise remember it briefly. */
  function onTurnKey(side) {
    if (G.dying) return;
    if (!tryTurn(side)) G.turnBuffer = { side, t: CFG.TURN_BUFFER };
  }

  function tryTurn(side) {
    const seg = P.seg;
    if (!allowsTurn(seg, side)) return false;
    const before = seg.L - P.s;
    const early = Math.max(CFG.TURN_EARLY, G.speed * 0.22);
    if (before > early || before < -CFG.TURN_LATE) return false;
    doTurn(side);
    return true;
  }

  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _pos = new THREE.Vector3();

  /** Execute a 90° turn onto a child segment, keeping world position continuous. */
  function doTurn(side) {
    const seg = P.seg;
    const child = side < 0 ? seg.childL : seg.childR;
    const other = side < 0 ? seg.childR : seg.childL;
    if (!child) return;

    segPoint(seg, P.s, P.x, _a); // logical world position before
    const d = seg.L - P.s, x = P.x;
    // Re-express the position in the child's frame (see header comment).
    if (side > 0) { P.s = x; P.x = d; } else { P.s = -x; P.x = -d; }
    P.x = clamp(P.x, -CFG.LANE_LIMIT, CFG.LANE_LIMIT);
    P.seg = child;
    segPoint(child, P.s, P.x, _b);
    P.visOff.add(_a.sub(_b)); // hide any snap; decays over a few frames

    P.yaw += side > 0 ? -Math.PI / 2 : Math.PI / 2;

    // Dispose the branch not taken and anything older than the segment we left.
    if (other) disposeSegment(other);
    seg.childL = seg.childR = null;
    for (const s of G.segments.slice()) if (s !== seg && s !== child) disposeSegment(s);
    buildChildren(child);

    G.turnBuffer = null;
    P.laneTarget = null;
    Sfx.turn();
  }

  /** Used by Boost and the Shield: pick a valid direction automatically. */
  function autoTurn() {
    const seg = P.seg;
    if (seg.childL && seg.childR) doTurn(P.x >= 0 ? 1 : -1);
    else doTurn(seg.childL ? -1 : 1);
  }

  /** Activate a power-up (from a pickup or the meter). */
  function activatePower(type) {
    if (type === 'magnet') { G.magnetT = magnetDuration(); UI.toast('Coin Magnet!', 'good'); }
    else if (type === 'boost') { G.boostT = boostDuration(); G.stumbleT = 0; G.fovKick = 14; UI.toast('BOOST!', 'good'); }
    else if (type === 'shield') { P.shield = true; UI.toast('Shield Up!', 'good'); }
    Sfx.power();
  }

  function tryActivateMeter() {
    if (G.meter >= G.meterMax) {
      G.meter = 0;
      activatePower(Save.data.meterPower);
      return true;
    }
    return false;
  }

  /** Destroy an obstacle (boost / shield). */
  function smashObstacle(o) {
    if (o.hit) return;
    o.hit = true;
    o.mesh.visible = false;
    o.mesh.getWorldPosition(_a);
    _a.y += 0.8;
    Particles.spawn(_a, o.color, 18, 7, 0.28);
    Particles.spawn(_a, 0xffe9a0, 8, 6, 0.12, { glow: true, gravity: 4 });
    G.shake = Math.max(G.shake, 0.3);
    Sfx.smash();
  }

  /**
   * A fatal event. Boost and Shield can save you; otherwise begin dying.
   * Returns true if the runner survived.
   */
  function fatal(reason, obstacle) {
    if (G.dying) return false;
    if (G.boostT > 0 && reason !== 'caught') {
      if (obstacle) smashObstacle(obstacle);
      if (reason === 'wall') autoTurn();
      return true;
    }
    if (P.shield) {
      P.shield = false;
      G.invulnT = 1.0;
      Sfx.shieldBreak();
      UI.toast('Shield saved you!', 'good');
      UI.flash('rgba(74,168,255,0.45)');
      G.shake = Math.max(G.shake, 0.5);
      getRunnerWorld(_a); _a.y += 1;
      Particles.spawn(_a, 0x4aa8ff, 24, 6, 0.2, { glow: true, gravity: 4 });
      if (obstacle) smashObstacle(obstacle);
      const canyon = reason === 'fall' && P.seg.canyons.find((c) => P.s > c.s0 - 1 && P.s < c.s1);
      if (canyon) {
        // too wide to bounce out of: auto-fire the hook instead
        P.y = Math.max(P.y, -0.5);
        grapple(canyon);
      } else if (reason === 'fall') {
        // bounce back up and drift to solid ground
        P.y = Math.max(P.y, -0.3);
        P.vy = CFG.JUMP_V * 1.15;
        P.onGround = false; P.falling = false;
        for (const h of P.seg.halfGaps) if (P.s > h.s0 - 1 && P.s < h.s1) P.x = -h.side * 1.6;
      }
      if (reason === 'wall') autoTurn();
      if (reason === 'caught') G.stumbleT = CFG.RECOVER_TIME * 0.6;
      return true;
    }
    G.dying = { type: reason, t: 0 };
    G.deathReason = reason;
    G.shake = reason === 'fall' ? 0.4 : 0.9;
    UI.flash(reason === 'fall' ? 'rgba(0,0,0,0.5)' : 'rgba(255,60,40,0.55)');
    P.grapple = null;
    if (reason === 'fall') Sfx.splash(); else Sfx.crash();
    if (reason === 'caught') Sfx.roar();
    return false;
  }

  /** Minor mistake: slow down, monkeys close in. Second one = caught. */
  function stumble() {
    if (G.dying || G.invulnT > 0 || G.boostT > 0) return;
    G.speedMul = 0.55;
    G.shake = 0.55;
    UI.flash('rgba(255,120,40,0.35)');
    getRunnerWorld(_a); _a.y += 0.3;
    Particles.spawn(_a, 0xb09a7a, 10, 4, 0.15);
    Sfx.stumble();
    if (G.stumbleT > 0) {
      fatal('caught');
    } else {
      G.stumbleT = CFG.RECOVER_TIME;
      UI.toast('Stumble! They\'re close!', 'warn');
      Sfx.roar();
    }
  }

  /* =======================================================================
   * 14. SIMULATION
   * ===================================================================== */
  /** One physics sub-step. */
  function stepPlayer(h) {
    const seg = P.seg;
    if (P.grapple) { stepGrapple(h); return; } // no ground / obstacles mid-swing

    // ---- forward + lateral motion ----
    P.s += G.speed * h;
    G.distance += G.speed * h;
    const steer = steerInput();
    if (steer !== 0) {
      P.laneTarget = null;
      P.x += steer * CFG.STEER_SPEED * h;
    } else if (P.laneTarget !== null) {
      // a swipe on a straight: glide one lane over
      const d = P.laneTarget - P.x;
      const step = CFG.STEER_SPEED * 1.3 * h;
      if (Math.abs(d) <= step) { P.x = P.laneTarget; P.laneTarget = null; } else P.x += Math.sign(d) * step;
    }
    P.x = clamp(P.x, -CFG.LANE_LIMIT, CFG.LANE_LIMIT);

    // ---- vertical motion / gaps ----
    const hasFloor = G.boostT > 0 || floorAt(seg, P.s, P.x);
    if (P.onGround) {
      if (!hasFloor) { P.onGround = false; P.falling = true; P.vy = 0; P.coyote = CFG.COYOTE; P.sliding = false; }
    } else {
      P.coyote -= h;
      P.vy -= CFG.GRAVITY * (P.fastFall ? 2.4 : 1) * h;
      P.y += P.vy * h;
      if (P.y <= 0) {
        if (hasFloor && P.y > -0.35) {
          P.y = 0; P.vy = 0; P.onGround = true; P.falling = false; P.fastFall = false;
          if (P.slideQueued) { P.slideQueued = false; slide(); }
          if (P.jumpBuffer > 0) jump();
        } else if (P.y < -0.7) {
          if (!fatal('fall')) return;
        }
      }
    }
    if (P.jumpBuffer > 0) P.jumpBuffer -= h;

    // ---- sliding ----
    if (P.sliding) { P.slideT -= h; if (P.slideT <= 0) P.sliding = false; }

    // ---- turning ----
    if (G.turnBuffer) {
      G.turnBuffer.t -= h;
      if (tryTurn(G.turnBuffer.side) || G.turnBuffer.t <= 0) G.turnBuffer = null;
    }
    if (P.seg !== seg) return; // turned this step
    if (G.boostT > 0 && P.s > seg.L - 0.5) { autoTurn(); return; }
    if (P.s > seg.L + CFG.TURN_LATE) {
      P.s = seg.L + CFG.TURN_LATE;
      if (!fatal('wall')) return;
      return;
    }

    // ---- obstacles ----
    checkObstacles(seg);
  }

  function checkObstacles(seg) {
    for (const o of seg.obstacles) {
      if (o.hit) continue;
      if (P.s + 0.4 < o.s0 || P.s - 0.4 > o.s1) continue;
      if (G.boostT > 0) { smashObstacle(o); continue; }
      if (G.invulnT > 0) continue;

      if (o.type === 'log') {
        if (P.y < 0.45) { if (!fatal('crash', o)) return; }
        else if (P.y < 0.8) { o.hit = true; stumble(); } // clipped it with your feet
      } else if (o.type === 'overhead') {
        const top = P.y + (P.sliding ? 0.85 : 1.8);
        if (top > 1.05) { if (!fatal(o.reason, o)) return; }
      } else if (o.type === 'swing') {
        const top = P.y + (P.sliding ? 0.85 : 1.8);
        if (top < o.by - 0.55 || P.y > o.by + 0.55) continue; // under / over the head
        const dx = Math.abs(P.x - o.bx);
        if (dx < 1.15) { if (!fatal('swing', o)) return; }
        else if (dx < 1.45) { o.hit = true; stumble(); } // grazed by the edge
      } else if (o.type === 'rock' || o.type === 'slider') {
        if (P.y > o.jumpH) continue; // jumped over
        const ov = Math.min(P.x + 0.4, o.x1) - Math.max(P.x - 0.4, o.x0);
        if (ov <= 0) continue;
        const pushOut = () => {
          P.x = P.x < (o.x0 + o.x1) / 2 ? o.x0 - 0.41 : o.x1 + 0.41;
          P.x = clamp(P.x, -CFG.LANE_LIMIT, CFG.LANE_LIMIT);
        };
        if (o.clipped) {
          pushOut(); // already brushed: acts as a solid side wall
          if (Math.min(P.x + 0.4, o.x1) - Math.max(P.x - 0.4, o.x0) > 0) o.hit = true; // pinned at the edge: let it pass
          continue;
        }
        if (ov < 0.5) { o.clipped = true; pushOut(); stumble(); }  // side clip
        else if (!fatal('crash', o)) return;      // head-on
      }
    }
  }

  function getRunnerWorld(out) {
    segPoint(P.seg, P.s, P.x, out).add(P.visOff);
    out.y = P.y;
    return out;
  }

  /** Coins, magnet and power-up pickups. */
  function updateCollectibles(dt) {
    const seg = P.seg;
    getRunnerWorld(_pos);
    _pos.y += 0.9;
    const collect = (c) => {
      c.taken = true;
      c.mesh.visible = false;
      G.coins += c.value;
      G.meter = Math.min(G.meterMax, G.meter + c.value);
      Sfx.coin(c.value);
      c.mesh.getWorldPosition(_a);
      Particles.spawn(_a, COIN_HEX[c.value], 8 + c.value * 2, 3.5, 0.12, { glow: true, gravity: 5, life: 0.9 });
      Particles.spawn(_a, 0xffffff, 3, 2, 0.07, { glow: true, gravity: 0, life: 0.5 });
      UI.bumpCoins();
    };
    for (const c of seg.coins) {
      if (c.taken) continue;
      if (G.magnetT > 0 && !c.flying && c.s > P.s - 0.5 && c.s - P.s < CFG.MAGNET_RANGE) { // only coins ahead
        c.flying = true;
        scene.attach(c.mesh); // detach from segment, keep world transform
      }
      if (c.flying) {
        _a.copy(_pos).sub(c.mesh.position);
        const dist = _a.length();
        const step = Math.max(28, G.speed * 2) * dt;
        if (dist < 0.7 || step >= dist) collect(c);
        else c.mesh.position.addScaledVector(_a, step / dist);
      } else if (Math.abs(c.s - P.s) < 0.9 && Math.abs(c.x - P.x) < 0.9 && Math.abs(c.y - (P.y + 0.9)) < 1.2) {
        collect(c);
      }
    }
    for (const p of seg.pickups) {
      if (p.taken) continue;
      if (Math.abs(p.s - P.s) < 1.0 && Math.abs(p.x - P.x) < 1.1 && P.y < 2.2) {
        p.taken = true;
        p.mesh.visible = false;
        activatePower(p.type);
      }
    }
  }

  function updatePlaying(dt) {
    G.time += dt;
    Touch.poll();
    if (G.dying) { updateDying(dt); updateVisuals(dt); return; }

    // ---- speed ----
    G.baseSpeed = Math.min(CFG.MAX_SPEED, CFG.BASE_SPEED + G.distance * CFG.SPEED_RAMP);
    G.speedMul = damp(G.speedMul, 1, 1.3, dt);
    G.speed = G.baseSpeed * G.speedMul * (G.boostT > 0 ? CFG.BOOST_MUL : 1);

    // ---- physics in fixed-size sub-steps ----
    const steps = Math.max(1, Math.ceil(dt / CFG.SUBSTEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      stepPlayer(h);
      if (G.dying) break;
    }

    // ---- timers ----
    G.magnetT = Math.max(0, G.magnetT - dt);
    G.boostT = Math.max(0, G.boostT - dt);
    G.invulnT = Math.max(0, G.invulnT - dt);
    G.stumbleT = Math.max(0, G.stumbleT - dt);
    G.introT = Math.max(0, G.introT - dt);

    // ---- chasing monkeys ----
    let target = CFG.MONKEY_SAFE;
    if (G.stumbleT > 0) target = CFG.MONKEY_CLOSE + (CFG.MONKEY_SAFE - CFG.MONKEY_CLOSE) * (1 - G.stumbleT / CFG.RECOVER_TIME);
    if (G.introT > 0) target = Math.min(target, 2 + (CFG.MONKEY_SAFE - 2) * (1 - G.introT / 3));
    G.chase = damp(G.chase, target, target < G.chase ? 6 : 2, dt);

    if (!G.dying) updateCollectibles(dt);
    updateCollapses(P.seg, dt, true);

    // ---- biome transitions (when entering the first segment of a new biome) ----
    if (P.seg.biome !== G.biome) {
      G.biome = P.seg.biome;
      UI.toast('Entering ' + BIOMES[G.biome].name, 'good');
      Sfx.biome();
    }
    applyAtmosphere(G.biome, 1 - Math.exp(-dt * 1.2));
    spawnAmbient(dt);

    G.score = Math.floor(G.distance * G.mult) + G.coins;
    updateVisuals(dt);
    UI.updateHUD();
  }

  /** Biome flavour particles: rising embers in lava, fireflies in the jungle, boost sparks. */
  function spawnAmbient(dt) {
    const rate = G.biome === 'lava' ? 26 : G.biome === 'jungle' ? 8 : 0;
    getRunnerWorld(_pos);
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    if (Math.random() < rate * dt) {
      const ahead = rand(4, 30), side = rand(-9, 9);
      _a.set(_pos.x + fx * ahead - fz * side, rand(-3, 2), _pos.z + fz * ahead + fx * side);
      if (G.biome === 'lava') Particles.spawn(_a, pick([0xff7a20, 0xffb040, 0xff4010]), 1, 0.6, 0.12, { glow: true, gravity: -3, life: 3 });
      else { _a.y = rand(1, 5); Particles.spawn(_a, 0xd8ff70, 1, 0.5, 0.08, { glow: true, gravity: 0, life: 3 }); }
    }
    if (G.boostT > 0 && Math.random() < 0.8) {
      _a.set(_pos.x + rand(-0.4, 0.4), rand(0.3, 1.6), _pos.z + rand(-0.4, 0.4));
      Particles.spawn(_a, 0xffc040, 1, 2, 0.1, { glow: true, gravity: 0, life: 0.6 });
    }
  }

  function updateDying(dt) {
    const D = G.dying;
    D.t += dt;
    if (D.type === 'fall') {
      P.vy -= CFG.GRAVITY * dt;
      P.y += P.vy * dt;
      P.s += 5 * Math.max(0, 1 - D.t) * dt;
    } else if (D.type === 'caught') {
      G.chase = damp(G.chase, 0.6, 5, dt);
    } else {
      // knocked back off the obstacle
      if (D.t < 0.25) P.s -= 6 * dt;
      G.chase = damp(G.chase, 1.4, 2.5, dt);
    }
    if (D.t > 1.7) gameOver();
  }

  /* =======================================================================
   * 15. VISUALS — runner animation, camera, monkeys, world animation
   * ===================================================================== */
  function animateRunner(dt) {
    const r = runner;
    const D = G.dying;
    if (state === State.START) {
      // idle breathing on the menu
      const b = Math.sin(G.time * 2);
      r.body.position.y = 0; r.body.rotation.x = 0;
      r.armL.rotation.x = 0.1 + b * 0.05; r.armR.rotation.x = 0.1 - b * 0.05;
      r.armL.rotation.z = -0.1; r.armR.rotation.z = 0.1;
      r.legL.rotation.x = 0; r.legR.rotation.x = 0;
      return;
    }
    r.armL.rotation.z = -0.1; r.armR.rotation.z = 0.1;
    if (D) {
      if (D.type === 'fall') {
        r.armL.rotation.x = 2.8 + Math.sin(D.t * 20) * 0.4;
        r.armR.rotation.x = 2.8 - Math.sin(D.t * 20) * 0.4;
        r.body.rotation.x = damp(r.body.rotation.x, -0.6, 4, dt);
      } else {
        r.body.rotation.x = damp(r.body.rotation.x, 1.45, 8, dt); // fall backwards
        r.body.position.y = damp(r.body.position.y, 0.3, 8, dt);
        r.armL.rotation.x = 2.4; r.armR.rotation.x = 2.2;
        r.legL.rotation.x = 0.6; r.legR.rotation.x = 0.2;
      }
      return;
    }
    P.phase += dt * (6 + G.speed * 0.38);
    const sw = Math.sin(P.phase);
    if (P.grapple) {
      // hanging from the rope: arms up, legs swinging
      r.body.rotation.x = damp(r.body.rotation.x, -0.25, 10, dt);
      r.body.position.y = damp(r.body.position.y, 0, 10, dt);
      r.armL.rotation.x = 3.0; r.armR.rotation.x = 2.8;
      r.legL.rotation.x = 0.5 + Math.sin(P.phase * 0.5) * 0.3;
      r.legR.rotation.x = 0.2 + Math.sin(P.phase * 0.5) * 0.3;
    } else if (P.sliding) {
      r.body.rotation.x = damp(r.body.rotation.x, 1.25, 18, dt);
      r.body.position.y = damp(r.body.position.y, 0.22, 18, dt);
      r.legL.rotation.x = 0.35; r.legR.rotation.x = 0.15;
      r.armL.rotation.x = 0.6; r.armR.rotation.x = 0.6;
    } else if (!P.onGround) {
      r.body.rotation.x = damp(r.body.rotation.x, -0.15, 14, dt);
      r.body.position.y = damp(r.body.position.y, 0, 14, dt);
      r.legL.rotation.x = 1.1; r.legR.rotation.x = 0.25;
      r.armL.rotation.x = 2.5; r.armR.rotation.x = -0.5;
    } else {
      r.body.rotation.x = damp(r.body.rotation.x, -0.14, 14, dt);
      r.body.position.y = Math.abs(Math.cos(P.phase)) * 0.09;
      r.legL.rotation.x = sw * 0.95; r.legR.rotation.x = -sw * 0.95;
      r.armL.rotation.x = -sw * 0.85; r.armR.rotation.x = sw * 0.85;
    }
  }

  /** Sample the player's past path at cumulative distance d. */
  function trailSample(d, out) {
    const t = G.trail;
    if (!t.length) return getRunnerWorld(out);
    if (d <= t[0].d) return out.set(t[0].x, 0, t[0].z);
    for (let i = t.length - 1; i > 0; i--) {
      if (t[i - 1].d <= d) {
        const a = t[i - 1], b = t[i];
        const k = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
        return out.set(a.x + (b.x - a.x) * k, 0, a.z + (b.z - a.z) * k);
      }
    }
    return out.set(t[0].x, 0, t[0].z);
  }

  function updateMonkeys(dt) {
    const show = state !== State.START && G.chase < 11;
    const last = G.trail[G.trail.length - 1];
    for (let i = 0; i < monkeys.length; i++) {
      const m = monkeys[i];
      m.root.visible = show;
      if (!show) continue;
      const d = Math.min(G.distance - G.chase - MONKEY_OFFS[i].d, last ? last.d - 0.2 : 0);
      trailSample(d, _a);
      trailSample(d + 1, _b);
      let fx = _b.x - _a.x, fz = _b.z - _a.z;
      const len = Math.hypot(fx, fz) || 1;
      fx /= len; fz /= len;
      // right vector of forward (fx,fz) is (-fz, fx)
      m.root.position.set(_a.x - fz * MONKEY_OFFS[i].x, 0, _a.z + fx * MONKEY_OFFS[i].x);
      const targetYaw = Math.atan2(-fx, -fz);
      m.root.rotation.y = targetYaw;
      // galloping animation
      const moving = !(G.dying && G.dying.t > 1.2);
      m.phase += dt * (moving ? 14 : 4);
      const s = Math.sin(m.phase);
      m.root.position.y = Math.abs(s) * 0.35;
      m.armL.rotation.x = s * 1.1 + 0.3; m.armR.rotation.x = s * 1.1 + 0.3;
      m.legL.rotation.x = -s * 0.9; m.legR.rotation.x = -s * 0.9;
      if (G.dying && G.dying.type === 'caught') { m.armL.rotation.x = 2.6 + s * 0.3; m.armR.rotation.x = 2.6 - s * 0.3; }
    }
  }

  function updateVisuals(dt) {
    // ---- runner placement ----
    P.visOff.multiplyScalar(Math.exp(-dt * 10));
    getRunnerWorld(_pos);
    runner.root.position.copy(_pos);
    P.yawVis = damp(P.yawVis, P.yaw, 16, dt);
    runner.root.rotation.y = P.yawVis;
    const steer = state === State.PLAYING && !G.dying ? steerInput() : 0;
    P.lean = damp(P.lean, -steer * 0.2, 10, dt);
    runner.root.rotation.z = P.lean;
    animateRunner(dt);

    // blink while invulnerable after a shield save
    runner.root.visible = !(G.invulnT > 0 && Math.floor(G.time * 20) % 2 === 0);

    // ---- blob shadow, shield bubble, magnet ring ----
    const grounded = floorAt(P.seg, P.s, P.x) && P.y > -0.3;
    playerShadow.visible = grounded;
    playerShadow.position.set(_pos.x, 0.03, _pos.z);
    playerShadow.scale.setScalar(clamp(1 - P.y * 0.25, 0.4, 1));
    shieldBubble.visible = P.shield || G.boostT > 0;
    MAT.shield.color.setHex(G.boostT > 0 ? 0xffb020 : 0x4aa8ff);
    shieldBubble.position.set(_pos.x, _pos.y + 1.1, _pos.z);
    shieldBubble.scale.setScalar(1.25 + Math.sin(G.time * 6) * 0.05);
    magnetRing.visible = G.magnetT > 0;
    magnetRing.position.set(_pos.x, _pos.y + 0.9 + Math.sin(G.time * 5) * 0.4, _pos.z);
    magnetRing.rotation.z += dt * 4;

    // ---- grappling rope: from the runner's hands to the hook ring ----
    if (P.grapple) {
      const c = P.grapple.c;
      segPoint(P.seg, c.anchorS, 0, _b);
      _b.y = c.anchorY - 0.4;
      _a.set(_pos.x, _pos.y + 2.25, _pos.z);
      ropeMesh.position.copy(_a);
      _b.sub(_a);
      const len = _b.length();
      ropeMesh.scale.set(1, len, 1);
      ropeMesh.quaternion.setFromUnitVectors(UP, _b.multiplyScalar(1 / len));
      ropeMesh.visible = true;
    } else {
      ropeMesh.visible = false;
    }

    // ---- chase trail (world positions the monkeys follow) ----
    if (state === State.PLAYING) {
      const lastT = G.trail[G.trail.length - 1];
      if (!lastT || G.distance - lastT.d > 0.05) G.trail.push({ d: G.distance, x: _pos.x, z: _pos.z });
      while (G.trail.length > 2 && G.trail[0].d < G.distance - 40) G.trail.shift();
    }
    updateMonkeys(dt);

    // ---- camera ----
    if (state === State.START) {
      G.menuAngle += dt * 0.25;
      const a = G.menuAngle;
      camera.position.set(_pos.x + Math.sin(a) * 6.5, 2.6, _pos.z + Math.cos(a) * 6.5 - 1);
      camera.lookAt(_pos.x, 1.3, _pos.z);
    } else {
      G.camYaw = damp(G.camYaw, P.yaw, 7, dt);
      G.camY = damp(G.camY, Math.max(P.y, -1) * 0.5, 6, dt);
      const fx = -Math.sin(G.camYaw), fz = -Math.cos(G.camYaw);
      G.shake = Math.max(0, G.shake - dt * 1.4);
      const sh = G.shake * G.shake * 0.8; // quadratic falloff feels punchier
      camera.position.set(
        _pos.x - fx * View.back + rand(-sh, sh),
        G.camY + View.up + rand(-sh, sh),
        _pos.z - fz * View.back + rand(-sh, sh)
      );
      camera.lookAt(_pos.x + fx * 6, G.camY + 1.4, _pos.z + fz * 6);
      if (sh > 0) camera.rotateZ(rand(-1, 1) * sh * 0.08); // a little roll in the shake
      camera.rotateZ(P.lean * 0.15);                       // lean into lane changes
      // speed sensation: FOV widens with speed, more during boost / grapple, plus decaying kicks
      G.fovKick = damp(G.fovKick, 0, 2.5, dt);
      const fovBase = G.boostT > 0 ? 82 : P.grapple ? 76 : 65 + Math.min(8, (G.speed - CFG.BASE_SPEED) * 0.35);
      const fovT = fovBase + G.fovKick;
      const nf = damp(camera.fov, fovT * View.fovScale, 3, dt);
      if (Math.abs(nf - camera.fov) > 0.01) { camera.fov = nf; camera.updateProjectionMatrix(); }
    }
    jungleFloor.position.x = camera.position.x;
    jungleFloor.position.z = camera.position.z;
  }

  /** Spin coins, flicker flames, bob power-ups — runs in every state. */
  function animateWorld(dt) {
    const t = G.time;
    for (const seg of G.segments) {
      updateMovers(seg);
      if (seg !== P.seg || state !== State.PLAYING) updateCollapses(seg, dt, false);
      for (const c of seg.canyons) {
        c.ring.rotation.y += dt * 1.5;
        const inRange = seg === P.seg && !P.grapple && P.s > c.s0 - CFG.GRAPPLE_RANGE && P.s < c.s0 + 4;
        c.halo.scale.setScalar(inRange ? 1.5 + Math.sin(t * 10) * 0.25 : 1.3);
        c.halo.lookAt(camera.position);
      }
      for (const c of seg.coins) if (!c.taken) c.mesh.rotation.y += dt * 3.5;
      for (let i = 0; i < seg.flames.length; i++) {
        const f = seg.flames[i];
        f.scale.set(1 + Math.sin(t * 17 + i) * 0.12, 1 + Math.sin(t * 23 + i * 1.7) * 0.25, 1);
      }
      for (const p of seg.pickups) {
        if (p.taken) continue;
        p.mesh.userData.core.rotation.y += dt * 2.5;
        p.mesh.position.y = 1.2 + Math.sin(t * 3 + p.s) * 0.2;
        p.mesh.children[1].lookAt(camera.position);
      }
    }
    Particles.update(dt);
  }

  /* =======================================================================
   * 16. INPUT
   * ===================================================================== */
  // Every steering source: keys, touch holds, on-screen buttons, device tilt.
  const Input = { left: false, right: false, touchLeft: false, touchRight: false, btnLeft: false, btnRight: false };
  function steerInput() {
    const digital = ((Input.right || Input.touchRight || Input.btnRight) ? 1 : 0) - ((Input.left || Input.touchLeft || Input.btnLeft) ? 1 : 0);
    return clamp(digital + (Tilt.enabled ? Tilt.value : 0), -1, 1);
  }
  const isTyping = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'space', Escape: 'pause', KeyP: 'pause', Enter: 'enter', KeyM: 'mute',
    KeyE: 'grapple', ShiftLeft: 'grapple', ShiftRight: 'grapple',
  };

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return; // typing a name in the overlay
    const a = KEYMAP[e.code];
    if (!a) return;
    if (a !== 'enter' || state === State.PLAYING) e.preventDefault();
    if (a === 'left') Input.left = true;
    if (a === 'right') Input.right = true;
    if (e.repeat) return;
    Sfx.init();

    if (a === 'mute') { Sfx.setMuted(!Save.data.muted); UI.updateMuteButton(); UI.toast(Save.data.muted ? 'Sound off' : 'Sound on'); return; }

    switch (state) {
      case State.PLAYING:
        if (a === 'up') jump();
        else if (a === 'down') slide();
        else if (a === 'left') onTurnKey(-1);
        else if (a === 'right') onTurnKey(1);
        else if (a === 'grapple') grapple();
        else if (a === 'space') { if (!tryActivateMeter()) pauseGame(); }
        else if (a === 'pause') pauseGame();
        break;
      case State.PAUSED:
        if (a === 'space' || a === 'pause' || a === 'enter') resumeGame();
        break;
      case State.START:
        if (a === 'enter' && !$('screen-start').classList.contains('hidden')) requestStart();
        else if (a === 'pause' && $('screen-start').classList.contains('hidden')) { UI.show('screen-start'); UI.refreshMenu(); }
        break;
      case State.GAMEOVER:
        if (a === 'enter' || a === 'space') startGame();
        else if (a === 'pause') goToMenu();
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    const a = KEYMAP[e.code];
    if (a === 'left') Input.left = false;
    if (a === 'right') Input.right = false;
  });
  // Lose focus / switch tab → release keys and pause
  window.addEventListener('blur', () => { Input.left = Input.right = false; Touch.reset(); pauseGame(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
  window.addEventListener('pagehide', () => pauseGame());

  /* -----------------------------------------------------------------------
   * TOUCH GESTURES (on the canvas — the HUD above it ignores pointer events)
   *   swipe ↑ jump · swipe ↓ slide · swipe ←/→ turn at a corner (or hop a
   *   lane on a straight) · hold left/right half of the screen to steer ·
   *   tap to fire the grappling hook (near a canyon) or the full power meter.
   *   A finger that's holding can still swipe up/down to jump/slide.
   * --------------------------------------------------------------------- */
  const Touch = {
    active: new Map(), // touch id → { x0, y0, t0, swiped, holding, side }
    SWIPE_PX: 26,      // movement that counts as a swipe
    HOLD_MS: 130,      // still for this long = a steering hold
    TAP_MS: 250,
    reset() { this.active.clear(); Input.touchLeft = Input.touchRight = false; },
    updateSteer() {
      let l = false, r = false;
      for (const t of this.active.values()) if (t.holding) { if (t.side < 0) l = true; else r = true; }
      Input.touchLeft = l; Input.touchRight = r;
    },
    /** Promote still fingers to steering holds (called every frame). */
    poll() {
      const now = performance.now();
      let changed = false;
      for (const t of this.active.values()) {
        if (!t.holding && !t.swiped && now - t.t0 > this.HOLD_MS) { t.holding = true; changed = true; }
      }
      if (changed) this.updateSteer();
    },
  };

  function swipe(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) {
      const side = dx > 0 ? 1 : -1;
      if (!tryTurn(side)) {
        G.turnBuffer = { side, t: CFG.TURN_BUFFER }; // corner just ahead? remember it
        const lane = clamp(Math.round(P.x / 2) * 2 + side * 2, -2, 2);
        P.laneTarget = clamp(lane, -CFG.LANE_LIMIT, CFG.LANE_LIMIT);
      }
    } else if (dy < 0) jump();
    else slide();
  }

  function onTap() {
    if (grappleTarget()) grapple();
    else tryActivateMeter();
  }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); // no scrolling, zooming or synthetic mouse clicks
    Sfx.init();
    if (state !== State.PLAYING || G.dying) return;
    const now = performance.now();
    for (const t of e.changedTouches) {
      Touch.active.set(t.identifier, {
        x0: t.clientX, y0: t.clientY, t0: now, swiped: false, holding: false,
        side: t.clientX < window.innerWidth / 2 ? -1 : 1,
      });
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (state !== State.PLAYING || G.dying) return;
    for (const t of e.changedTouches) {
      const rec = Touch.active.get(t.identifier);
      if (!rec) continue;
      const dx = t.clientX - rec.x0, dy = t.clientY - rec.y0;
      if (rec.holding) {
        // steering finger: follow which half it's on; a vertical flick still jumps/slides
        const side = t.clientX < window.innerWidth / 2 ? -1 : 1;
        if (side !== rec.side) { rec.side = side; Touch.updateSteer(); }
        if (Math.abs(dy) > Touch.SWIPE_PX * 1.5 && Math.abs(dy) > Math.abs(dx)) {
          swipe(0, dy);
          rec.x0 = t.clientX; rec.y0 = t.clientY;
        }
      } else if (!rec.swiped && Math.hypot(dx, dy) > Touch.SWIPE_PX) {
        rec.swiped = true; // fire on move, not on release — feels much snappier
        swipe(dx, dy);
      }
    }
  }, { passive: false });

  function touchEnd(e) {
    e.preventDefault();
    const now = performance.now();
    for (const t of e.changedTouches) {
      const rec = Touch.active.get(t.identifier);
      if (!rec) continue;
      if (e.type === 'touchend' && state === State.PLAYING && !G.dying &&
          !rec.swiped && !rec.holding && now - rec.t0 < Touch.TAP_MS) onTap();
      Touch.active.delete(t.identifier);
    }
    Touch.updateSteer();
  }
  canvas.addEventListener('touchend', touchEnd, { passive: false });
  canvas.addEventListener('touchcancel', touchEnd, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // iOS Safari pinch / double-tap zoom gestures
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  /* -----------------------------------------------------------------------
   * DEVICE TILT steering (optional, Settings → Tilt steering)
   * Uses gamma in portrait, beta in landscape; calibrated at the start of
   * each run so whatever angle you hold the device at counts as "straight".
   * --------------------------------------------------------------------- */
  const Tilt = {
    enabled: false, raw: 0, base: 0, value: 0, listening: false,
    DEAD: 4, FULL: 20, // degrees
    onOrientation(e) {
      const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      let g;
      if (angle === 90) g = e.beta;
      else if (angle === -90 || angle === 270) g = -e.beta;
      else if (angle === 180) g = -e.gamma;
      else g = e.gamma;
      if (g == null) return;
      Tilt.raw = g;
      const d = g - Tilt.base;
      const m = Math.abs(d) < Tilt.DEAD ? 0 : clamp((Math.abs(d) - Tilt.DEAD) / (Tilt.FULL - Tilt.DEAD), 0, 1);
      Tilt.value = m * Math.sign(d);
    },
    calibrate() { this.base = this.raw; this.value = 0; },
    /** Must be called from a tap (iOS asks for permission). Resolves true if tilt works. */
    async enable() {
      if (typeof DeviceOrientationEvent === 'undefined') return false;
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false; } catch (err) { return false; }
      }
      if (!this.listening) { window.addEventListener('deviceorientation', (e) => this.onOrientation(e)); this.listening = true; }
      this.enabled = true;
      return true;
    },
    disable() { this.enabled = false; this.value = 0; },
  };

  /* -----------------------------------------------------------------------
   * ON-SCREEN BUTTONS (fallback when swipes fight the browser)
   * Pointer events so they work for touch, pen and mouse alike.
   * --------------------------------------------------------------------- */
  function bindPress(el, down, up) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      Sfx.init();
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      el.classList.add('pressed');
      if (state === State.PLAYING && !G.dying) down();
    });
    const end = () => { el.classList.remove('pressed'); if (up) up(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }
  bindPress($('tc-left'), () => { Input.btnLeft = true; onTurnKey(-1); }, () => { Input.btnLeft = false; });
  bindPress($('tc-right'), () => { Input.btnRight = true; onTurnKey(1); }, () => { Input.btnRight = false; });
  bindPress($('tc-jump'), () => jump());
  bindPress($('tc-slide'), () => slide());
  bindPress($('grapple-prompt'), () => grapple());
  bindPress($('meter-wrap'), () => tryActivateMeter());

  const touchButtonsOn = () => (Save.data.touchButtons === null ? IS_TOUCH : Save.data.touchButtons);
  function applyControlPrefs() {
    document.body.classList.toggle('touch-buttons', touchButtonsOn());
  }

  /* =======================================================================
   * 17. UI (menus + HUD)
   * ===================================================================== */
  const UI = {
    hudCache: {},
    toastTimer: 0,

    show(id) {
      document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
      if (id) $(id).classList.remove('hidden');
    },

    /** Write text only when it changes (avoids layout thrash each frame). */
    set(id, value) {
      if (this.hudCache[id] !== value) { this.hudCache[id] = value; $(id).textContent = value; }
    },

    toast(text, kind = '') {
      const el = $('toast');
      el.textContent = text;
      el.className = 'show ' + kind;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { el.className = kind; }, 1300);
    },

    updateHUD() {
      this.set('hud-score', G.score.toLocaleString());
      this.set('hud-distance', Math.floor(G.distance).toLocaleString());
      this.set('hud-coins', G.coins.toLocaleString());
      this.set('hud-mult', 'x' + G.mult);
      const pct = Math.round((G.meter / G.meterMax) * 100);
      if (this.hudCache.meter !== pct) {
        this.hudCache.meter = pct;
        $('meter-fill').style.width = pct + '%';
        $('meter-wrap').classList.toggle('full', pct >= 100);
      }
      this.timerBar('pu-magnet', G.magnetT, magnetDuration());
      this.timerBar('pu-boost', G.boostT, boostDuration());
      $('pu-shield').classList.toggle('hidden', !P.shield);
      this.set('hud-biome', BIOMES[G.biome].name);
      const prompt = !G.dying && !P.grapple && !!grappleTarget();
      if (this.hudCache.prompt !== prompt) { this.hudCache.prompt = prompt; $('grapple-prompt').classList.toggle('hidden', !prompt); }
      const danger = G.stumbleT > 0 ? 0.35 + 0.65 * (G.stumbleT / CFG.RECOVER_TIME) : 0;
      if (this.hudCache.danger !== danger) { this.hudCache.danger = danger; $('danger-vignette').style.opacity = danger; }
    },
    /** Full-screen colour flash for impacts. */
    flash(color) {
      const el = $('flash');
      el.style.transition = 'none';
      el.style.background = color;
      el.style.opacity = 1;
      void el.offsetWidth; // restart the fade
      el.style.transition = 'opacity 0.45s ease-out';
      el.style.opacity = 0;
    },
    bumpCoins() {
      const el = $('hud-coins').parentElement;
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    },
    timerBar(id, t, max) {
      const el = $(id);
      el.classList.toggle('hidden', t <= 0);
      if (t > 0) el.querySelector('i').style.width = (100 * t / max).toFixed(1) + '%';
    },

    refreshMenu() {
      $('menu-best').textContent = Save.best.toLocaleString();
      $('menu-bank').textContent = Save.data.bank.toLocaleString();
      document.querySelectorAll('.bank-amount').forEach((el) => { el.textContent = Save.data.bank.toLocaleString(); });
    },

    updateMuteButton() {
      $('btn-mute').textContent = Save.data.muted ? '🔇 Sound: Off' : '🔊 Sound: On';
    },

    renderSettings() {
      $('set-name').textContent = Save.data.playerName || '—';
      $('set-buttons').textContent = touchButtonsOn() ? 'On' : 'Off';
      $('set-tilt').textContent = Tilt.enabled ? 'On' : 'Off';
      $('set-sound').textContent = Save.data.muted ? 'Off' : 'On';
      $('set-buttons').parentElement.classList.toggle('on', touchButtonsOn());
      $('set-tilt').parentElement.classList.toggle('on', Tilt.enabled);
      $('set-sound').parentElement.classList.toggle('on', !Save.data.muted);
    },

    /** Name overlay: `thenStart` = shown from Start (run begins after saving). */
    showNameOverlay(thenStart) {
      this.nameThenStart = thenStart;
      this.nameReturn = thenStart ? 'screen-start' : 'screen-settings';
      const input = $('name-input');
      input.value = Save.data.playerName || '';
      this.show('screen-name');
      // On touch devices focusing pops the keyboard over the panel; let the player tap instead.
      if (!IS_TOUCH) setTimeout(() => input.focus(), 30);
    },
    closeNameOverlay() {
      $('name-input').blur();
      if (this.nameThenStart) startGame();
      else { this.renderSettings(); this.show(this.nameReturn); }
    },

    renderCharacters() {
      this.refreshMenu();
      const list = $('char-list');
      list.innerHTML = '';
      for (const ch of CHARACTERS) {
        const owned = Save.data.unlocked.includes(ch.id);
        const selected = Save.data.character === ch.id;
        const card = document.createElement('div');
        card.className = 'char-card' + (selected ? ' selected' : '');
        const hex = '#' + ch.colors.shirt.toString(16).padStart(6, '0');
        card.innerHTML = `
          <div class="char-avatar" style="background:${hex}">${ch.emoji}</div>
          <b>${ch.name}</b><small>${ch.title}</small>
          <div class="perk">${ch.perk}</div>`;
        const btn = document.createElement('button');
        btn.className = 'btn btn-small' + (selected ? ' btn-primary' : '');
        if (selected) { btn.textContent = 'Selected'; btn.disabled = true; }
        else if (owned) { btn.textContent = 'Select'; btn.onclick = () => this.selectCharacter(ch.id); }
        else {
          btn.textContent = `Unlock · ${ch.cost}`;
          btn.disabled = Save.data.bank < ch.cost;
          btn.onclick = () => {
            if (Save.data.bank < ch.cost) return;
            Save.data.bank -= ch.cost;
            Save.data.unlocked.push(ch.id);
            this.selectCharacter(ch.id);
          };
        }
        card.appendChild(btn);
        list.appendChild(card);
      }
    },
    selectCharacter(id) {
      Save.data.character = id;
      Save.save();
      Sfx.init(); Sfx.power();
      setRunnerModel();
      updateVisuals(0);
      this.renderCharacters();
    },

    renderUpgrades() {
      this.refreshMenu();
      const list = $('upgrade-list');
      list.innerHTML = '';
      for (const u of UPGRADES) {
        const lvl = upg(u.id);
        const row = document.createElement('div');
        row.className = 'upgrade-row';
        let pips = '';
        for (let i = 0; i < u.max; i++) pips += `<i class="${i < lvl ? 'on' : ''}"></i>`;
        row.innerHTML = `<div style="font-size:26px">${u.icon}</div>
          <div class="info"><b>${u.name}</b><small>${u.desc}</small><div class="pips">${pips}</div></div>`;
        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        if (lvl >= u.max) { btn.textContent = 'MAX'; btn.disabled = true; }
        else {
          const cost = u.cost(lvl);
          btn.textContent = `Buy · ${cost}`;
          btn.disabled = Save.data.bank < cost;
          btn.onclick = () => {
            if (Save.data.bank < cost) return;
            Save.data.bank -= cost;
            Save.data.upgrades[u.id] = lvl + 1;
            Save.save();
            Sfx.init(); Sfx.power();
            this.renderUpgrades();
          };
        }
        row.appendChild(btn);
        list.appendChild(row);
      }
      const sel = $('meter-power-select');
      sel.innerHTML = '';
      for (const key of Object.keys(POWER_NAMES)) {
        const b = document.createElement('button');
        b.className = 'btn btn-small' + (Save.data.meterPower === key ? ' active' : '');
        b.textContent = POWER_NAMES[key];
        b.onclick = () => { Save.data.meterPower = key; Save.save(); Sfx.init(); Sfx.click(); this.renderUpgrades(); };
        sel.appendChild(b);
      }
    },

    renderScores() {
      const body = $('score-body');
      const hs = Save.data.highScores;
      body.innerHTML = hs.length
        ? hs.map((h, i) => `<tr><td>${i + 1}</td><td>${h.score.toLocaleString()}</td><td>${h.distance.toLocaleString()} m</td><td>${h.coins}</td><td>${escapeHTML(h.name || 'Runner')}<small class="muted"> · ${escapeHTML(h.character)}</small></td></tr>`).join('')
        : '<tr><td colspan="5" style="color:var(--muted)">No runs yet — go set a record!</td></tr>';
    },
  };

  // Delegated click handling for every [data-action] button
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    Sfx.init();
    Sfx.click();
    switch (btn.dataset.action) {
      case 'start': requestStart(); break;
      case 'settings': UI.renderSettings(); UI.show('screen-settings'); break;
      case 'toggle-buttons': Save.data.touchButtons = !touchButtonsOn(); Save.save(); applyControlPrefs(); UI.renderSettings(); break;
      case 'toggle-tilt':
        if (Tilt.enabled) { Tilt.disable(); Save.data.tilt = false; Save.save(); UI.renderSettings(); }
        else {
          Tilt.enable().then((ok) => {
            Save.data.tilt = ok; Save.save(); UI.renderSettings();
            if (!ok) UI.toast('Tilt not available on this device');
          });
        }
        break;
      case 'edit-name': UI.showNameOverlay(false); break;
      case 'name-skip': Save.data.playerName = Save.data.playerName || 'Runner'; Save.save(); UI.closeNameOverlay(); break;
      case 'characters': UI.renderCharacters(); UI.show('screen-characters'); break;
      case 'upgrades': UI.renderUpgrades(); UI.show('screen-upgrades'); break;
      case 'scores': UI.renderScores(); UI.show('screen-scores'); break;
      case 'back': UI.refreshMenu(); UI.show('screen-start'); break;
      case 'reset-scores':
        if (confirm('Clear all high scores?')) { Save.data.highScores = []; Save.save(); UI.renderScores(); }
        break;
      case 'pause': pauseGame(); break;
      case 'resume': resumeGame(); break;
      case 'restart': startGame(); break;
      case 'menu': goToMenu(); break;
      case 'toggle-mute': Sfx.setMuted(!Save.data.muted); UI.updateMuteButton(); UI.renderSettings(); break;
    }
    btn.blur(); // so Space/Enter don't re-trigger the focused button
  });

  /* =======================================================================
   * 18. MAIN LOOP
   * ===================================================================== */
  let lastTime = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.1) dt = 0.1;   // clamp after tab switches / hitches
    if (dt <= 0) return;

    if (state === State.PLAYING) {
      updatePlaying(dt);
    } else if (state === State.START) {
      G.time += dt;
      updateVisuals(dt);
    } else if (state === State.GAMEOVER) {
      G.time += dt;
      updateMonkeys(dt);
    }
    if (state !== State.PAUSED) animateWorld(dt);
    renderer.render(scene, camera);
  }

  // Optional debug handle (open index.html?debug) for testing in the console.
  if (/[?&]debug\b/.test(location.search)) {
    window.__ruins = { G, P, CFG, Input, getState: () => state, startGame, jump, slide, onTurnKey, activatePower, stumble, grapple, grappleTarget, Touch, Tilt, View };
  }

  // Name overlay form (Enter or the button submits)
  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('name-input').value.trim().replace(/\s+/g, ' ').slice(0, 14);
    Save.data.playerName = name || 'Runner';
    Save.save();
    Sfx.init(); Sfx.click();
    UI.closeNameOverlay();
  });

  // Restore control preferences (tilt needs a fresh permission tap on iOS, so
  // it's re-enabled silently only where no permission prompt is required).
  applyControlPrefs();
  if (Save.data.tilt && typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission !== 'function') Tilt.enable();

  // Boot: build the menu backdrop and show the start screen.
  resetRun();
  for (const m of monkeys) m.root.visible = false;
  UI.refreshMenu();
  UI.updateMuteButton();
  requestAnimationFrame(frame);
})();
