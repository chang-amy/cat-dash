/* ============================================================
   CAT DASH — a one-button street-parkour runner (GD style)
   Help Miso the cat run, jump and bounce her way home for dinner.
   ============================================================ */
'use strict';

/* ---------------- helpers ---------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[(Math.random() * arr.length) | 0];

function hash(n) { // deterministic 0..1 from an integer (stable scenery)
  n = Math.imul(n ^ 61, 0x27d4eb2d); n ^= n >>> 15;
  n = Math.imul(n, 0x2c1b3c6d); n ^= n >>> 12;
  n = Math.imul(n, 0x297a2d39); n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('catdash_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('catdash_' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

/* ---------------- DOM ---------------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);
const ui = {
  hud: $('hud'), barFill: $('barFill'), barText: $('barText'), bestMark: $('bestMark'),
  attemptChip: $('attemptChip'), fishChip: $('fishChip'), levelChip: $('levelChip'),
  title: $('titleScreen'), death: $('deathScreen'), win: $('winScreen'), pause: $('pauseScreen'),
  tBest: $('tBest'), tFish: $('tFish'), tTries: $('tTries'),
  dPct: $('dPct'), dFish: $('dFish'), dBest: $('dBest'), dNewBest: $('dNewBest'),
  wFish: $('wFish'), wTime: $('wTime'), wLevel: $('wLevel'),
  mute: $('muteBtn'),
};

/* ---------------- tuning ---------------- */
const PHYS = {
  gravity: 2600, jump: 960, baseSpeed: 350, maxSpeed: 565,
  holdTime: 0.24,   // seconds of reduced gravity while the jump is held
  holdGravity: 0.5, // gravity multiplier during a held jump (lower = floatier, longer jump)
};
const LEVEL_DIST = 23000;              // level length at S=1 (~55s run)
const CAT_H = 40;                      // hitbox height at S=1
const HIT_L = -12, HIT_R = 24;         // hitbox x-extent around cat.x, at S=1

const OB = { // obstacle specs (unscaled); wS/hS = random size range [min, max]
  cone:    { w: 30, h: 34, insetX: 9, insetY: 12, wS: [0.9, 1.15], hS: [0.8, 1.5] },
  trash:   { w: 42, h: 56, insetX: 5, insetY: 8,  wS: [0.85, 1.2], hS: [0.85, 1.35] },
  hydrant: { w: 32, h: 46, insetX: 6, insetY: 8,  wS: [0.9, 1.15], hS: [0.9, 1.3] },
  crate:   { w: 48, h: 46, insetX: 2, insetY: 0,  wS: [0.95, 1.1], hS: [1, 1] }, // landable, stackable
};
const CONFETTI = ['#ffd45e', '#ff7a59', '#7fd4ff', '#b7ffab', '#ffa9d6', '#fff3d6'];

/* ---------------- state ---------------- */
let state = 'menu'; // menu | playing | dead | win | paused
let world = null;
let level = 1;
let speedMult = 1;
const save = {
  best: store.get('best', 0),
  attempts: store.get('attempts', 0),
  fishTotal: store.get('fish', 0),
};
const cat = {
  x: 0, y: 0, vy: 0,
  onGround: true, onCrate: null,
  holdJump: false, buffer: 0, holdT: 0,
  squashT: 0, stretchT: 0,
  screenX: 0, visible: true,
};

/* ---------------- sound (tiny WebAudio synth, no files) ---------------- */
const sfx = (() => {
  let ac = null;
  let muted = store.get('muted', false);
  function ensure() {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } }
    if (ac && ac.state === 'suspended') ac.resume();
  }
  function tone(f0, f1, dur, type, vol, delay = 0) {
    if (muted) return; ensure(); if (!ac) return;
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function meow() {
    if (muted) return; ensure(); if (!ac) return;
    const t0 = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain(), f = ac.createBiquadFilter();
    o.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.value = 1300;
    o.frequency.setValueAtTime(430, t0);
    o.frequency.linearRampToValueAtTime(790, t0 + 0.12);
    o.frequency.linearRampToValueAtTime(520, t0 + 0.34);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    o.connect(f); f.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + 0.42);
  }
  return {
    unlock: ensure,
    jump: () => tone(340, 640, 0.13, 'square', 0.055),
    land: () => tone(150, 90, 0.07, 'triangle', 0.06),
    fish: () => { tone(660, 660, 0.08, 'sine', 0.07); tone(990, 990, 0.12, 'sine', 0.07, 0.08); },
    death: () => { tone(300, 42, 0.4, 'sawtooth', 0.1); tone(170, 30, 0.45, 'square', 0.05, 0.03); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.16, 'triangle', 0.08, i * 0.12)),
    meow,
    get muted() { return muted; },
    toggle() { muted = !muted; store.set('muted', muted); return muted; },
  };
})();

/* ---------------- canvas sizing ---------------- */
let W = 0, H = 0, DPR = 1, S = 1, GROUND_Y = 0;

function resize() {
  DPR = clamp(window.devicePixelRatio || 1, 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  const newS = clamp(Math.min(W / 980, H / 660), 0.62, 1.15);
  if (world && Math.abs(newS - S) > 0.001) { // rescale live world so gameplay stays proportional
    const r = newS / S;
    world.dist *= r; world.nextSpawn *= r; world.doorX *= r;
    for (const o of world.obstacles) { o.x *= r; o.w *= r; o.h *= r; o.insetX *= r; o.insetY *= r; }
    for (const f of world.fish) { f.x *= r; f.y *= r; }
    for (const p of world.pigeons) { p.x *= r; p.y *= r; }
    for (const p of world.particles) { p.x *= r; p.y *= r; p.vx *= r; p.vy *= r; p.size *= r; }
    cat.y *= r; cat.vy *= r;
  }
  S = newS;
  GROUND_Y = Math.round(H * 0.78);
  cat.screenX = Math.round(W * 0.24);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);

/* ---------------- world / flow ---------------- */
function resetWorld() {
  world = {
    dist: 0, camX: 0,
    nextSpawn: 780 * S,
    doorX: LEVEL_DIST * S,
    obstacles: [], fish: [], pigeons: [], particles: [],
    runFish: 0, runTime: 0,
    shakeT: 0, deathT: 0, winT: 0, confT: 0, dustT: 0, floatT: 0,
    newBest: false, deathShown: false, winShown: false,
  };
  cat.x = 0; cat.y = 0; cat.vy = 0;
  cat.onGround = true; cat.onCrate = null;
  cat.holdJump = false; cat.buffer = 0; cat.holdT = 0;
  cat.squashT = 0; cat.stretchT = 0; cat.visible = true;
  ui.bestMark.style.left = clamp(save.best, 0, 100) + '%';
}

function currentSpeed() {
  const t = clamp(world.dist / world.doorX, 0, 1);
  return lerp(PHYS.baseSpeed, PHYS.maxSpeed, t) * S * speedMult;
}

function progressPct() {
  return world ? clamp(world.dist / world.doorX * 100, 0, 100) : 0;
}

function showScreen(which) {
  for (const s of [ui.title, ui.death, ui.win, ui.pause]) s.classList.add('hidden');
  if (which) which.classList.remove('hidden');
}

function updateHud() {
  const pct = progressPct();
  ui.barFill.style.width = pct + '%';
  ui.barText.textContent = Math.floor(pct) + '%';
  ui.fishChip.textContent = '🐟 ' + world.runFish;
  ui.attemptChip.textContent = 'Try #' + save.attempts;
  if (level > 1) {
    ui.levelChip.textContent = 'Lv ' + level;
    ui.levelChip.classList.remove('hidden');
  }
}

function refreshTitleStats() {
  ui.tBest.textContent = Math.floor(save.best) + '%';
  ui.tFish.textContent = save.fishTotal;
  ui.tTries.textContent = save.attempts;
}

function startGame() {
  save.attempts++; store.set('attempts', save.attempts);
  resetWorld();
  state = 'playing';
  showScreen(null);
  ui.hud.classList.remove('hidden');
  updateHud();
}

function nextLevelAndStart() {
  level++;
  speedMult = Math.pow(1.12, level - 1);
  startGame();
}

function die() {
  state = 'dead';
  world.deathT = 0; world.deathShown = false;
  world.shakeT = 0.45;
  cat.visible = false;
  burstDeath();
  sfx.death();
  const pct = progressPct();
  world.newBest = pct > save.best && save.best < 100;
  if (pct > save.best) { save.best = pct; store.set('best', save.best); }
  save.fishTotal += world.runFish; store.set('fish', save.fishTotal);
}

function winGame() {
  state = 'win';
  world.winT = 0; world.winShown = false;
  world.dist = world.doorX; // snap to the door
  save.fishTotal += world.runFish; store.set('fish', save.fishTotal);
  if (save.best < 100) { save.best = 100; store.set('best', 100); }
  sfx.win();
  setTimeout(() => sfx.meow(), 350);
  confettiBurst();
  updateHud();
}

function pauseGame() { if (state !== 'playing') return; state = 'paused'; showScreen(ui.pause); }
function resumeGame() { if (state !== 'paused') return; state = 'playing'; showScreen(null); lastT = 0; }

/* ---------------- obstacle patterns ---------------- */
function ob(type, dx, stack) {
  const spec = OB[type];
  const wSc = rand(spec.wS[0], spec.wS[1]);
  const hSc = rand(spec.hS[0], spec.hS[1]);
  return {
    type, dx,
    w: spec.w * wSc,
    h: spec.h * (type === 'crate' ? (stack || 1) : hSc), // crates vary by stack count
    insetX: spec.insetX * wSc,
    insetY: spec.insetY * (type === 'crate' ? 1 : hSc),
  };
}
const fi = (dx, dy) => ({ dx, dy });

const PATTERNS = [
  { min: 0,    w: 3,   make: () => ({ obs: [ob('cone', 0)], extent: 18 }) },
  { min: 0,    w: 2,   make: () => ({ obs: [ob('crate', 0, 1 + ((Math.random() * 2) | 0))], extent: 27, pigeon: 0.2 }) },
  { min: 0,    w: 2,   make: () => ({ obs: [ob('trash', 0)], extent: 26, pigeon: 0.35 }) },
  { min: 0.05, w: 2,   make: () => ({ obs: [], extent: 0, fish: [fi(0, 35), fi(70, 55), fi(140, 35), fi(210, 55)] }) },
  { min: 0.12, w: 2,   make: () => ({ obs: [ob('cone', 0), ob('cone', 40)], extent: 58 }) },
  { min: 0.16, w: 2,   make: () => ({ obs: [ob('hydrant', 0)], extent: 19 }) },
  { min: 0.2,  w: 2,   make: () => ({ obs: [ob('crate', 0, 2 + ((Math.random() * 2) | 0))], extent: 27, pigeon: 0.35 }) },
  { min: 0.22, w: 2,   make: () => ({ obs: [ob('cone', 0)], extent: 18, fish: [fi(-26, 90), fi(0, 120), fi(26, 90)] }) },
  { min: 0.38, w: 1.5, make: () => ({ obs: [ob('cone', 0), ob('cone', 42), ob('cone', 84)], extent: 102 }) },
  { min: 0.4,  w: 1.5, make: () => ({ obs: [ob('crate', 0, 1 + ((Math.random() * 2) | 0)), ob('cone', 131)], extent: 149 }) },
  { min: 0.52, w: 1,   make: () => ({ obs: [ob('trash', 0), ob('hydrant', 127)], extent: 146 }) },
  { min: 0.6,  w: 1,   make: () => ({ obs: [ob('crate', 0, 2 + ((Math.random() * 2) | 0)), ob('cone', 149)], extent: 167 }) },
];

function pickPattern() {
  const d = clamp(world.dist / world.doorX, 0, 1);
  const avail = PATTERNS.filter(p => d >= p.min);
  let total = 0;
  for (const p of avail) total += p.w;
  let roll = Math.random() * total;
  for (const p of avail) { roll -= p.w; if (roll <= 0) return p.make(); }
  return avail[avail.length - 1].make();
}

function spawnAhead(speed) {
  const lookX = world.dist + W + 400 * S;
  while (world.nextSpawn < lookX) {
    if (world.nextSpawn > world.doorX - 800 * S) { world.nextSpawn = Infinity; break; } // clear runway home
    const pat = pickPattern();
    const x0 = world.nextSpawn;
    let topOb = null;
    for (const spec of pat.obs) {
      const o = {
        type: spec.type,
        x: x0 + spec.dx * S,
        w: spec.w * S, h: spec.h * S,
        insetX: spec.insetX * S, insetY: spec.insetY * S,
      };
      world.obstacles.push(o);
      if (spec.type === 'crate' || spec.type === 'trash') topOb = o; // pigeon perches
    }
    if (pat.fish) for (const f of pat.fish) world.fish.push({ x: x0 + f.dx * S, y: f.dy * S, bob: Math.random() * TAU, taken: false });
    if (pat.pigeon && topOb && Math.random() < pat.pigeon) {
      world.pigeons.push({ x: topOb.x, y: topOb.h, fly: false, vy: 0, seed: Math.random() });
    }
    const d = clamp(world.dist / world.doorX, 0, 1);
    const gap = speed * rand(0.5, 1.15 - d * 0.3) * 0.74 + 130 * S;
    world.nextSpawn = x0 + pat.extent * S + gap;
  }
}

/* ---------------- physics ---------------- */
function doJump() {
  cat.vy = PHYS.jump * S;
  cat.onGround = false; cat.onCrate = null;
  cat.buffer = 0; cat.stretchT = 1; cat.holdT = PHYS.holdTime; // hold budget for this jump
  puff(cat.x, 4 * S, 0.6);
  puff(cat.x - 8 * S, 2 * S, 0.5);
  sfx.jump();
}

function landGround() {
  cat.y = 0; cat.vy = 0; cat.onGround = true; cat.onCrate = null;
  cat.squashT = 1;
  for (let i = 0; i < 4; i++) puff(cat.x + rand(-16, 10) * S, rand(0, 6) * S, 0.5);
  sfx.land();
}

function landOn(o) {
  cat.y = o.h; cat.vy = 0; cat.onGround = true; cat.onCrate = o;
  cat.squashT = 0.8;
  for (let i = 0; i < 3; i++) puff(cat.x + rand(-14, 8) * S, o.h + rand(0, 4) * S, 0.5);
  sfx.land();
}

function handleCollisions(prevBottom) {
  const l = cat.x + HIT_L * S, r = cat.x + HIT_R * S;
  for (const o of world.obstacles) {
    const plat = o.type === 'crate'; // all crates (any stack height) are landable
    const oL = o.x - o.w / 2 + (plat ? 2 * S : o.insetX);
    const oR = o.x + o.w / 2 - (plat ? 2 * S : o.insetX);
    if (oR < l || oL > r) continue;
    if (plat) {
      if (cat.vy <= 0 && prevBottom >= o.h - 18 * S && cat.y <= o.h) { landOn(o); continue; }
      if (cat.y < o.h - 8 * S) { die(); return; }
    } else if (cat.y < o.h - o.insetY) { die(); return; }
  }
}

function collectFish() {
  const cx = cat.x + 6 * S, cy = cat.y + 20 * S;
  for (const f of world.fish) {
    if (f.taken) continue;
    const dx = f.x - cx, dy = f.y - cy;
    if (dx * dx + dy * dy < (40 * S) * (40 * S)) {
      f.taken = true;
      world.runFish++;
      sfx.fish();
      sparkle(f.x, f.y);
    }
  }
}

function updatePigeons(dt) {
  for (const p of world.pigeons) {
    if (!p.fly) {
      if (cat.x > p.x - 190 * S) { p.fly = true; p.vy = 330 * S; }
    } else {
      p.y += p.vy * dt;
      p.x += 90 * S * dt;
      p.vy = Math.max(90 * S, p.vy - 260 * S * dt);
    }
  }
}

/* ---------------- particles ---------------- */
function puff(x, y, strength) {
  world.particles.push({
    type: 'puff', x, y,
    vx: rand(-70, -30) * S, vy: rand(20, 70) * S * strength,
    life: rand(0.25, 0.5), max: 0.5, size: rand(3, 7) * S, grav: false,
  });
}

function sparkle(x, y) {
  for (let i = 0; i < 7; i++) world.particles.push({
    type: 'spark', x, y,
    vx: rand(-160, 160) * S, vy: rand(-40, 240) * S,
    life: rand(0.3, 0.55), max: 0.55, size: rand(2, 4) * S, grav: true,
  });
}

function burstDeath() {
  const x = cat.x + 8 * S, y = cat.y + 18 * S;
  for (let i = 0; i < 24; i++) world.particles.push({
    type: 'fur', x, y,
    vx: rand(-240, 340) * S, vy: rand(120, 640) * S,
    life: rand(0.5, 1), max: 1, size: rand(3, 7) * S, grav: true,
    color: pick(['#f59f4a', '#d97a2b', '#ffe4c4', '#c96a24']),
  });
  for (let i = 0; i < 8; i++) world.particles.push({
    type: 'star', x, y,
    vx: rand(-200, 200) * S, vy: rand(200, 520) * S,
    life: rand(0.4, 0.8), max: 0.8, size: rand(4, 8) * S, grav: true, spin: rand(-8, 8),
  });
  world.particles.push({ type: 'ring', x, y, vx: 0, vy: 0, life: 0.4, max: 0.4, size: 70 * S, grav: false });
}

function confettiBurst() {
  const x = cat.x, y = cat.y + 60 * S;
  for (let i = 0; i < 60; i++) world.particles.push({
    type: 'confetti', x: x + rand(-40, 40) * S, y: y + rand(-20, 60) * S,
    vx: rand(-220, 220) * S, vy: rand(180, 560) * S,
    life: rand(0.8, 1.6), max: 1.6, size: rand(3, 6) * S, grav: true,
    spin: rand(-10, 10), color: pick(CONFETTI),
  });
}

function spawnConfetti() {
  world.particles.push({
    type: 'confetti', x: world.camX + rand(0, W), y: (H - GROUND_Y) + rand(0, 60),
    vx: rand(-60, 60) * S, vy: rand(-20, 40) * S,
    life: rand(1.5, 2.4), max: 2.4, size: rand(3, 6) * S, grav: true,
    spin: rand(-8, 8), color: pick(CONFETTI),
  });
}

function updateParticles(dt) {
  for (const p of world.particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.grav) p.vy -= 1400 * S * dt;
    if (p.spin) p.rot = (p.rot || 0) + p.spin * dt;
  }
  world.particles = world.particles.filter(p => p.life > 0 && p.y > -80 * S);
}

/* ---------------- update ---------------- */
function update(dt) {
  if (!world) return;
  if (state === 'playing') { updatePlaying(dt); return; }

  updateParticles(dt);
  world.shakeT = Math.max(0, world.shakeT - dt);

  if (state === 'dead') {
    world.deathT += dt;
    if (!world.deathShown && world.deathT > 0.5) {
      world.deathShown = true;
      ui.dPct.textContent = Math.floor(progressPct()) + '%';
      ui.dFish.textContent = world.runFish;
      ui.dBest.textContent = Math.floor(save.best) + '%';
      ui.dNewBest.classList.toggle('hidden', !world.newBest);
      showScreen(ui.death);
    }
  } else if (state === 'win') {
    world.winT += dt;
    world.confT -= dt;
    while (world.confT < 0) { world.confT += 0.09; spawnConfetti(); }
    if (!world.winShown && world.winT > 0.7) {
      world.winShown = true;
      ui.wFish.textContent = world.runFish;
      ui.wTime.textContent = world.runTime.toFixed(1) + 's';
      ui.wLevel.textContent = level + 1;
      showScreen(ui.win);
    }
  }
}

function updatePlaying(dt) {
  const speed = currentSpeed();
  world.runTime += dt;
  world.dist += speed * dt;
  cat.x = world.dist;
  world.camX = world.dist - cat.screenX;
  world.shakeT = Math.max(0, world.shakeT - dt);

  spawnAhead(speed);

  // input → jump (hold = auto-bounce, GD style; plus a short landing buffer)
  if (cat.buffer > 0) cat.buffer -= dt;
  cat.squashT = Math.max(0, cat.squashT - dt * 6);
  cat.stretchT = Math.max(0, cat.stretchT - dt * 5);
  if (cat.onGround && (cat.holdJump || cat.buffer > 0)) doJump();

  // integrate — holding the jump while rising = floatier, higher, longer jump
  const prevBottom = cat.y;
  const floating = !cat.onGround && cat.holdJump && cat.vy > 0 && cat.holdT > 0;
  if (floating) {
    cat.holdT -= dt;
    world.floatT -= dt;
    if (world.floatT <= 0) { world.floatT = 0.05; puff(cat.x - 16 * S, cat.y + 34 * S, 0.35); }
  }
  if (!cat.onGround) {
    const g = PHYS.gravity * (floating ? PHYS.holdGravity : 1) * S;
    cat.vy -= g * dt;
    cat.y += cat.vy * dt;
    if (cat.y <= 0 && cat.vy <= 0) landGround();
  }

  // still standing on a crate?
  if (cat.onCrate) {
    const o = cat.onCrate;
    const overlap = cat.x + HIT_R * S > o.x - o.w / 2 + 2 * S &&
                    cat.x + HIT_L * S < o.x + o.w / 2 - 2 * S;
    if (!overlap) { cat.onCrate = null; cat.onGround = false; }
    else cat.y = o.h;
  }

  handleCollisions(prevBottom);
  if (state !== 'playing') return; // died mid-loop
  collectFish();
  updatePigeons(dt);

  // running dust
  if (cat.onGround) {
    world.dustT -= dt;
    if (world.dustT <= 0) { world.dustT = 0.09; puff(cat.x - 14 * S, 2 * S, 0.5); }
  }

  // home!
  if (world.dist >= world.doorX) { winGame(); return; }

  // cull what's behind us
  const cullX = world.camX - 320 * S;
  world.obstacles = world.obstacles.filter(o => o.x + o.w > cullX);
  world.fish = world.fish.filter(f => !f.taken && f.x > cullX);
  world.pigeons = world.pigeons.filter(p => p.x > cullX && p.y < (H - GROUND_Y) + 120);

  updateHud();
}

/* ---------------- drawing ---------------- */
function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function starPath(x, y, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rad = i % 2 ? r * 0.45 : r;
    const a = rot + i * Math.PI / 4;
    const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawSky(t) {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0, '#161041');
  g.addColorStop(0.45, '#3d1f63');
  g.addColorStop(0.78, '#8e3d69');
  g.addColorStop(1, '#e0794f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, GROUND_Y + 2);

  // stars
  ctx.fillStyle = '#ffedd7';
  const span = W * 1.4;
  for (let i = 0; i < 60; i++) {
    const x = ((hash(i * 3 + 1) * span - world.camX * 0.03) % span + span) % span - W * 0.2;
    const y = hash(i * 7 + 2) * GROUND_Y * 0.55;
    const a = (0.3 + 0.7 * Math.abs(Math.sin(t * (0.6 + hash(i) * 1.4) + i * 2))) *
              clamp(1 - y / (GROUND_Y * 0.6), 0, 1);
    ctx.globalAlpha = a * 0.9;
    const r = 0.8 + hash(i * 11 + 3) * 1.6;
    ctx.fillRect(x, y, r, r);
  }
  ctx.globalAlpha = 1;

  // moon
  const mx = W * 0.74, my = H * 0.16, mr = (26 + 10) * Math.max(S, 0.8);
  const glow = ctx.createRadialGradient(mx, my, mr * 0.4, mx, my, mr * 3.2);
  glow.addColorStop(0, 'rgba(255, 238, 200, 0.25)');
  glow.addColorStop(1, 'rgba(255, 238, 200, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(mx, my, mr * 3.2, 0, TAU); ctx.fill();
  ctx.fillStyle = '#f8e9c0';
  ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(214, 193, 140, 0.5)';
  ctx.beginPath(); ctx.arc(mx - mr * 0.3, my - mr * 0.15, mr * 0.16, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(mx + mr * 0.25, my + mr * 0.3, mr * 0.11, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(mx + mr * 0.1, my - mr * 0.35, mr * 0.07, 0, TAU); ctx.fill();
}

function skyline(cam, par, avgW, minH, maxH, color, seed, windows, t) {
  const off = cam * par;
  const aW = avgW * S;
  const k0 = Math.floor((off - aW) / aW);
  const k1 = Math.ceil((off + W + aW) / aW);
  for (let k = k0; k <= k1; k++) {
    const bw = aW * (0.55 + hash(k * 3 + seed) * 0.7);
    const bh = lerp(minH, maxH, hash(k * 5 + seed + 2) * hash(k * 13 + seed)) * S;
    const x = k * aW - off;
    ctx.fillStyle = color;
    ctx.fillRect(x, GROUND_Y - bh, bw, bh);
    if (hash(k * 9 + seed) > 0.75) { // antenna with a red light
      ctx.fillRect(x + bw * 0.35, GROUND_Y - bh - 16 * S, 2, 16 * S);
      ctx.fillStyle = '#ff6b5e';
      ctx.beginPath(); ctx.arc(x + bw * 0.35 + 1, GROUND_Y - bh - 17 * S, 2 * S, 0, TAU); ctx.fill();
    }
    if (hash(k * 21 + seed) > 0.85) { // rooftop water tank
      const tx = x + bw * 0.6;
      ctx.fillStyle = '#221733';
      ctx.fillRect(tx, GROUND_Y - bh - 12 * S, 14 * S, 10 * S);
      ctx.beginPath();
      ctx.moveTo(tx - 1 * S, GROUND_Y - bh - 12 * S);
      ctx.lineTo(tx + 7 * S, GROUND_Y - bh - 17 * S);
      ctx.lineTo(tx + 15 * S, GROUND_Y - bh - 12 * S);
      ctx.closePath(); ctx.fill();
    }
    if (windows) {
      const cols = Math.min(6, Math.floor(bw / (14 * S)));
      const rows = Math.min(9, Math.floor(bh / (18 * S)));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const hs = hash(k * 131 + r * 17 + c * 7 + seed);
          if (hs < 0.42) {
            let a = 0.85;
            if (hs < 0.05) a = 0.4 + 0.5 * Math.abs(Math.sin(t * 2 + k + r)); // flickering TV
            ctx.fillStyle = 'rgba(255, 203, 120, ' + a.toFixed(2) + ')';
            ctx.fillRect(x + 5 * S + c * 14 * S, GROUND_Y - bh + 6 * S + r * 18 * S, 7 * S, 10 * S);
          }
        }
      }
    }
  }
}

function drawBuildings(cam, t) {
  skyline(cam, 0.12, 120, 80, 210, '#5a2f66', 11, false);         // far
  skyline(cam, 0.3, 150, 120, 300, '#2c1c49', 29, true, t);        // mid, lit windows
}

function drawGround(cam) {
  // sidewalk
  const swH = 22 * S + 6;
  ctx.fillStyle = '#3b3348';
  ctx.fillRect(0, GROUND_Y, W, swH);
  ctx.fillStyle = '#514764';
  ctx.fillRect(0, GROUND_Y, W, 2.5 * S);
  const seamP = 84 * S;
  ctx.fillStyle = '#2d2639';
  for (let x = -(((cam % seamP) + seamP) % seamP); x < W; x += seamP) {
    ctx.fillRect(x, GROUND_Y + 2.5 * S, 2, swH);
  }
  // asphalt
  const aY = GROUND_Y + swH;
  ctx.fillStyle = '#17131f';
  ctx.fillRect(0, aY, W, Math.max(0, H - aY));
  // lane dashes
  ctx.fillStyle = 'rgba(240, 200, 90, 0.45)';
  const dashP = 88 * S, dashW = 40 * S;
  for (let x = -(((cam % dashP) + dashP) % dashP); x < W; x += dashP) {
    ctx.fillRect(x, aY + 20 * S, dashW, 4.5 * S);
  }
  // manholes
  const mP = 640 * S;
  const k0 = Math.floor(cam / mP) - 1;
  const k1 = k0 + Math.ceil(W / mP) + 2;
  for (let k = k0; k <= k1; k++) {
    const x = k * mP - cam + hash(k * 31) * 300 * S;
    if (x < -40 || x > W + 40) continue;
    ctx.fillStyle = '#100d18';
    ctx.beginPath(); ctx.ellipse(x, aY + 46 * S, 15 * S, 6 * S, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2a2338'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, aY + 46 * S, 15 * S, 6 * S, 0, 0, TAU); ctx.stroke();
  }
}

function drawLamps(cam, t) {
  const par = 0.8, period = 430 * S;
  const off = cam * par;
  const k0 = Math.floor(off / period) - 1;
  const k1 = k0 + Math.ceil(W / period) + 2;
  const lampX = k => k * period - off + (hash(k * 17) - 0.5) * 120 * S;
  const topY = GROUND_Y - 148 * S;

  // sagging wires between lamp tops
  ctx.strokeStyle = 'rgba(20, 14, 32, 0.9)';
  ctx.lineWidth = 1.6;
  for (let k = k0; k <= k1 + 1; k++) {
    const x1 = lampX(k), x2 = lampX(k + 1);
    ctx.beginPath();
    ctx.moveTo(x1, topY + 6 * S);
    ctx.quadraticCurveTo((x1 + x2) / 2, topY + 24 * S, x2, topY + 6 * S);
    ctx.stroke();
  }

  for (let k = k0; k <= k1; k++) {
    const x = lampX(k);
    if (x < -80 || x > W + 80) continue;
    const flick = 0.9 + 0.1 * Math.sin(t * 9 + k * 3) * hash(k * 5);
    // light cone
    const lg = ctx.createLinearGradient(x, topY, x, GROUND_Y);
    lg.addColorStop(0, 'rgba(255, 190, 110, ' + (0.12 * flick).toFixed(3) + ')');
    lg.addColorStop(1, 'rgba(255, 190, 110, 0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(x - 9 * S, topY + 10 * S);
    ctx.lineTo(x + 9 * S, topY + 10 * S);
    ctx.lineTo(x + 62 * S, GROUND_Y);
    ctx.lineTo(x - 62 * S, GROUND_Y);
    ctx.closePath(); ctx.fill();
    // pole + base
    ctx.fillStyle = '#241c33';
    ctx.fillRect(x - 3.5 * S, topY, 7 * S, GROUND_Y - topY);
    ctx.fillRect(x - 7 * S, GROUND_Y - 10 * S, 14 * S, 10 * S);
    // lamp head + glow
    const hg = ctx.createRadialGradient(x, topY, 2, x, topY, 30 * S);
    hg.addColorStop(0, 'rgba(255, 214, 140, ' + (0.5 * flick).toFixed(3) + ')');
    hg.addColorStop(1, 'rgba(255, 214, 140, 0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(x, topY, 30 * S, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2b2238';
    rr(x - 12 * S, topY - 14 * S, 24 * S, 14 * S, 5 * S); ctx.fill();
    ctx.fillStyle = '#ffdf9e';
    rr(x - 8 * S, topY - 6 * S, 16 * S, 6 * S, 3 * S); ctx.fill();
  }
}

function drawDoor(cam) {
  const x = world.doorX - cam;
  if (x < -260 * S || x > W + 320 * S) return;
  const w = 180 * S, h = 160 * S;
  const left = x - w / 2, top = GROUND_Y - h;

  // brick facade
  ctx.fillStyle = '#7c4a3a';
  ctx.fillRect(left, top, w, h);
  ctx.strokeStyle = 'rgba(52, 28, 22, 0.5)';
  ctx.lineWidth = 1.4;
  for (let i = 1; i < 9; i++) {
    const by = top + (h / 9) * i;
    ctx.beginPath(); ctx.moveTo(left, by); ctx.lineTo(left + w, by); ctx.stroke();
  }
  // lit window
  ctx.fillStyle = '#ffd894';
  rr(left + 14 * S, top + 18 * S, 30 * S, 34 * S, 4 * S); ctx.fill();
  ctx.strokeStyle = '#4a281f'; ctx.lineWidth = 2.4 * S;
  ctx.beginPath();
  ctx.moveTo(left + 29 * S, top + 18 * S); ctx.lineTo(left + 29 * S, top + 52 * S);
  ctx.moveTo(left + 14 * S, top + 35 * S); ctx.lineTo(left + 44 * S, top + 35 * S);
  ctx.stroke();
  // arched doorway
  const dw = 56 * S, dh = 84 * S;
  const dl = x - dw / 2, dt2 = GROUND_Y - dh;
  ctx.fillStyle = '#3f231b';
  rr(dl, dt2, dw, dh, 26 * S); ctx.fill();
  ctx.fillStyle = '#c94f43';
  rr(dl + 6 * S, dt2 + 6 * S, dw - 12 * S, dh - 6 * S, 20 * S); ctx.fill();
  ctx.strokeStyle = 'rgba(94, 30, 24, 0.8)'; ctx.lineWidth = 2 * S;
  rr(dl + 14 * S, dt2 + 18 * S, dw - 28 * S, 28 * S, 6 * S); ctx.stroke();
  rr(dl + 14 * S, dt2 + 54 * S, dw - 28 * S, 22 * S, 6 * S); ctx.stroke();
  ctx.fillStyle = '#ffd45e';
  ctx.beginPath(); ctx.arc(dl + dw - 16 * S, dt2 + dh * 0.55, 3.2 * S, 0, TAU); ctx.fill();
  // welcome mat
  ctx.fillStyle = '#c9b37e';
  rr(x - 22 * S, GROUND_Y, 44 * S, 8 * S, 3 * S); ctx.fill();
  ctx.fillStyle = '#a89364';
  ctx.font = '700 ' + Math.round(7 * S + 2) + 'px "Baloo 2", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('WELCOME', x, GROUND_Y + 4.5 * S);
  // dinner bowl
  ctx.fillStyle = '#e8e4da';
  ctx.beginPath(); ctx.ellipse(x + 52 * S, GROUND_Y - 4 * S, 12 * S, 5 * S, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#59c8e8';
  ctx.beginPath(); ctx.ellipse(x + 52 * S, GROUND_Y - 5 * S, 8 * S, 3 * S, 0, 0, TAU); ctx.fill();
  // sign
  ctx.fillStyle = '#ffe4c4';
  rr(x - 26 * S, top - 26 * S, 52 * S, 18 * S, 5 * S); ctx.fill();
  ctx.fillStyle = '#7c4a3a';
  ctx.font = '800 ' + Math.round(10 * S + 2) + 'px "Baloo 2", system-ui, sans-serif';
  ctx.fillText('HOME', x, top - 16.5 * S);
  // warm glow from the doorway
  const g = ctx.createRadialGradient(x, GROUND_Y - 40 * S, 6 * S, x, GROUND_Y - 40 * S, 130 * S);
  g.addColorStop(0, 'rgba(255, 190, 110, 0.18)');
  g.addColorStop(1, 'rgba(255, 190, 110, 0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, GROUND_Y - 40 * S, 130 * S, 0, TAU); ctx.fill();
}

function drawCrate(x, y, w, h) {
  ctx.fillStyle = '#b5813f';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#7a5222';
  ctx.lineWidth = 3.5 * S;
  ctx.strokeRect(x + 1.5 * S, y + 1.5 * S, w - 3 * S, h - 3 * S);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 4 * S, y + h / 3); ctx.lineTo(x + w - 4 * S, y + h / 3);
  ctx.moveTo(x + 4 * S, y + h * 2 / 3); ctx.lineTo(x + w - 4 * S, y + h * 2 / 3);
  ctx.stroke();
  ctx.fillStyle = '#5d3d18';
  const pts = [[x + 5 * S, y + 5 * S], [x + w - 5 * S, y + 5 * S], [x + 5 * S, y + h - 5 * S], [x + w - 5 * S, y + h - 5 * S]];
  for (const [bx, by] of pts) { ctx.beginPath(); ctx.arc(bx, by, 2 * S, 0, TAU); ctx.fill(); }
  ctx.fillStyle = 'rgba(93, 61, 24, 0.65)';
  ctx.font = '700 ' + Math.round(8 * S + 2) + 'px "Baloo 2", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('FISH CO.', x + w / 2, y + h / 2);
}

function drawObstacle(o, cam, t) {
  const x = o.x - cam;
  if (x < -160 || x > W + 160) return;
  const w = o.w, h = o.h;
  const left = x - w / 2, top = GROUND_Y - h;

  switch (o.type) {
    case 'cone': {
      ctx.fillStyle = '#b34a1c';
      rr(left - 3 * S, GROUND_Y - 5 * S, w + 6 * S, 5 * S, 2 * S); ctx.fill();
      const p = new Path2D();
      p.moveTo(x - w * 0.14, top + 3 * S);
      p.lineTo(x + w * 0.14, top + 3 * S);
      p.lineTo(x + w / 2, GROUND_Y - 4 * S);
      p.lineTo(x - w / 2, GROUND_Y - 4 * S);
      p.closePath();
      ctx.fillStyle = '#f4703a';
      ctx.fill(p);
      ctx.save();
      ctx.clip(p);
      ctx.fillStyle = '#ffe9d8';
      ctx.fillRect(x - w / 2, GROUND_Y - h * 0.62, w, h * 0.22);
      ctx.restore();
      ctx.fillStyle = '#c9571f';
      ctx.beginPath(); ctx.arc(x, top + 4 * S, 3 * S, 0, TAU); ctx.fill();
      break;
    }
    case 'trash': {
      ctx.fillStyle = '#8a94a4';
      rr(left, top + 8 * S, w, h - 8 * S, 5 * S); ctx.fill();
      ctx.strokeStyle = 'rgba(60, 70, 84, 0.55)';
      ctx.lineWidth = 2;
      for (let i = 1; i <= 3; i++) {
        const ry = top + 8 * S + (h - 8 * S) * i / 4;
        ctx.beginPath(); ctx.moveTo(left + 3 * S, ry); ctx.lineTo(left + w - 3 * S, ry); ctx.stroke();
      }
      ctx.fillStyle = '#a8b2c2';
      rr(left - 4 * S, top, w + 8 * S, 10 * S, 4 * S); ctx.fill();
      ctx.fillStyle = '#7c8698';
      rr(x - 7 * S, top - 4 * S, 14 * S, 4 * S, 2 * S); ctx.fill();
      // wavy stink lines
      ctx.strokeStyle = 'rgba(150, 220, 130, 0.35)';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 2; i++) {
        const sx2 = x - 6 * S + i * 12 * S;
        ctx.beginPath();
        for (let j = 0; j <= 8; j++) {
          const yy = top - 8 * S - j * 5 * S;
          const xx = sx2 + Math.sin(t * 3 + j * 0.9 + i * 2) * 4 * S;
          if (j === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
      break;
    }
    case 'hydrant': {
      ctx.fillStyle = '#a83232';
      rr(x - w * 0.42, GROUND_Y - 12 * S, w * 0.84, 12 * S, 3 * S); ctx.fill();
      ctx.fillStyle = '#d94646';
      rr(x - w * 0.22, top + 10 * S, w * 0.44, h - 18 * S, 4 * S); ctx.fill();
      ctx.beginPath(); ctx.arc(x, top + 12 * S, w * 0.22, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#b73a3a';
      rr(x - 5 * S, top, 10 * S, 6 * S, 2 * S); ctx.fill();
      ctx.fillStyle = '#b73a3a';
      ctx.beginPath(); ctx.arc(x - w * 0.22, GROUND_Y - h * 0.55, 5.5 * S, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(x + w * 0.22, GROUND_Y - h * 0.55, 5.5 * S, 0, TAU); ctx.fill();
      ctx.fillStyle = '#8f2b2b';
      ctx.beginPath(); ctx.arc(x - w * 0.22, GROUND_Y - h * 0.55, 2.4 * S, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(x + w * 0.22, GROUND_Y - h * 0.55, 2.4 * S, 0, TAU); ctx.fill();
      break;
    }
    case 'crate': {
      const n = Math.max(1, Math.round(o.h / (46 * S))); // 1–3 stacked crates
      const unit = h / n;
      for (let i = n - 1; i >= 0; i--) drawCrate(left, top + i * unit, w, unit);
      break;
    }
  }
}

function drawFish(f, cam, t) {
  if (f.taken) return;
  const bob = Math.sin(t * 3.2 + f.bob) * 6 * S;
  const x = f.x - cam, y = GROUND_Y - f.y - bob;
  if (x < -60 || x > W + 60) return;
  const g = ctx.createRadialGradient(x, y, 2, x, y, 22 * S);
  g.addColorStop(0, 'rgba(140, 225, 255, 0.28)');
  g.addColorStop(1, 'rgba(140, 225, 255, 0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, 22 * S, 0, TAU); ctx.fill();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(t * 2 + f.bob) * 0.25);
  ctx.fillStyle = '#59c8e8';
  ctx.beginPath(); ctx.ellipse(0, 0, 11 * S, 7 * S, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); // tail
  ctx.moveTo(-8 * S, 0); ctx.lineTo(-16 * S, -6 * S); ctx.lineTo(-16 * S, 6 * S);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); // fin
  ctx.moveTo(0, -6 * S); ctx.lineTo(2 * S, -12 * S); ctx.lineTo(5 * S, -6 * S);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(6 * S, -1.5 * S, 2.6 * S, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1b2a3a';
  ctx.beginPath(); ctx.arc(6.8 * S, -1.5 * S, 1.3 * S, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawPigeon(p, cam, t) {
  const x = p.x - cam;
  if (x < -80 || x > W + 80) return;
  const y = GROUND_Y - p.y;
  ctx.save();
  ctx.translate(x, y);
  if (!p.fly) {
    const bob = Math.sin(t * 2 + p.seed * 9) * 1.5 * S;
    const peck = Math.sin(t * 0.7 + p.seed * 5) < -0.86;
    ctx.translate(0, bob * 0.4);
    ctx.fillStyle = '#8d97a6';
    ctx.beginPath(); // tail
    ctx.moveTo(-12 * S, -6 * S); ctx.lineTo(-20 * S, -3 * S); ctx.lineTo(-12 * S, -2 * S);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#a7b0bd';
    ctx.beginPath(); ctx.ellipse(0, -7 * S, 11 * S, 8 * S, 0, 0, TAU); ctx.fill();
    const hy = peck ? -9 * S : -16 * S;
    ctx.beginPath(); ctx.arc(8 * S, hy, 4.6 * S, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f0a24a';
    ctx.beginPath();
    ctx.moveTo(12 * S, hy - 1 * S); ctx.lineTo(17 * S, hy); ctx.lineTo(12 * S, hy + 1.5 * S);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#22262e';
    ctx.beginPath(); ctx.arc(9.4 * S, hy - 1 * S, 1.1 * S, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#c98b4a'; ctx.lineWidth = 1.8 * S;
    ctx.beginPath();
    ctx.moveTo(-2 * S, 0); ctx.lineTo(-2 * S, -1 * S);
    ctx.moveTo(3 * S, 0); ctx.lineTo(3 * S, -1 * S);
    ctx.stroke();
    ctx.fillStyle = '#8d97a6';
    ctx.beginPath(); ctx.ellipse(-2 * S, -8 * S, 7 * S, 4.6 * S, -0.2, 0, TAU); ctx.fill();
  } else {
    const flap = Math.sin(t * 26 + p.seed * 20);
    ctx.rotate(-0.25);
    ctx.fillStyle = '#a7b0bd';
    ctx.beginPath(); ctx.ellipse(0, 0, 11 * S, 6.5 * S, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(9 * S, -3 * S, 4.4 * S, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f0a24a';
    ctx.beginPath();
    ctx.moveTo(13 * S, -4 * S); ctx.lineTo(17.5 * S, -3 * S); ctx.lineTo(13 * S, -2 * S);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#22262e';
    ctx.beginPath(); ctx.arc(10.4 * S, -4 * S, 1.1 * S, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8d97a6';
    ctx.beginPath(); // flapping wing
    ctx.moveTo(-2 * S, -2 * S);
    ctx.quadraticCurveTo(-8 * S, (-14 - flap * 8) * S, 4 * S, (-16 - flap * 9) * S);
    ctx.quadraticCurveTo(6 * S, -6 * S, 4 * S, -1 * S);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); // tail
    ctx.moveTo(-9 * S, 0); ctx.lineTo(-17 * S, -2 * S); ctx.lineTo(-9 * S, -4 * S);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawParticles(cam) {
  for (const p of world.particles) {
    const a = clamp(p.life / p.max, 0, 1);
    const x = p.x - cam, y = GROUND_Y - p.y;
    if (p.type === 'puff') {
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = '#cfc4d6';
      ctx.beginPath(); ctx.arc(x, y, p.size * (1.6 - a * 0.6), 0, TAU); ctx.fill();
    } else if (p.type === 'fur') {
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot || (p.x * 0.02));
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    } else if (p.type === 'star') {
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffd45e';
      starPath(x, y, p.size, p.rot || 0);
      ctx.fill();
    } else if (p.type === 'spark') {
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#9fe8ff';
      ctx.lineWidth = 1.6 * S;
      ctx.beginPath();
      ctx.moveTo(x - p.size * 1.6, y); ctx.lineTo(x + p.size * 1.6, y);
      ctx.moveTo(x, y - p.size * 1.6); ctx.lineTo(x, y + p.size * 1.6);
      ctx.stroke();
    } else if (p.type === 'ring') {
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3 * S;
      ctx.beginPath(); ctx.arc(x, y, p.size * (1 - a), 0, TAU); ctx.stroke();
    } else if (p.type === 'confetti') {
      ctx.globalAlpha = Math.min(1, a * 2);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot || 0);
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

function drawWorldTexts(cam) {
  if (state === 'menu') return;
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 ' + Math.round(26 * S + 4) + 'px "Baloo 2", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 240, 220, 0.5)';
  ctx.textAlign = 'left';
  const a1 = 120 * S - cam;
  if (a1 > -300 && a1 < W + 100) ctx.fillText('ATTEMPT ' + save.attempts, a1, GROUND_Y - 150 * S);
  ctx.textAlign = 'center';
  const a2 = world.doorX - 1050 * S - cam;
  if (a2 > -300 && a2 < W + 300) ctx.fillText('ALMOST HOME!', a2, GROUND_Y - 130 * S);
}

function drawCat(t) {
  if (!cat.visible) return;
  const k = S;
  const px = cat.screenX;
  let py = GROUND_Y - cat.y;
  if (state === 'win') py -= Math.abs(Math.sin(t * 5)) * 26 * k; // happy hops at the door
  const playing = state === 'playing';
  const running = playing && cat.onGround;
  const air = playing && !cat.onGround;

  const FUR = '#f59f4a', FUR_D = '#d97a2b', CREAM = '#ffe4c4', PINK = '#f2a9a0', DARK = '#4a2f1d';

  ctx.save();
  ctx.translate(px, py);

  // squash & stretch
  let sx = 1, sy = 1;
  if (cat.stretchT > 0) { sx = 1 - 0.14 * cat.stretchT; sy = 1 + 0.18 * cat.stretchT; }
  if (cat.squashT > 0) { sx = 1 + 0.16 * cat.squashT; sy = 1 - 0.2 * cat.squashT; }
  ctx.scale(sx, sy);
  if (playing) ctx.rotate(clamp(-cat.vy * 0.00022, -0.2, 0.16)); // nose up on rise, dip on fall

  const leg = (jx, jy, fx, fy, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 6.5 * k; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(jx * k, jy * k); ctx.lineTo(fx * k, fy * k); ctx.stroke();
    ctx.fillStyle = CREAM;
    ctx.beginPath(); ctx.arc(fx * k, fy * k, 3.4 * k, 0, TAU); ctx.fill();
  };

  // far legs
  if (running) {
    const ph = world.dist * 0.052;
    leg(-14, -13, -14 + Math.sin(ph + Math.PI) * 10, -Math.max(0, -Math.cos(ph + Math.PI)) * 8, FUR_D);
    leg(13, -15, 13 + Math.sin(ph + 0.7 + Math.PI) * 10, -Math.max(0, -Math.cos(ph + 0.7 + Math.PI)) * 8, FUR_D);
  } else if (air) {
    leg(-14, -13, -26, -6, FUR_D);
    leg(13, -15, 22, -12, FUR_D);
  } else {
    leg(-14, -13, -17, 0, FUR_D);
    leg(13, -15, 15, 0, FUR_D);
  }

  // tail
  ctx.strokeStyle = FUR; ctx.lineWidth = 6.5 * k; ctx.lineCap = 'round';
  const swish = state === 'menu' ? 12 : 5;
  const tw = Math.sin(t * 2.6) * swish;
  ctx.beginPath();
  let tipX, tipY;
  if (air) { ctx.moveTo(-19 * k, -18 * k); ctx.quadraticCurveTo(-32 * k, -34 * k, -27 * k, -48 * k); tipX = -27; tipY = -48; }
  else { ctx.moveTo(-19 * k, -16 * k); ctx.quadraticCurveTo(-32 * k, -10 * k - tw * 0.4 * k, -37 * k, -22 * k - tw * k); tipX = -37; tipY = -22 - tw; }
  ctx.stroke();
  ctx.fillStyle = CREAM;
  ctx.beginPath(); ctx.arc(tipX * k, tipY * k, 3.4 * k, 0, TAU); ctx.fill();

  // body
  ctx.fillStyle = FUR;
  ctx.beginPath(); ctx.ellipse(0, -22 * k, 24 * k, 13.5 * k, 0, 0, TAU); ctx.fill();
  // back stripes
  ctx.fillStyle = FUR_D;
  for (const bx of [-12, -3, 6]) {
    ctx.beginPath();
    ctx.moveTo((bx - 3.5) * k, -35 * k);
    ctx.lineTo((bx + 2.5) * k, -35 * k);
    ctx.lineTo((bx - 0.5) * k, -27 * k);
    ctx.closePath(); ctx.fill();
  }
  // belly
  ctx.fillStyle = CREAM;
  ctx.beginPath(); ctx.ellipse(3 * k, -15 * k, 13 * k, 6 * k, 0, 0, TAU); ctx.fill();

  // near legs
  if (running) {
    const ph = world.dist * 0.052;
    leg(-14, -13, -14 + Math.sin(ph) * 10, -Math.max(0, -Math.cos(ph)) * 8, FUR);
    leg(13, -15, 13 + Math.sin(ph + 0.7) * 10, -Math.max(0, -Math.cos(ph + 0.7)) * 8, FUR);
  } else if (air) {
    leg(-14, -13, -30, -12, FUR);
    leg(13, -15, 27, -20, FUR);
  } else {
    leg(-14, -13, -13, 0, FUR);
    leg(13, -15, 17, 0, FUR);
  }

  // head
  const hx = 24, hy = -36;
  const ear = (x1, y1, x2, y2, x3, y3) => {
    ctx.fillStyle = FUR;
    ctx.beginPath();
    ctx.moveTo(x1 * k, y1 * k); ctx.lineTo(x2 * k, y2 * k); ctx.lineTo(x3 * k, y3 * k);
    ctx.closePath(); ctx.fill();
    const cxm = (x1 + x2 + x3) / 3, cym = (y1 + y2 + y3) / 3;
    ctx.fillStyle = PINK;
    ctx.beginPath();
    ctx.moveTo(lerp(x1, cxm, 0.4) * k, lerp(y1, cym, 0.4) * k);
    ctx.lineTo(lerp(x2, cxm, 0.4) * k, lerp(y2, cym, 0.4) * k);
    ctx.lineTo(lerp(x3, cxm, 0.4) * k, lerp(y3, cym, 0.4) * k);
    ctx.closePath(); ctx.fill();
  };
  ear(hx - 12, hy - 2, hx - 7, hy - 15, hx - 1, hy - 4);
  ear(hx + 2, hy - 4, hx + 7, hy - 13, hx + 11, hy - 1);
  ctx.fillStyle = FUR;
  ctx.beginPath(); ctx.arc(hx * k, hy * k, 11.5 * k, 0, TAU); ctx.fill();
  // forehead stripes
  ctx.fillStyle = FUR_D;
  ctx.beginPath();
  ctx.moveTo((hx + 1) * k, (hy - 11) * k); ctx.lineTo((hx + 4) * k, (hy - 11) * k); ctx.lineTo((hx + 2.5) * k, (hy - 6) * k);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo((hx + 6) * k, (hy - 10.5) * k); ctx.lineTo((hx + 8.5) * k, (hy - 10) * k); ctx.lineTo((hx + 7) * k, (hy - 5.5) * k);
  ctx.closePath(); ctx.fill();
  // muzzle
  ctx.fillStyle = CREAM;
  ctx.beginPath(); ctx.ellipse((hx + 6) * k, (hy + 4.5) * k, 6.5 * k, 4.5 * k, 0, 0, TAU); ctx.fill();
  // eye (with blink)
  const blink = (t % 3.4) > 3.25;
  if (blink) {
    ctx.strokeStyle = DARK; ctx.lineWidth = 1.8 * k; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo((hx + 2.5) * k, (hy - 1) * k); ctx.lineTo((hx + 6.5) * k, (hy - 1) * k); ctx.stroke();
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc((hx + 4.5) * k, (hy - 1) * k, 3.1 * k, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2b1c10';
    ctx.beginPath(); ctx.arc((hx + 5.3) * k, (hy - 1) * k, 1.7 * k, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc((hx + 4.7) * k, (hy - 2) * k, 0.7 * k, 0, TAU); ctx.fill();
  }
  // nose
  ctx.fillStyle = PINK;
  ctx.beginPath();
  ctx.moveTo((hx + 9.5) * k, (hy + 2.5) * k);
  ctx.lineTo((hx + 12.5) * k, (hy + 2.5) * k);
  ctx.lineTo((hx + 11) * k, (hy + 4.5) * k);
  ctx.closePath(); ctx.fill();
  // whiskers
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 1 * k;
  ctx.beginPath();
  ctx.moveTo((hx + 8) * k, (hy + 4) * k); ctx.lineTo((hx + 16) * k, (hy + 2) * k);
  ctx.moveTo((hx + 8) * k, (hy + 5) * k); ctx.lineTo((hx + 16.5) * k, (hy + 5.5) * k);
  ctx.moveTo((hx + 8) * k, (hy + 6) * k); ctx.lineTo((hx + 15.5) * k, (hy + 8.5) * k);
  ctx.stroke();
  // collar + bell
  ctx.strokeStyle = '#e0484f'; ctx.lineWidth = 3.5 * k;
  ctx.beginPath(); ctx.arc((hx - 5) * k, (hy + 8.5) * k, 7 * k, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = '#ffd45e';
  ctx.beginPath(); ctx.arc((hx - 5) * k, (hy + 15.5) * k, 3.1 * k, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#b98a1e'; ctx.lineWidth = 1 * k;
  ctx.beginPath(); ctx.moveTo((hx - 5) * k, (hy + 14.2) * k); ctx.lineTo((hx - 5) * k, (hy + 16.2) * k); ctx.stroke();

  ctx.restore();
}

function draw(t) {
  drawSky(t);
  const cam = world.camX;
  let shx = 0, shy = 0;
  if (world.shakeT > 0) {
    const m = world.shakeT * 30;
    shx = rand(-m, m);
    shy = rand(-m, m);
  }
  ctx.save();
  ctx.translate(shx, shy);
  drawBuildings(cam, t);
  drawGround(cam);
  drawLamps(cam, t);
  drawDoor(cam);
  for (const o of world.obstacles) drawObstacle(o, cam, t);
  for (const f of world.fish) drawFish(f, cam, t);
  for (const p of world.pigeons) drawPigeon(p, cam, t);
  drawParticles(cam);
  drawWorldTexts(cam);
  drawCat(t);
  ctx.restore();
}

/* ---------------- input ---------------- */
const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];

function pressStart() {
  if (state === 'menu') startGame();
  else if (state === 'playing') { cat.holdJump = true; cat.buffer = 0.14; }
  else if (state === 'paused') resumeGame();
  else if (state === 'dead' && world.deathT > 0.5) startGame();
  else if (state === 'win' && world.winT > 0.8) nextLevelAndStart();
}

function toggleMute() {
  const m = sfx.toggle();
  ui.mute.textContent = m ? '🔇' : '🔊';
}

window.addEventListener('keydown', e => {
  if (JUMP_KEYS.includes(e.code)) {
    e.preventDefault();
    if (e.repeat) return;
    sfx.unlock();
    pressStart();
  } else if (e.code === 'KeyM') {
    toggleMute();
  } else if (e.code === 'KeyR') {
    if (state === 'playing' || state === 'dead') startGame();
  } else if (e.code === 'Escape' || e.code === 'KeyP') {
    if (state === 'playing') pauseGame();
    else if (state === 'paused') resumeGame();
  }
});
window.addEventListener('keyup', e => {
  if (JUMP_KEYS.includes(e.code)) cat.holdJump = false;
});

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  sfx.unlock();
  pressStart();
});
window.addEventListener('pointerup', () => { cat.holdJump = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

$('startBtn').addEventListener('pointerdown', e => { e.stopPropagation(); sfx.unlock(); if (state === 'menu') startGame(); });
$('retryBtn').addEventListener('pointerdown', e => { e.stopPropagation(); if (state === 'dead' && world.deathT > 0.5) startGame(); });
$('againBtn').addEventListener('pointerdown', e => { e.stopPropagation(); if (state === 'win' && world.winT > 0.8) nextLevelAndStart(); });
ui.death.addEventListener('pointerdown', () => { if (state === 'dead' && world.deathT > 0.5) startGame(); });
ui.win.addEventListener('pointerdown', () => { if (state === 'win' && world.winT > 0.8) nextLevelAndStart(); });
ui.pause.addEventListener('pointerdown', resumeGame);
ui.mute.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); toggleMute(); });

document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
window.addEventListener('blur', () => pauseGame());

/* ---------------- main loop ---------------- */
let lastT = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const t = ts / 1000;
  if (!lastT) { lastT = t; return; }
  const dt = clamp(t - lastT, 0, 0.033);
  lastT = t;
  update(dt);
  draw(t);
}

function init() {
  resize();
  resetWorld();
  refreshTitleStats();
  ui.mute.textContent = sfx.muted ? '🔇' : '🔊';
  requestAnimationFrame(loop);
}
init();
