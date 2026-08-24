import type { GameObj, KAPLAYCtx } from "kaplay";
import { TILE } from "./levelgen";

/**
 * Inimigos do modo singleplayer local (offline).
 *
 * O núcleo puro (createEnemy/stepEnemy/enemyTypePool/pickEnemyType) é espelho
 * fiel do EnemySystem do servidor (apps/api/internal/game/enemies.go, commit
 * 80ba374): as mesmas 3 IAs determinísticas, mesmas constantes e mesmas regras
 * de spawn por fase. Quando o multiplayer voltar, basta trocar o consumidor —
 * a simulação continua idêntica.
 *
 * A camada kaplay (spawnEnemy) é um wrapper fino: cria o objeto visual,
 * avança o núcleo puro a cada frame e aplica a posição. Toda a lógica de
 * movimento/combate vive no núcleo puro (testável sem kaplay).
 */

// ===== Tipos =====

export type EnemyType = "andador" | "voador" | "atirador";

/** Contrato de mundo para o núcleo puro: limites em pixels + sonda de tile. */
export interface EnemyWorld {
  width: number; // px
  height: number; // px
  /** true quando o tile (coluna, fileira) é sólido — y cresce para baixo. */
  solid(tx: number, ty: number): boolean;
}

/** Jogador visto pela IA (alvo do atirador): posição/hitbox em px + HP. */
export interface EnemyPlayer {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
}

/** Estado interno de um inimigo simulado (posição em px, top-left). */
export interface EnemySim {
  id: string;
  type: EnemyType;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  hp: number;
  phase: number;
  dir: number; // 1 = direita, -1 = esquerda
  t: number; // relógio local (fase do seno do voador)
  baseY: number; // âncora vertical do voador (oscila em torno dela)
  shootIn: number; // ticks restantes até o próximo tiro do atirador
  grounded: boolean;
}

/** Disparo do atirador: origem (centro do atirador) e alvo (centro do jogador). */
export interface EnemyShot {
  enemyId: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  speed: number;
  lifetime: number;
}

// ===== Constantes (espelho do servidor) =====

/** Fases em que cada tipo fica disponível (gates de fase). */
export const ENEMY_ANDADOR_PHASE = 1;
export const ENEMY_VOADOR_PHASE = 3;
export const ENEMY_ATIRADOR_PHASE = 5;

/** Dimensões das hitboxes em pixels (mesmas do servidor). */
export const ENEMY_SIZE: Record<EnemyType, { w: number; h: number }> = {
  andador: { w: 30, h: 30 },
  voador: { w: 34, h: 28 },
  atirador: { w: 30, h: 36 },
};

/** Vida de cada tipo (o tiro do player causa 25: andador morre em 1, voador e atirador em 2). */
export const ENEMY_HP: Record<EnemyType, number> = {
  andador: 25,
  voador: 50,
  atirador: 50,
};

export const ENEMY_ANDADOR_SPEED = 60; // px/s — patrulha do andador
export const ENEMY_VOADOR_SPEED = 45; // px/s — deriva horizontal do voador
export const ENEMY_VOADOR_AMPLITUDE = 14; // px — amplitude do seno vertical
export const ENEMY_VOADOR_FREQUENCY = 1.5; // ciclos/s — frequência do seno
export const ENEMY_GRAVITY = 980; // px/s² — gravidade do andador (mesma do player)
export const ENEMY_MAX_FALL_SPEED = 900; // px/s — teto de queda do andador

export const ENEMY_ATIRADOR_SHOT_SPEED = 260; // px/s
export const ENEMY_ATIRADOR_SHOT_LIFETIME = 4; // s
export const ENEMY_ATIRADOR_COOLDOWN_TICKS = 40; // ticks entre disparos (2 s @ 20 tps)

export const ENEMY_CONTACT_DAMAGE = 10; // dano de contato com o jogador
export const ENEMY_MIN_COIN_DROP = 1; // faixa de moedas dropadas na destruição
export const ENEMY_MAX_COIN_DROP = 3;

// ===== Pool de tipos por fase =====

/**
 * Tipos disponíveis na fase, em ordem fixa (andador < voador < atirador) para
 * escolha determinística — espelho de EnemySystem.availableTypesLocked.
 */
export function enemyTypePool(phase: number): EnemyType[] {
  const pool: EnemyType[] = [];
  if (phase >= ENEMY_ANDADOR_PHASE) pool.push("andador");
  if (phase >= ENEMY_VOADOR_PHASE) pool.push("voador");
  if (phase >= ENEMY_ATIRADOR_PHASE) pool.push("atirador");
  return pool;
}

/**
 * Sorteia o tipo do pool da fase usando um PRNG em [0,1) (mulberry32 da seed
 * da fase). Mesma regra do servidor: floor(rnd * len(pool)).
 */
export function pickEnemyType(phase: number, rnd: () => number): EnemyType {
  const pool = enemyTypePool(phase);
  // Guarda defensiva: fase < 1 cai no pool vazio → trata como fase 1.
  if (pool.length === 0) return "andador";
  const i = Math.min(pool.length - 1, Math.floor(rnd() * pool.length));
  return pool[i];
}

// ===== Núcleo puro: spawn =====

/**
 * Cria o estado simulado de um inimigo a partir do ponto de spawn do levelgen
 * (x = coluna*TILE, y = topo do chão − 30 — convenção de generateLevelData).
 * O andador/atirador nascem com os pés no chão; o voador flutua um tile acima
 * da âncora (ignora o grid), como no servidor.
 */
export function createEnemy(
  type: EnemyType,
  spawn: { x: number; y: number },
  phase: number,
  id: string
): EnemySim {
  const { w, h } = ENEMY_SIZE[type];
  const groundTop = spawn.y + 30; // desfaz a convenção do levelgen
  let y = groundTop - h;
  let baseY = y;
  if (type === "voador") {
    baseY = groundTop - h - TILE;
    y = baseY;
  }
  // Escalonamento determinístico do primeiro tiro: nem todos os atiradores
  // disparam no mesmo instante (shootIn inicial deriva do ID sequencial).
  const idNum = parseInt(id.replace(/\D/g, ""), 10) || 1;
  return {
    id,
    type,
    x: spawn.x,
    y,
    w,
    h,
    vx: 0,
    vy: 0,
    hp: ENEMY_HP[type],
    phase,
    dir: 1,
    t: 0,
    baseY,
    shootIn: type === "atirador" ? idNum % ENEMY_ATIRADOR_COOLDOWN_TICKS : 0,
    grounded: type !== "voador",
  };
}

// ===== Núcleo puro: IA (espelho do servidor) =====

/**
 * Avança a IA de um inimigo em dt segundos contra o grid (world) e os
 * jogadores. Mutates `e`; disparos do atirador são empurrados em `shots`
 * (o wrapper os converte em projéteis hostis). O dano de contato NÃO é
 * emitido aqui — o client usa a colisão kaplay (tag "enemy" × "player").
 */
export function stepEnemy(
  e: EnemySim,
  world: EnemyWorld,
  players: EnemyPlayer[],
  dt: number,
  shots: EnemyShot[]
): void {
  switch (e.type) {
    case "voador":
      stepVoador(e, world, dt);
      break;
    case "atirador":
      stepAtirador(e, players, dt, shots);
      break;
    default:
      stepAndador(e, world, dt);
  }
}

/** Andador: patrulha horizontal no chão; vira em parede sólida OU buraco à frente. */
function stepAndador(e: EnemySim, world: EnemyWorld, dt: number): void {
  e.t += dt;

  // Gravidade (cai quando perde o chão por qualquer motivo).
  if (e.grounded) {
    e.vy = 0;
  } else {
    e.vy += ENEMY_GRAVITY * dt;
    if (e.vy > ENEMY_MAX_FALL_SPEED) e.vy = ENEMY_MAX_FALL_SPEED;
  }

  checkAndadorTurn(e, world);

  // Eixo X: move e resolve contra paredes (vira no impacto também).
  e.vx = e.dir * ENEMY_ANDADOR_SPEED;
  e.x += e.vx * dt;
  resolveEnemyX(e, world);

  // Eixo Y: move e resolve contra chão/teto.
  e.y += e.vy * dt;
  resolveEnemyY(e, world);
  e.grounded = enemyGrounded(e, world);

  clampEnemyWorld(e, world);
}

/** Inverte a direção quando a célula à frente do corpo é sólida (parede) ou
 * quando não há chão sob a borda dianteira (buraco). Checagem em tiles
 * discretos → determinística por fase. */
function checkAndadorTurn(e: EnemySim, world: EnemyWorld): void {
  const col =
    e.dir > 0 ? Math.floor((e.x + e.w + 1) / TILE) : Math.floor((e.x - 1) / TILE);
  const rowTop = Math.floor(e.y / TILE);
  const rowBot = Math.floor((e.y + e.h - 1) / TILE);
  let wall = false;
  for (let row = rowTop; row <= rowBot; row++) {
    if (world.solid(col, row)) {
      wall = true;
      break;
    }
  }
  // Buraco: chão ausente na fileira logo abaixo dos pés, na coluna dianteira.
  const footRow = Math.floor((e.y + e.h + 1) / TILE);
  const pit = !world.solid(col, footRow);
  if (wall || pit) e.dir = -e.dir;
}

/** Encosta o inimigo na parede no eixo X e inverte a direção no impacto. */
function resolveEnemyX(e: EnemySim, world: EnemyWorld): void {
  if (e.vx > 0) {
    const col = Math.floor((e.x + e.w - 1) / TILE);
    const y0 = Math.floor(e.y / TILE);
    const y1 = Math.floor((e.y + e.h - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      if (world.solid(col, ty)) {
        e.x = col * TILE - e.w;
        e.dir = -e.dir;
        return;
      }
    }
  } else if (e.vx < 0) {
    const col = Math.floor(e.x / TILE);
    const y0 = Math.floor(e.y / TILE);
    const y1 = Math.floor((e.y + e.h - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      if (world.solid(col, ty)) {
        e.x = (col + 1) * TILE;
        e.dir = -e.dir;
        return;
      }
    }
  }
}

/** Encosta o inimigo no chão (descendo) ou teto (subindo). */
function resolveEnemyY(e: EnemySim, world: EnemyWorld): void {
  const x0 = Math.floor(e.x / TILE);
  const x1 = Math.floor((e.x + e.w - 1) / TILE);
  if (e.vy > 0) {
    const row = Math.floor((e.y + e.h - 1) / TILE);
    for (let tx = x0; tx <= x1; tx++) {
      if (world.solid(tx, row)) {
        e.y = row * TILE - e.h;
        e.vy = 0;
        e.grounded = true;
        return;
      }
    }
  } else if (e.vy < 0) {
    const row = Math.floor(e.y / TILE);
    for (let tx = x0; tx <= x1; tx++) {
      if (world.solid(tx, row)) {
        e.y = (row + 1) * TILE;
        e.vy = 0;
        return;
      }
    }
  }
}

/** true quando há tile sólido imediatamente abaixo dos pés. */
function enemyGrounded(e: EnemySim, world: EnemyWorld): boolean {
  const x0 = Math.floor(e.x / TILE);
  const x1 = Math.floor((e.x + e.w - 1) / TILE);
  const row = Math.floor((e.y + e.h) / TILE);
  for (let tx = x0; tx <= x1; tx++) {
    if (world.solid(tx, row)) return true;
  }
  return false;
}

/** Voador: deriva na horizontal (quica nas bordas do mundo e em paredes) e
 * oscila verticalmente em torno da âncora com um seno — ignora buracos e
 * gravidade. */
function stepVoador(e: EnemySim, world: EnemyWorld, dt: number): void {
  e.t += dt;
  e.vx = e.dir * ENEMY_VOADOR_SPEED;
  e.x += e.vx * dt;

  // Borda do mundo: quica.
  const maxX = world.width - e.w;
  if (e.x < 0) {
    e.x = 0;
    e.dir = 1;
  } else if (e.x > maxX) {
    e.x = maxX;
    e.dir = -1;
  }
  // Parede sólida na direção de voo: quica.
  const col =
    e.dir > 0 ? Math.floor((e.x + e.w - 1) / TILE) : Math.floor(e.x / TILE);
  const midRow = Math.floor((e.y + e.h / 2) / TILE);
  if (world.solid(col, midRow)) {
    e.dir = -e.dir;
    e.vx = 0;
  }

  // Seno vertical em torno da âncora (padrão determinístico).
  e.y =
    e.baseY +
    Math.sin(2 * Math.PI * ENEMY_VOADOR_FREQUENCY * e.t) * ENEMY_VOADOR_AMPLITUDE;
  if (e.y < 0) e.y = 0;
  if (e.y + e.h > world.height) e.y = world.height - e.h;
}

/** Atirador: escolhe o alvo por regra determinística (mais próximo; empate
 * desfeito pelo menor ID) e dispara quando o cooldown zera. */
function stepAtirador(
  e: EnemySim,
  players: EnemyPlayer[],
  dt: number,
  shots: EnemyShot[]
): void {
  e.t += dt;
  if (e.shootIn > 0) {
    e.shootIn--;
    return;
  }
  const target = selectTarget(e, players);
  if (!target) return;
  e.shootIn = ENEMY_ATIRADOR_COOLDOWN_TICKS;
  shots.push({
    enemyId: e.id,
    x: e.x + e.w / 2,
    y: e.y + e.h / 2,
    targetX: target.x + target.w / 2,
    targetY: target.y + target.h / 2,
    speed: ENEMY_ATIRADOR_SHOT_SPEED,
    lifetime: ENEMY_ATIRADOR_SHOT_LIFETIME,
  });
}

/** Alvo do atirador: o vivo mais próximo (distância euclidiana entre os
 * centros), empate desfeito pelo menor ID — regra total e determinística. */
function selectTarget(e: EnemySim, players: EnemyPlayer[]): EnemyPlayer | null {
  let best: EnemyPlayer | null = null;
  let bestD = Infinity;
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  for (const p of players) {
    if (p.hp <= 0) continue;
    const pcx = p.x + p.w / 2;
    const pcy = p.y + p.h / 2;
    const dx = pcx - cx;
    const dy = pcy - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && (best === null || p.id < best.id))) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Mantém o inimigo dentro dos limites do mundo (vira nas bordas). */
function clampEnemyWorld(e: EnemySim, world: EnemyWorld): void {
  if (e.x < 0) {
    e.x = 0;
    e.dir = 1;
    return;
  }
  const maxX = world.width - e.w;
  if (e.x > maxX) {
    e.x = maxX;
    e.dir = -1;
  }
  if (e.y < 0) e.y = 0;
  const maxY = world.height - e.h;
  if (e.y >= maxY) e.y = maxY;
}

// ===== Camada kaplay (wrapper fino) =====

/** Objeto kaplay do inimigo: estado do núcleo puro + campos usados pelos
 * handlers de colisão (hp/damage). */
export interface EnemyObject extends GameObj {
  type: EnemyType;
  hp: number;
  maxHp: number;
  damage: number;
  sim: EnemySim;
}

export interface SpawnEnemyOpts {
  pos: { x: number; y: number }; // ponto de spawn do levelgen (px)
  type: EnemyType;
  phase: number;
  id: string;
  world: EnemyWorld;
  /** Jogadores atuais (posição/HP vivos), avaliado a cada frame — alvo do atirador. */
  players: () => EnemyPlayer[];
  /** Disparo do atirador: o chamador cria o projétil hostil. */
  onShot?: (shot: EnemyShot) => void;
}

/** Cor de cada tipo (distinção visual: andador vermelho, voador verde, atirador roxo). */
export const ENEMY_COLORS: Record<EnemyType, [number, number, number]> = {
  andador: [235, 70, 70],
  voador: [90, 210, 120],
  atirador: [190, 120, 235],
};

/** Cria o objeto visual do inimigo e avança a IA pura a cada frame (dt real do
 * kaplay via k.dt()). Sem componente body: a física é a do núcleo puro. */
export function spawnEnemy(k: KAPLAYCtx, opts: SpawnEnemyOpts): EnemyObject {
  const { add, pos, rect, color, area, z, onUpdate, vec2 } = k;

  const sim = createEnemy(opts.type, opts.pos, opts.phase, opts.id);
  const [r, g, b] = ENEMY_COLORS[opts.type];
  const radius = opts.type === "voador" ? 10 : 4;

  const e = add([
    "enemy",
    pos(sim.x, sim.y),
    rect(sim.w, sim.h, { radius }),
    color(r, g, b),
    area(),
    z(5),
    {
      type: opts.type,
      hp: sim.hp,
      maxHp: sim.hp,
      damage: ENEMY_CONTACT_DAMAGE,
      sim,
    },
  ]) as unknown as EnemyObject;

  // Cano do atirador (aponta pra direita — o atirador nunca vira).
  if (opts.type === "atirador") {
    e.add([
      pos(sim.w / 2, sim.h / 2 - 3),
      rect(12, 6),
      color(140, 80, 190),
      z(6),
    ]);
  }

  const shots: EnemyShot[] = [];
  onUpdate(() => {
    shots.length = 0;
    stepEnemy(sim, opts.world, opts.players(), k.dt(), shots);
    e.pos = vec2(sim.x, sim.y);
    for (const s of shots) opts.onShot?.(s);
  });

  return e;
}
