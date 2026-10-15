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
 *
 * Track model
 *   The track is a chain of straight segments, each ending in a junction
 *   that turns 90° left, right, or both (a T-split). Every segment owns a
 *   THREE.Group whose local frame is: -Z = forward, +X = right. So content
 *   at track coords (s, x, y) sits at local position (x, y, -s).
 *   When the player enters a segment, its child segment(s) beyond the
 *   junction are generated so the path ahead is always visible. On a turn
 *   the un-chosen branch and old segments are disposed.
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
  const canvas = $('game-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CFG.FOG_COLOR);
  scene.fog = new THREE.Fog(CFG.FOG_COLOR, 25, 125);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 400);

  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x2d3b22, 0.95));
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

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

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
    list: [],
    init() {
      for (let i = 0; i < 80; i++) {
        const m = new THREE.Mesh(GEO.box, new THREE.MeshBasicMaterial({ color: 0xffffff }));
        m.visible = false;
        scene.add(m);
        this.list.push({ m, v: new THREE.Vector3(), life: 0 });
      }
    },
    spawn(pos, color, n, speed = 6, size = 0.18) {
      for (const p of this.list) {
        if (n <= 0) break;
        if (p.life > 0) continue;
        p.m.material.color.setHex(color);
        p.m.position.copy(pos);
        p.m.scale.setScalar(size * rand(0.6, 1.3));
        p.v.set(rand(-1, 1), rand(0.3, 1.4), rand(-1, 1)).multiplyScalar(speed);
        p.life = rand(0.4, 0.9);
        p.m.visible = true;
        n--;
      }
    },
    update(dt) {
      for (const p of this.list) {
        if (p.life <= 0) continue;
        p.life -= dt;
        p.v.y -= 20 * dt;
        p.m.position.addScaledVector(p.v, dt);
        p.m.rotation.x += dt * 8; p.m.rotation.y += dt * 6;
        if (p.life <= 0) p.m.visible = false;
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
    camYaw: 0, camY: 0, shake: 0, fov: 65,
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

  /** Create a segment starting at `start` (world) heading `dir`. */
  function createSegment(start, dir, first) {
    const seg = {
      start: start.clone(), dir, first,
      fwd: DIRS[dir], right: DIRS[(dir + 1) % 4],
      L: first ? 120 : randInt(75, 135),
      junction: weighted([['L', 3], ['R', 3], ['T', 2]]),
      obstacles: [], coins: [], pickups: [], gaps: [], halfGaps: [], flames: [], geos: [],
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
    if (seg.junction !== 'R') seg.childL = createSegment(c, (seg.dir + 3) % 4, false);
    if (seg.junction !== 'L') seg.childR = createSegment(c, (seg.dir + 1) % 4, false);
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
      const p = new THREE.Mesh(GEO.archPillar, MAT.wall);
      p.position.set(side * (CFG.HALF_W + 0.45), 1.8, 0);
      g.add(p);
    }
    const beam = new THREE.Mesh(GEO.archTop, MAT.wall);
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
    seg.obstacles.push({ type: 'fire', s0: s - 0.5, s1: s + 0.5, x0: -3, x1: 3, mesh: g, hit: false, color: 0xff8a20 });
  }

  /** Rubble block filling one lane — dodge sideways or jump. */
  function addRock(seg, s, lane) {
    const cx = CFG.LANES[lane];
    const g = new THREE.Group();
    g.position.set(cx, 0, -s);
    const block = boxMesh(1.8, 1.3, 1.4, MAT.wall); block.position.y = 0.65; g.add(block);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(GEO.rubble, MAT.wall);
      r.position.set(rand(-0.6, 0.6), 1.3 + rand(0, 0.2), rand(-0.4, 0.4));
      r.scale.setScalar(rand(0.5, 0.9)); r.rotation.set(rand(0, 3), rand(0, 3), 0);
      g.add(r);
    }
    seg.group.add(g);
    seg.obstacles.push({ type: 'rock', s0: s - 0.7, s1: s + 0.7, x0: cx - 0.95, x1: cx + 0.95, mesh: g, hit: false, clipped: false, color: 0x7a7060 });
  }

  /**
   * Fill a segment with obstacle / coin patterns. Spacing scales with the
   * current speed so there's always time to react.
   */
  function populateSegment(seg) {
    const diff = clamp(G.distance / 2500, 0, 1);
    const speed = Math.min(CFG.MAX_SPEED, CFG.BASE_SPEED + G.distance * CFG.SPEED_RAMP);
    let s = seg.first ? 45 : 22;
    const end = seg.L - 18;

    while (true) {
      s += Math.max(speed * 0.85, 11) * rand(1.0, 1.7 - diff * 0.5);
      if (s > end) break;
      const type = weighted([
        ['log', 3], ['fire', 2.5], ['rock', 3],
        ['gap', diff > 0.04 ? 2.2 : 0.7], ['halfgap', 1.5],
        ['coins', 2.6 - diff], ['powerup', 0.4],
      ]);
      const lane = randInt(0, 2);
      switch (type) {
        case 'log':
          addLog(seg, s);
          if (Math.random() < 0.6) coinArc(seg, CFG.LANES[lane], s);
          s += 1;
          break;
        case 'fire':
          addFire(seg, s);
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
        case 'coins': {
          const n = randInt(7, 11);
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

    function floor(s0, s1, x0, x1) {
      if (s1 - s0 < 0.01) return;
      const m = boxUV(seg, x1 - x0, 1.2, s1 - s0, MAT.floor);
      m.position.set((x0 + x1) / 2, -0.6, -(s0 + s1) / 2);
      grp.add(m);
      for (let s = Math.ceil(s0 / 16) * 16; s < s1 - 1; s += 16) {
        const p = new THREE.Mesh(GEO.pillar, MAT.pillar);
        p.position.set((x0 + x1) / 2, -14.2, -s);
        grp.add(p);
      }
    }
    function curb(side, s0, s1) {
      // Leave the junction side open where the path turns
      if ((side < 0 && openL) || (side > 0 && openR)) s1 = Math.min(s1, seg.L - H);
      else if (s1 >= sB - 0.01) s1 = sB + 0.6; // close the corner
      if (s1 - s0 < 0.3) return;
      const m = boxUV(seg, 0.6, 1.75, s1 - s0, MAT.curb);
      m.position.set(side * (H + 0.3), -0.325, -(s0 + s1) / 2);
      grp.add(m);
      for (let s = Math.ceil(s0 / 14) * 14 + 7; s < s1 - 1; s += 14) {
        const col = new THREE.Mesh(GEO.column, MAT.curb);
        col.position.set(side * (H + 0.3), 1.4, -s);
        const cap = new THREE.Mesh(GEO.columnCap, MAT.curb);
        cap.position.set(side * (H + 0.3), 2.35, -s);
        grp.add(col, cap);
      }
    }

    // Walk along the segment cutting out gaps.
    const cuts = seg.gaps.map((g) => ({ ...g, full: true }))
      .concat(seg.halfGaps.map((g) => ({ ...g, full: false })))
      .sort((a, b) => a.s0 - b.s0);
    let cur = sA;
    for (const c of cuts) {
      floor(cur, c.s0, -H, H);
      curb(-1, cur, c.s0); curb(1, cur, c.s0);
      if (!c.full) {
        // keep the solid half
        if (c.side < 0) { floor(c.s0, c.s1, 0, H); curb(1, c.s0, c.s1); }
        else { floor(c.s0, c.s1, -H, 0); curb(-1, c.s0, c.s1); }
      }
      cur = c.s1;
    }
    floor(cur, sB, -H, H);
    curb(-1, cur, sB); curb(1, cur, sB);

    // Carved wall at the end of the junction — you must turn.
    const wall = boxUV(seg, CFG.PATH_W + 1.8, 5, 1.2, MAT.wall);
    wall.position.set(0, 1.3, -(sB + 0.6));
    grp.add(wall);
    const glyph = boxMesh(1.2, 1.2, 0.1, MAT.flameCore);
    glyph.position.set(0, 2.4, -(sB - 0.02));
    glyph.rotation.z = Math.PI / 4;
    grp.add(glyph);

    // Jungle trees rising from far below (kept clear of neighbouring paths)
    const tStart = seg.first ? -20 : 10;
    for (let s = tStart; s < seg.L - 9; s += rand(7, 13)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * rand(8, 16);
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
    for (const h of seg.halfGaps) {
      if (s > h.s0 + 0.3 && s < h.s1 - 0.3 && (h.side < 0 ? x < -0.35 : x > 0.35)) return false;
    }
    return true;
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
      camYaw: 0, camY: 0, shake: 0, time: 0,
    });
    Object.assign(P, {
      s: 0, x: 0, y: 0, vy: 0, onGround: true, falling: false, coyote: 0, jumpBuffer: 0,
      fastFall: false, slideQueued: false, sliding: false, slideT: 0,
      yaw: 0, yawVis: 0, lean: 0, shield: upg('shieldStart') > 0, phase: 0,
    });
    P.visOff.set(0, 0, 0);

    const first = createSegment(new THREE.Vector3(0, 0, 0), 0, true);
    P.seg = first;
    buildChildren(first);

    // Pre-fill the chase trail behind the start line so the monkeys have a path.
    G.trail.length = 0;
    for (let k = 40; k >= 0; k -= 0.5) G.trail.push({ d: -k, x: 0, z: k });

    runner.body.rotation.set(0, 0, 0);
    runner.body.position.set(0, 0, 0);
    updateVisuals(0);
  }

  function startGame() {
    Sfx.init();
    resetRun();
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
      character: charById(Save.data.character).name, date: Date.now(),
    });
    Save.data.highScores.sort((a, b) => b.score - a.score);
    Save.data.highScores = Save.data.highScores.slice(0, 10);
    Save.save();

    const titles = { caught: 'Caught!', fall: 'You Fell!', wall: 'Splat!', crash: 'Crashed!', burn: 'Scorched!' };
    const reasons = {
      caught: 'The Demon Monkeys got you.',
      fall: 'You plunged into the abyss.',
      wall: 'You ran straight into a wall. Turn at the corners!',
      crash: 'You ran into an obstacle.',
      burn: 'Slide under the fire traps!',
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
    if (G.dying) return;
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
    if (G.dying) return;
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
    else if (type === 'boost') { G.boostT = boostDuration(); G.stumbleT = 0; UI.toast('BOOST!', 'good'); }
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
      getRunnerWorld(_a); _a.y += 1;
      Particles.spawn(_a, 0x4aa8ff, 20, 6, 0.2);
      if (obstacle) smashObstacle(obstacle);
      if (reason === 'fall') {
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
    G.shake = 0.6;
    if (reason === 'fall') Sfx.splash(); else Sfx.crash();
    if (reason === 'caught') Sfx.roar();
    return false;
  }

  /** Minor mistake: slow down, monkeys close in. Second one = caught. */
  function stumble() {
    if (G.dying || G.invulnT > 0 || G.boostT > 0) return;
    G.speedMul = 0.55;
    G.shake = 0.35;
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

    // ---- forward + lateral motion ----
    P.s += G.speed * h;
    G.distance += G.speed * h;
    const steer = (Input.right ? 1 : 0) - (Input.left ? 1 : 0);
    P.x = clamp(P.x + steer * CFG.STEER_SPEED * h, -CFG.LANE_LIMIT, CFG.LANE_LIMIT);

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
      } else if (o.type === 'fire') {
        const top = P.y + (P.sliding ? 0.85 : 1.8);
        if (top > 1.05) { if (!fatal('burn', o)) return; }
      } else if (o.type === 'rock') {
        if (P.y > 1.25) continue; // jumped over
        const ov = Math.min(P.x + 0.4, o.x1) - Math.max(P.x - 0.4, o.x0);
        if (ov <= 0) continue;
        const pushOut = () => {
          P.x = P.x < (o.x0 + o.x1) / 2 ? o.x0 - 0.41 : o.x1 + 0.41;
          P.x = clamp(P.x, -CFG.LANE_LIMIT, CFG.LANE_LIMIT);
        };
        if (o.clipped) { pushOut(); continue; }  // already brushed: acts as a solid side wall
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
      Particles.spawn(_a, COIN_HEX[c.value], 4, 3, 0.1);
    };
    for (const c of seg.coins) {
      if (c.taken) continue;
      if (G.magnetT > 0 && !c.flying && Math.abs(c.s - P.s) < CFG.MAGNET_RANGE) {
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
    G.score = Math.floor(G.distance * G.mult) + G.coins;
    updateVisuals(dt);
    UI.updateHUD();
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
    if (P.sliding) {
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
    const steer = state === State.PLAYING && !G.dying ? (Input.right ? 1 : 0) - (Input.left ? 1 : 0) : 0;
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
      G.shake = Math.max(0, G.shake - dt);
      const sh = G.shake * 0.6;
      camera.position.set(
        _pos.x - fx * CFG.CAM_BACK + rand(-sh, sh),
        G.camY + CFG.CAM_UP + rand(-sh, sh),
        _pos.z - fz * CFG.CAM_BACK + rand(-sh, sh)
      );
      camera.lookAt(_pos.x + fx * 6, G.camY + 1.4, _pos.z + fz * 6);
      // speed sensation: widen FOV with speed / boost
      const fovT = G.boostT > 0 ? 80 : 65 + Math.min(8, (G.speed - CFG.BASE_SPEED) * 0.35);
      const nf = damp(camera.fov, fovT, 3, dt);
      if (Math.abs(nf - camera.fov) > 0.01) { camera.fov = nf; camera.updateProjectionMatrix(); }
    }
    jungleFloor.position.x = camera.position.x;
    jungleFloor.position.z = camera.position.z;
  }

  /** Spin coins, flicker flames, bob power-ups — runs in every state. */
  function animateWorld(dt) {
    const t = G.time;
    for (const seg of G.segments) {
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
  const Input = { left: false, right: false };
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'space', Escape: 'pause', KeyP: 'pause', Enter: 'enter', KeyM: 'mute',
  };

  window.addEventListener('keydown', (e) => {
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
        else if (a === 'space') { if (!tryActivateMeter()) pauseGame(); }
        else if (a === 'pause') pauseGame();
        break;
      case State.PAUSED:
        if (a === 'space' || a === 'pause' || a === 'enter') resumeGame();
        break;
      case State.START:
        if (a === 'enter' && !$('screen-start').classList.contains('hidden')) startGame();
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
  window.addEventListener('blur', () => { Input.left = Input.right = false; pauseGame(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

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
      const danger = G.stumbleT > 0 ? 0.35 + 0.65 * (G.stumbleT / CFG.RECOVER_TIME) : 0;
      if (this.hudCache.danger !== danger) { this.hudCache.danger = danger; $('danger-vignette').style.opacity = danger; }
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
        ? hs.map((h, i) => `<tr><td>${i + 1}</td><td>${h.score.toLocaleString()}</td><td>${h.distance.toLocaleString()} m</td><td>${h.coins}</td><td>${h.character}</td></tr>`).join('')
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
      case 'start': startGame(); break;
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
      case 'toggle-mute': Sfx.setMuted(!Save.data.muted); UI.updateMuteButton(); break;
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
    window.__ruins = { G, P, CFG, Input, getState: () => state, startGame, jump, slide, onTurnKey, activatePower, stumble };
  }

  // Boot: build the menu backdrop and show the start screen.
  resetRun();
  for (const m of monkeys) m.root.visible = false;
  UI.refreshMenu();
  UI.updateMuteButton();
  requestAnimationFrame(frame);
})();
