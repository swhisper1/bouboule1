'use strict';

/* ==========================================================================
   BOULES SATISFAISANTES : moteur physique 2D maison (Canvas 2D, sans librairie)

   Principe : une boule rebondit dans un cercle percé d'une ouverture en bas.
   Quand une boule sort complètement par l'ouverture, elle disparaît et
   deux nouvelles boules apparaissent : 1 -> 2 -> 4 -> 8 -> ...

   Tout est piloté par la physique : gravité, réflexion selon la normale,
   restitution réglable, correction de position, pas de temps fixe.

   Modifie les valeurs de CFG juste en dessous pour changer le comportement.
   ========================================================================== */


/* ==========================================================================
   1. RÉGLAGES (tout ce que tu peux modifier facilement)
   ========================================================================== */
const CFG = {
  // --- Monde logique : on raisonne toujours en 1080 x 1920 ---
  W: 1080,
  H: 1920,

  // --- Cercle ---
  ringX: 540,            // centre du cercle (x)
  ringY: 780,            // centre du cercle (y)
  ringRadius: 430,       // rayon (ligne centrale du trait)
  ringThickness: 10,     // épaisseur du trait
  gapWidth: 110,         // distance entre les deux extrémités de l'ouverture (plus grand = plus facile)
  ringSpeed: 0.9,        // rotation du cercle en rad/s (positif = sens horaire, 0 = immobile, négatif = inverse)

  // --- Boules ---
  ballRadius: 16,
  maxBalls: 250,         // limite pour ne pas saturer le navigateur

  // --- Physique ---
  gravity: 1800,         // px/s²  (réglable avec le curseur)
  restitutionWall: 0.92, // 1 = rebond parfait, 0 = pas de rebond
  restitutionBall: 0.9,  // élasticité des chocs entre boules
  wallFriction: 0.01,    // frottement tangentiel très faible lors d'un rebond
  airDrag: 0.02,         // frottement de l'air (très faible)
  maxSpeed: 2600,        // vitesse maximale (évite de traverser les parois)
  collisionsBetweenBalls: true,
  physicsStep: 1 / 240,  // pas de temps fixe : la physique ne dépend pas des FPS
  maxStepsPerFrame: 20,  // protection si l'appareil est trop lent

  // --- Apparition des nouvelles boules ---
  // 'top'  : les deux boules réapparaissent dans la partie haute du cercle
  // 'exit' : elles réapparaissent juste au-dessus de l'ouverture, projetées vers le haut
  spawnMode: 'top',

  // --- Simulation ---
  speed: 1,              // vitesse de simulation (curseur)

  // --- Sons ---
  volume: 0.6,
  minImpactSpeedForSound: 60, // sous cette vitesse d'impact, pas de son (évite seulement le crépitement des contacts posés)

  // --- Effets visuels ---
  trails: true,
  particles: true,
  maxParticles: 300,
  glowBelowBalls: 150,   // au-delà de ce nombre de boules, on coupe la lueur
};


/* ==========================================================================
   2. CONSTANTES DÉRIVÉES ET OUTILS
   ========================================================================== */
const TAU = Math.PI * 2;
const CX = CFG.ringX;
const CY = CFG.ringY;
const R = CFG.ringRadius;                  // rayon de la ligne centrale du trait
const T = CFG.ringThickness;
const R_IN = R - T / 2;                    // rayon intérieur : la surface réellement touchée
const CAP_R = T / 2;                       // rayon des extrémités arrondies de l'ouverture
const BR = CFG.ballRadius;
const HALF_GAP = Math.asin(CFG.gapWidth / 2 / R); // demi-angle de l'ouverture
const COS_HALF_GAP = Math.cos(HALF_GAP);
const DOWN = Math.PI / 2;                  // au départ, l'ouverture est centrée vers le bas (y positif)

// Le cercle tourne en continu : on garde son angle et la direction de l'ouverture à jour
let ringAngle = 0;                         // rotation actuelle du cercle (radians)
let gapDirX = 0;                           // direction du centre de l'ouverture (vecteur unitaire)
let gapDirY = 1;
const CAPS = [{ x: 0, y: 0 }, { x: 0, y: 0 }];   // extrémités de la paroi autour de l'ouverture

// Recalcule la position de l'ouverture et de ses deux extrémités selon l'angle du cercle
function updateRingGeometry() {
  const a = DOWN + ringAngle;
  gapDirX = Math.cos(a);
  gapDirY = Math.sin(a);
  CAPS[0].x = CX + R * Math.cos(a + HALF_GAP);
  CAPS[0].y = CY + R * Math.sin(a + HALF_GAP);
  CAPS[1].x = CX + R * Math.cos(a - HALF_GAP);
  CAPS[1].y = CY + R * Math.sin(a - HALF_GAP);
}
updateRingGeometry();

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));


/* ==========================================================================
   3. SONS
   - Web Audio (précis, volume réglable, même sur iPhone) quand le projet est
     servi par http(s) (Live Server, GitHub Pages...).
   - Sinon (ouverture directe du fichier index.html), repli sur des balises
     <audio> en rotation.
   - Anti-spam : délai minimum entre deux sons + nombre de voix limité.
   ========================================================================== */
const sound = {
  mode: 'none',          // 'webaudio' | 'html' | 'none'
  ctx: null,
  master: null,
  buffers: {},
  pools: {},
  poolIdx: {},
  active: { son1: [], son2: [] },   // sons en cours de lecture (pour remplacer le plus ancien)
  last: { son1: 0, son2: 0 },
  volume: CFG.volume,
  ready: false,
  defs: {
    son1: { src: 'son1.mp3', minGapMs: 12, maxVoices: 24, poolSize: 16 }, // collisions
    son2: { src: 'son2.mp3', minGapMs: 40, maxVoices: 8, poolSize: 6 },   // multiplication
  },

  // À appeler depuis un clic (exigé par les navigateurs pour activer l'audio)
  async init() {
    if (this.ready) return;
    this.ready = true;

    const AC = window.AudioContext || window.webkitAudioContext;
    const viaFile = location.protocol === 'file:';

    // 1) Web Audio : le contexte est créé dans le geste de l'utilisateur
    if (AC && !viaFile) {
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        // Compresseur : évite la saturation quand beaucoup de sons se jouent en même temps
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        this.master.connect(comp).connect(this.ctx.destination);
        this.ctx.resume();
        for (const name of Object.keys(this.defs)) {
          const res = await fetch(this.defs[name].src);
          if (!res.ok) throw new Error('fichier introuvable : ' + this.defs[name].src);
          const data = await res.arrayBuffer();
          this.buffers[name] = await new Promise((ok, ko) => this.ctx.decodeAudioData(data, ok, ko));
        }
        this.mode = 'webaudio';
        return;
      } catch (e) {
        console.warn('Web Audio indisponible, repli sur <audio> :', e);
      }
    }

    // 2) Repli : réserves de balises <audio>
    for (const name of Object.keys(this.defs)) {
      const d = this.defs[name];
      this.pools[name] = [];
      this.poolIdx[name] = 0;
      for (let i = 0; i < d.poolSize; i++) {
        const a = new Audio(d.src);
        a.preload = 'auto';
        // "Déverrouillage" iOS/Safari : un play() muet dans le geste utilisateur
        a.muted = true;
        a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; })
                .catch(() => { a.muted = false; });
        this.pools[name].push(a);
      }
    }
    this.mode = 'html';
  },

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  },

  // name : 'son1' | 'son2' ; vol : 0..1 (selon l'intensité) ; rate : hauteur légèrement variable
  play(name, vol = 1, rate = 1) {
    if (this.mode === 'none' || this.volume <= 0) return;
    const d = this.defs[name];
    const now = performance.now();
    if (now - this.last[name] < d.minGapMs) return;   // pas de son en rafale

    if (this.mode === 'webaudio') {
      if (!this.buffers[name]) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();   // le navigateur a pu mettre l'audio en veille
      const list = this.active[name];
      // Trop de sons en même temps : on coupe le plus ancien au lieu d'ignorer le nouveau
      if (list.length >= d.maxVoices) {
        const old = list.shift();
        try { old.stop(); } catch (e) { /* déjà terminé */ }
      }
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      src.buffer = this.buffers[name];
      src.playbackRate.value = rate;
      g.gain.value = vol / (1 + list.length * 0.05);          // un peu moins fort quand ça sature
      src.connect(g).connect(this.master);
      list.push(src);
      src.onended = () => {
        const i = list.indexOf(src);
        if (i !== -1) list.splice(i, 1);
      };
      src.start();
    } else {
      const pool = this.pools[name];
      const a = pool[this.poolIdx[name]];
      this.poolIdx[name] = (this.poolIdx[name] + 1) % pool.length;
      try {
        a.currentTime = 0;
        a.volume = clamp(vol * this.volume, 0, 1);
        a.play().catch(() => {});
      } catch (e) { /* ignoré */ }
    }
    this.last[name] = now;
  },
};


/* ==========================================================================
   4. ÉTAT DE LA SIMULATION
   ========================================================================== */
let balls = [];
let particles = [];
let waves = [];            // ondes de choc à la sortie de l'ouverture
let running = false;
let started = false;
let acc = 0;               // accumulateur du pas de temps fixe
let lastTs = 0;
let lastCount = -1;

function makeBall(x, y, vx, vy, gen) {
  const hue = (200 + gen * 47) % 360;       // la couleur change à chaque génération
  return {
    x, y, vx, vy, gen,
    color: `hsl(${hue},85%,62%)`,
    age: 0,                                  // sert à l'animation d'apparition
    dead: false,
  };
}

function resetSimulation() {
  balls = [];
  particles = [];
  waves = [];
  acc = 0;
  // Première boule : en haut du cercle, avec une petite vitesse aléatoire
  balls.push(makeBall(CX + rnd(-140, 140), CY - R * 0.55, rnd(-250, 250), rnd(-100, 100), 0));
}


/* ==========================================================================
   5. MOTEUR PHYSIQUE
   ========================================================================== */

// ----- Grille spatiale pour les collisions boule/boule (évite le O(n²)) -----
const CELL = BR * 2;
const GX0 = CX - R - 3 * CELL;
const GY0 = CY - R - 3 * CELL;
const COLS = Math.ceil((2 * R + 6 * CELL) / CELL);
const ROWS = COLS;
const gridHead = new Int32Array(COLS * ROWS);
const gridNext = new Int32Array(CFG.maxBalls + 16);

function cellOf(v, origin) {
  return clamp(Math.floor((v - origin) / CELL), 0, COLS - 1);
}

function collideBalls() {
  const n = balls.length;
  if (n < 2) return;

  gridHead.fill(-1);
  for (let i = 0; i < n; i++) {
    const c = cellOf(balls[i].y, GY0) * COLS + cellOf(balls[i].x, GX0);
    gridNext[i] = gridHead[c];
    gridHead[c] = i;
  }

  const rr = BR * 2;
  for (let i = 0; i < n; i++) {
    const a = balls[i];
    const cx = cellOf(a.x, GX0);
    const cy = cellOf(a.y, GY0);
    for (let oy = -1; oy <= 1; oy++) {
      const yy = cy + oy;
      if (yy < 0 || yy >= ROWS) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = cx + ox;
        if (xx < 0 || xx >= COLS) continue;
        for (let j = gridHead[yy * COLS + xx]; j !== -1; j = gridNext[j]) {
          if (j <= i) continue;                 // chaque paire n'est traitée qu'une fois
          const b = balls[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-6) { dx = rnd(-1, 1); dy = rnd(-1, 1); d = Math.hypot(dx, dy) || 1; }
          const nx = dx / d;
          const ny = dy / d;

          // Correction de position : on sépare les deux boules à parts égales
          const push = (rr - d) / 2;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;

          // Choc entre masses égales : on échange la composante normale
          // (conservation de la quantité de mouvement, restitution réglable)
          const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rvn < 0) {
            const imp = (-(1 + CFG.restitutionBall) * rvn) / 2;
            a.vx -= imp * nx; a.vy -= imp * ny;
            b.vx += imp * nx; b.vy += imp * ny;
          }
        }
      }
    }
  }
}

// Rebond sur une extrémité arrondie de la paroi (bords de l'ouverture)
// Vitesse d'un point de la paroi (le cercle tourne autour de son centre)
function wallVelX(py) { return -CFG.ringSpeed * (py - CY); }
function wallVelY(px) { return CFG.ringSpeed * (px - CX); }

function collideCap(b, cap) {
  const dx = b.x - cap.x;
  const dy = b.y - cap.y;
  const minD = BR + CAP_R;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD) return;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = dx / d;
  const ny = dy / d;
  b.x = cap.x + nx * minD;                // on replace la boule au contact exact
  b.y = cap.y + ny * minD;
  // On raisonne dans le repère de la paroi (qui bouge) : vitesse relative
  const wvx = wallVelX(cap.y);
  const wvy = wallVelY(cap.x);
  const vn = (b.vx - wvx) * nx + (b.vy - wvy) * ny;
  if (vn < 0) {
    const e = -vn < 30 ? 0 : CFG.restitutionWall; // contact "posé" : pas de micro-rebonds
    b.vx -= (1 + e) * vn * nx;
    b.vy -= (1 + e) * vn * ny;
    onImpact(b, -vn, cap.x + nx * CAP_R, cap.y + ny * CAP_R);
  }
}

// Rebond sur la paroi intérieure du cercle (sauf dans l'ouverture)
function collideRing(b) {
  const dx = b.x - CX;
  const dy = b.y - CY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-6 || d >= R) return;                  // centre de la boule hors du cercle : rien à faire
  if ((dx * gapDirX + dy * gapDirY) / d > COS_HALF_GAP) return; // dans l'axe de l'ouverture : la boule passe
  if (d + BR <= R_IN) return;                      // pas de contact

  const nx = dx / d;                                // normale (dirigée vers l'extérieur)
  const ny = dy / d;
  b.x = CX + nx * (R_IN - BR);                      // correction de position : jamais dans la paroi
  b.y = CY + ny * (R_IN - BR);

  // Vitesse relative par rapport à la paroi qui tourne
  const px = CX + nx * R_IN;
  const py = CY + ny * R_IN;
  const wvx = wallVelX(py);
  const wvy = wallVelY(px);
  const vn = (b.vx - wvx) * nx + (b.vy - wvy) * ny;
  if (vn > 0) {
    const e = vn < 30 ? 0 : CFG.restitutionWall;    // contact posé : on évite les vibrations
    // Réflexion de la vitesse relative selon la normale de collision
    b.vx -= (1 + e) * vn * nx;
    b.vy -= (1 + e) * vn * ny;
    // Très léger frottement tangentiel (par rapport à la paroi)
    const tx = -ny, ty = nx;
    const vt = (b.vx - wvx) * tx + (b.vy - wvy) * ty;
    b.vx -= vt * CFG.wallFriction * tx;
    b.vy -= vt * CFG.wallFriction * ty;
    onImpact(b, vn, px, py);
  }
}

// Appelé à chaque vrai choc avec la paroi (une seule fois par collision)
function onImpact(b, speed, px, py) {
  if (speed >= CFG.minImpactSpeedForSound) {
    sound.play('son1', clamp(speed / 1200, 0.2, 1), rnd(0.95, 1.05));
  }
  if (CFG.particles && speed > 350) {
    const chance = balls.length > 100 ? 0.3 : 1;
    if (Math.random() < chance) addParticles(px, py, b.color, 3, 160);
  }
}

// Création des deux nouvelles boules après une sortie
function spawnChildren(exitX, gen) {
  const free = CFG.maxBalls - balls.length;
  const n = Math.min(2, free);
  for (let i = 0; i < n; i++) {
    const side = i === 0 ? -1 : 1;            // une part à gauche, l'autre à droite
    let x, y, vx, vy;
    if (CFG.spawnMode === 'exit') {
      // juste à l'intérieur de l'ouverture, projetées vers le centre du cercle
      const px = -gapDirY, py = gapDirX;      // direction perpendiculaire à l'ouverture
      const depth = R_IN - BR * 3;
      const kick = rnd(900, 1600);
      x = CX + gapDirX * depth + px * side * BR * 1.6;
      y = CY + gapDirY * depth + py * side * BR * 1.6;
      vx = -gapDirX * kick + px * side * rnd(150, 500);
      vy = -gapDirY * kick + py * side * rnd(150, 500);
    } else {
      x = CX + side * rnd(R * 0.1, R * 0.35);
      y = CY - R * 0.5 + rnd(-40, 40);
      vx = side * rnd(120, 400);
      vy = rnd(-200, 200);
    }
    balls.push(makeBall(x, y, vx, vy, gen + 1));
  }
}

// Un pas de physique à durée fixe
function step(dt) {
  // 0) Le cercle tourne : on met à jour l'ouverture avant tout calcul
  ringAngle = (ringAngle + CFG.ringSpeed * dt) % TAU;
  updateRingGeometry();

  const g = CFG.gravity;
  const drag = 1 - CFG.airDrag * dt;
  const vmax = CFG.maxSpeed;

  // 1) Intégration : gravité, frottement, déplacement
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    b.age += dt;
    b.vy += g * dt;
    b.vx *= drag;
    b.vy *= drag;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 > vmax * vmax) {
      const k = vmax / Math.sqrt(v2);
      b.vx *= k; b.vy *= k;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  // 2) Collisions entre boules
  if (CFG.collisionsBetweenBalls) collideBalls();

  // 3) Collisions avec la paroi, puis détection de la sortie
  let exits = null;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    const dx = b.x - CX;
    const dy = b.y - CY;
    const d = Math.sqrt(dx * dx + dy * dy);

    // La boule a quitté le cercle ENTIÈREMENT : elle se multiplie (une seule fois)
    if (!b.dead && d - BR > R + CAP_R && dx * gapDirX + dy * gapDirY > 0) {
      b.dead = true;
      (exits || (exits = [])).push(b);
      continue;
    }
    collideCap(b, CAPS[0]);
    collideCap(b, CAPS[1]);
    collideRing(b);
  }

  // 4) Traitement des sorties
  if (exits) {
    balls = balls.filter((b) => !b.dead);
    for (const b of exits) {
      sound.play('son2', 1, rnd(0.97, 1.03));
      const ex = CX + gapDirX * (R + CAP_R);     // point de sortie sur le cercle
      const ey = CY + gapDirY * (R + CAP_R);
      waves.push({ x: ex, y: ey, t: 0, color: b.color });
      if (waves.length > 20) waves.shift();
      if (CFG.particles) addParticles(ex, ey, b.color, 14, 320);
      spawnChildren(b.x, b.gen);
    }
  }
}


/* ==========================================================================
   6. PARTICULES ET ONDES (visuel uniquement, aucun effet sur la physique)
   ========================================================================== */
function addParticles(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    if (particles.length >= CFG.maxParticles) return;
    const a = rnd(0, TAU);
    const s = rnd(0.3, 1) * speed;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: rnd(0.3, 0.6), color });
  }
}

function updateEffects(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.max) {
      particles[i] = particles[particles.length - 1];
      particles.pop();
      continue;
    }
    p.vy += 500 * dt;
    p.vx *= 1 - 2 * dt;
    p.vy *= 1 - 2 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  for (let i = waves.length - 1; i >= 0; i--) {
    waves[i].t += dt;
    if (waves[i].t > 0.5) waves.splice(i, 1);
  }
}


/* ==========================================================================
   7. RENDU
   ========================================================================== */
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
let scale = 1;
let ringCache = null;

// Le cercle ne change jamais : on le dessine une fois dans un canvas caché
function buildRingCache() {
  ringCache = document.createElement('canvas');
  ringCache.width = canvas.width;
  ringCache.height = canvas.height;
  const c = ringCache.getContext('2d');
  c.setTransform(scale, 0, 0, scale, 0, 0);
  c.lineCap = 'round';

  const a0 = DOWN + HALF_GAP;
  const a1 = DOWN - HALF_GAP + TAU;

  // Halo lumineux
  c.save();
  c.shadowColor = 'rgba(122,162,255,0.85)';
  c.shadowBlur = 28 * scale;
  c.strokeStyle = 'rgba(122,162,255,0.55)';
  c.lineWidth = T;
  c.beginPath();
  c.arc(CX, CY, R, a0, a1, false);
  c.stroke();
  c.restore();

  // Trait net
  c.strokeStyle = '#dfe7ff';
  c.lineWidth = T;
  c.beginPath();
  c.arc(CX, CY, R, a0, a1, false);
  c.stroke();
}

// Adapte la scène au format 9:16 et à la netteté de l'écran
function resize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.floor(Math.min(vw, (vh * 9) / 16));
  const h = Math.floor((w * 16) / 9);
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  stage.style.fontSize = w / 27 + 'px';          // les commandes suivent la taille de la scène

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  scale = canvas.width / CFG.W;
  buildRingCache();
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Le cercle (pré-dessiné) est simplement tourné autour de son centre
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(CX, CY);
  ctx.rotate(ringAngle);
  ctx.drawImage(ringCache, -CX, -CY, CFG.W, CFG.H);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // Ondes de choc à la sortie
  ctx.lineWidth = 4;
  for (const w of waves) {
    const k = w.t / 0.5;
    ctx.globalAlpha = (1 - k) * 0.6;
    ctx.strokeStyle = w.color;
    ctx.beginPath();
    ctx.arc(w.x, w.y, 18 + k * 90, 0, TAU);
    ctx.stroke();
  }

  // Traînées discrètes
  if (CFG.trails) {
    ctx.lineCap = 'round';
    ctx.lineWidth = BR * 1.5;
    ctx.globalAlpha = 0.25;
    for (const b of balls) {
      if (b.vx * b.vx + b.vy * b.vy < 40000) continue;
      ctx.strokeStyle = b.color;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.025, b.y - b.vy * 0.025);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // Boules (lueur seulement si peu nombreuses)
  const glow = balls.length < CFG.glowBelowBalls;
  for (const b of balls) {
    const s = Math.min(1, b.age / 0.12);          // petite animation d'apparition
    const r = BR * (0.4 + 0.6 * s);
    if (glow) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 1.9, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, TAU);
    ctx.fill();
  }

  // Particules
  for (const p of particles) {
    const k = 1 - p.life / p.max;
    ctx.globalAlpha = k;
    ctx.fillStyle = p.color;
    const sz = 2 + 4 * k;
    ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;
}


/* ==========================================================================
   8. BOUCLE PRINCIPALE
   Pas de temps fixe + accumulateur : le résultat est le même à 30, 60
   ou 144 images par seconde.
   ========================================================================== */
const countEl = document.getElementById('count');
const countLabelEl = document.getElementById('count-label');

function updateHud() {
  const n = balls.length;
  if (n === lastCount) return;
  lastCount = n;
  countEl.textContent = n;
  countLabelEl.textContent = n > 1 ? 'boules' : 'boule';
}

function frame(ts) {
  requestAnimationFrame(frame);
  const frameDt = Math.min((ts - lastTs) / 1000 || 0, 0.1);
  lastTs = ts;

  if (running) {
    acc = Math.min(acc + frameDt * CFG.speed, 0.1);
    let steps = 0;
    while (acc >= CFG.physicsStep && steps < CFG.maxStepsPerFrame) {
      step(CFG.physicsStep);
      acc -= CFG.physicsStep;
      steps++;
    }
    if (steps === CFG.maxStepsPerFrame) acc = 0;   // appareil dépassé : on abandonne le retard
    updateEffects(frameDt * CFG.speed);
  }

  render();
  updateHud();
}


/* ==========================================================================
   9. INTERFACE
   ========================================================================== */
const $ = (id) => document.getElementById(id);
const hint = $('hint');

async function start() {
  await sound.init();           // active l'audio (geste utilisateur)
  running = true;
  started = true;
  hint.classList.add('hidden');
}

$('btn-start').addEventListener('click', start);
$('btn-pause').addEventListener('click', () => { running = false; });
$('btn-reset').addEventListener('click', async () => {
  resetSimulation();
  await start();
});

$('btn-toggle').addEventListener('click', () => {
  const panel = $('sliders');
  const hidden = panel.classList.toggle('collapsed');
  $('btn-toggle').setAttribute('aria-expanded', String(!hidden));
});

$('gravity').addEventListener('input', (e) => {
  CFG.gravity = Number(e.target.value);
  $('gravity-out').textContent = CFG.gravity;
});
$('speed').addEventListener('input', (e) => {
  CFG.speed = Number(e.target.value);
  $('speed-out').textContent = CFG.speed.toFixed(2) + '×';
});
$('volume').addEventListener('input', (e) => {
  CFG.volume = Number(e.target.value);
  sound.setVolume(CFG.volume);
  $('volume-out').textContent = Math.round(CFG.volume * 100) + '%';
});

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// Démarrage de la page
resize();
resetSimulation();
requestAnimationFrame(frame);
