import type { GameObj, KAPLAYCtx } from "kaplay";
import { TILE, generateLevel, mulberry32 } from "./levelgen";
import type { LevelData } from "./levelgen";
import { levelCoin } from "./coins";
import type { CoinLayer } from "./coins";
import { levelPowerUp } from "./powerups";
import type { PowerUpLayer } from "./powerups";
import type { BossLayer } from "./boss";
import type { Shop, ShopStats } from "./shop";
import { buyLocal, fireCooldownMs } from "./shop";
import type { EnemyShot } from "./enemies";
import { ENEMY_MAX_COIN_DROP, ENEMY_MIN_COIN_DROP, pickEnemyType, spawnEnemy } from "./enemies";
import type { GameInput } from "./input";
import type { PlayerObject } from "./player";
import type { ParticlesHandle } from "./particles";

/**
 * Motor de simulação local do singleplayer (offline) — apps/web/src/solo.ts.
 *
 * 100% local, sem WebSocket e sem fetch ao Go API: o módulo NÃO importa net.ts
 * e nunca abre conexão — é o motor que roda o jogo completo quando o servidor
 * está desligado (dev sem API, Vercel/static hosting, etc.).
 *
 * Arquitetura (decisão do card pai t_4dbea405 — port Go→TS, sem multiplayer
 * por enquanto):
 *
 *   - Núcleo PURO (testável sem kaplay): SoloRun (máquina de estados da run:
 *     fase, carteira, stats, pausa, transições), SoloBoss (porta fiel do
 *     BossSystem do servidor — boss.go) e SoloPowerUpManager (porta do
 *     PowerUpManager — powerups.go). Mesmas constantes, mesmas regras e mesmo
 *     determinismo por seed (mulberry32 da fase) do servidor Go.
 *   - Camada kaplay (`startSolo`): constrói o mundo (tiles, inimigos, moedas,
 *     power-ups, boss), roda o loop de update (input → player, boss, efeitos,
 *     fim de fase → loja → avanço), registra as colisões offline (player ×
 *     power-up, bullet × boss) e a PAUSA do modo solo.
 *
 * O main.ts usa este motor quando NÃO há servidor (phaseState === null). Em
 * multiplayer o servidor continua autoritativo (broadcasts); o motor é
 * desligado via setServerDriven(true) — os handlers ficam inertes (guarda
 * isServerDriven) e o main.ts assume o fluxo online como antes.
 */

// ===== Relógio do servidor (tps) =====

/** Ticks por segundo do relógio do servidor (FixedDT = 50 ms). */
export const SOLO_TPS = 20;

// ===== Constantes do boss (espelho de apps/api/internal/game/boss.go) =====

/** Fases em que o boss aparece (múltiplas deste valor: 5, 10, 15…). */
export const BOSS_PHASE_STEP = 5;
/** Dimensões da hitbox do boss em px (bloco 2×2 tiles). */
export const BOSS_WIDTH = 96;
export const BOSS_HEIGHT = 96;
/** Vida máxima do boss (tiro do player = 25 → 16 tiros). */
export const BOSS_MAX_HP = 400;
/** Moedas do drop gordo ao derrotar o boss. */
export const BOSS_COIN_DROP = 20;
/** Duração do idle entre ataques em ticks (90 @ 20 tps = 4,5 s). */
export const BOSS_ATTACK_INTERVAL_TICKS = 90;
/** Duração da investida em ticks (24 @ 20 tps = 1,2 s). */
export const BOSS_DASH_TICKS = 24;
/** Velocidade horizontal da investida (px/s). */
export const BOSS_DASH_SPEED = 460;
/** Dano de contato da investida. */
export const BOSS_DASH_DAMAGE = 20;
/** Impulso vertical do salto (px/s). */
export const BOSS_JUMP_SPEED_V = 620;
/** Deslocamento horizontal durante o salto (px/s). */
export const BOSS_JUMP_SPEED_H = 130;
/** Dano em área ao aterrissar. */
export const BOSS_JUMP_DAMAGE = 25;
/** Raio do dano em área (px, do centro dos pés ao centro do jogador). */
export const BOSS_AOE_RADIUS = 120;
/** Gravidade do salto (px/s² — mesma do player/inimigos). */
export const BOSS_GRAVITY = 980;
/** Invulnerabilidade pós-contato por jogador em ticks (30 = 1,5 s). */
export const BOSS_CONTACT_COOLDOWN_TICKS = 30;

/** Constantes convertidas para segundos (o client roda em dt real). */
export const BOSS_ATTACK_INTERVAL_S = BOSS_ATTACK_INTERVAL_TICKS / SOLO_TPS;
export const BOSS_DASH_S = BOSS_DASH_TICKS / SOLO_TPS;
export const BOSS_CONTACT_COOLDOWN_S = BOSS_CONTACT_COOLDOWN_TICKS / SOLO_TPS;

/**
 * Épsilon de comparação dos relógios em segundos: somas repetidas de dt
 * (0,05) acumulam erro de ponto flutuante (4,5 − 90×0,05 ≈ 7e-16 > 0), o que
 * atrasaria/emperraria a virada de estado em um tick. Qualquer valor abaixo
 * de 1e-6 s é tratado como zero.
 */
export const SOLO_TICK_EPS = 1e-6;

// ===== Constantes dos power-ups (espelho de powerups.go) =====

/** HP adicional ACIMA do teto concedido pelo VIDA (100 → 125). */
export const POWERUP_VIDA_BONUS = 25;
/** Duração do TIRO TRIPLO em ticks (200 @ 20 tps = 10 s). */
export const POWERUP_TRIPLE_TICKS = 200;
/** Duração do TIRO TRIPLO em segundos (10 s). */
export const POWERUP_TRIPLE_S = POWERUP_TRIPLE_TICKS / SOLO_TPS;

// ===== Configuração do mundo offline =====

export const SOLO_WORLD_WIDTH_TILES = 120;
export const SOLO_WORLD_HEIGHT_TILES = 12;
export const SOLO_WORLD_WIDTH = SOLO_WORLD_WIDTH_TILES * TILE;
export const SOLO_WORLD_HEIGHT = SOLO_WORLD_HEIGHT_TILES * TILE;
export const SOLO_GROUND_Y = (SOLO_WORLD_HEIGHT_TILES - 2) * TILE;
/** Seed base da run (mesma do servidor: baseSeed=1 + (fase-1)). */
export const SOLO_BASE_SEED = 1;

/** Dimensões da hitbox do jogador em px (mesmas do servidor, player.go). */
export const PLAYER_W = 28;
export const PLAYER_H = 40;

/** Dano do tiro do jogador (mesmo do servidor — ProjectileDamage). */
export const SOLO_BULLET_DAMAGE = 25;

// ===== Tipos do núcleo =====

/** Jogador visto pelo núcleo (posição/hitbox/HP — mesmo contrato da IA). */
export interface SoloPlayer {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
}

/** Mundo visto pelo núcleo (limites em px). */
export interface SoloWorld {
  width: number;
  height: number;
  groundY: number;
}

/** Estado da máquina do boss. */
export type SoloBossState = "idle" | "investida" | "salto";

/** Boss simulado (porta de boss.go — Boss). */
export interface SoloBoss {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  phase: number;
  state: SoloBossState;
  /** Relógio local (s) — usado pela física do salto. */
  t: number;
  /** Segundos restantes no idle até o próximo ataque. */
  attackIn: number;
  /** Segundos restantes da investida. */
  dashIn: number;
  /** Direção horizontal (1 = direita, -1 = esquerda). */
  dir: number;
  grounded: boolean;
  /** Salto: true quando aterrissou e aplicou o dano em área. */
  landed: boolean;
  /** Invulnerabilidade pós-contato por jogador (s). */
  contactCd: Record<string, number>;
  /** PRNG da fase (mulberry32) — determinístico, como no servidor. */
  rng: () => number;
}

/** Evento emitido pelo Step do boss. */
export type SoloBossEvent =
  | { type: "playerHit"; playerId: string; damage: number; x: number; y: number }
  | { type: "defeated"; coins: number; x: number; y: number };

/** Power-up coletável local (mesmo formato do wire NetPowerUp). */
export interface SoloPowerUp {
  id: string;
  kind: "vida" | "tiro_triplo" | "escudo";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Efeitos ativos do jogador local (espelho do PlayerPowerUpsState). */
export interface SoloEffects {
  /** HP acima do teto concedido pelo VIDA (0 = sem efeito). */
  vida: number;
  /** TICKS restantes do tiro triplo (0 = inativo; SOLO_TPS = 1 s). */
  tripleShot: number;
  /** Cargas de escudo (0/1). */
  shield: number;
}

// ===== Núcleo puro: boss (porta fiel de boss.go) =====

/**
 * Cria o boss da fase: apenas quando a fase é múltipla de BOSS_PHASE_STEP
 * (5, 10, 15…); fora da régua devolve null. Nasce no chão (pés em groundY),
 * centralizado na coluna do meio do mundo, em idle com o relógio de ataque no
 * intervalo cheio. Determinístico: mesma fase → mesmo boss.
 */
export function createSoloBoss(
  phase: number,
  world: SoloWorld,
  seed: number
): SoloBoss | null {
  if (phase < BOSS_PHASE_STEP || phase % BOSS_PHASE_STEP !== 0) {
    return null;
  }
  const cx = world.width / 2 - BOSS_WIDTH / 2;
  const cy = world.groundY - BOSS_HEIGHT;
  return {
    id: "boss",
    x: cx,
    y: cy,
    w: BOSS_WIDTH,
    h: BOSS_HEIGHT,
    vx: 0,
    vy: 0,
    hp: BOSS_MAX_HP,
    maxHp: BOSS_MAX_HP,
    phase,
    state: "idle",
    t: 0,
    attackIn: BOSS_ATTACK_INTERVAL_S,
    dashIn: 0,
    dir: 1,
    grounded: true,
    landed: false,
    contactCd: {},
    rng: mulberry32(seed),
  };
}

/**
 * Avança a máquina de estados do boss um passo de dt segundos. Devolve os
 * eventos deste passo: dano por contato (investida) e dano em área
 * (aterrissagem do salto). Porta fiel do BossSystem.Step do servidor, com os
 * relógios em segundos (ticks ÷ SOLO_TPS) e a física em px/s — mesmas regras,
 * mesmo determinismo por seed.
 */
export function stepSoloBoss(
  b: SoloBoss,
  players: SoloPlayer[],
  world: SoloWorld,
  dt: number
): SoloBossEvent[] {
  if (dt <= 0) return [];
  b.t += dt;

  // Decai a invulnerabilidade pós-contato de cada jogador.
  for (const id of Object.keys(b.contactCd)) {
    const cd = b.contactCd[id] - dt;
    if (cd <= SOLO_TICK_EPS) delete b.contactCd[id];
    else b.contactCd[id] = cd;
  }

  switch (b.state) {
    case "idle":
      return stepIdle(b, players, world, dt);
    case "investida":
      return stepInvestida(b, players, world, dt);
    default:
      return stepSalto(b, players, world, dt);
  }
}

/** Idle: parado no chão, conta até o próximo ataque. Escolhe ataque pelo RNG
 * da fase (investida < 0,5 ≤ salto) e a direção pelo jogador vivo mais
 * próximo (regra determinística — mesma dos inimigos). */
function stepIdle(
  b: SoloBoss,
  players: SoloPlayer[],
  world: SoloWorld,
  dt: number
): SoloBossEvent[] {
  b.vx = 0;
  b.vy = 0;
  b.grounded = true;
  b.attackIn -= dt;
  if (b.attackIn > SOLO_TICK_EPS) return [];

  const target = selectBossTarget(b, players);
  if (target) {
    if (target.x + target.w / 2 < b.x + b.w / 2) b.dir = -1;
    else b.dir = 1;
  }
  if (b.rng() < 0.5) {
    b.state = "investida";
    b.dashIn = BOSS_DASH_S;
    b.vx = b.dir * BOSS_DASH_SPEED;
  } else {
    b.state = "salto";
    b.grounded = false;
    b.landed = false;
    b.vx = b.dir * BOSS_JUMP_SPEED_H;
    b.vy = -BOSS_JUMP_SPEED_V;
  }
  return [];
}

/** Investida: linha reta horizontal (dano por contato), quica nas bordas e
 * volta ao idle quando o dashIn zera. */
function stepInvestida(
  b: SoloBoss,
  players: SoloPlayer[],
  world: SoloWorld,
  dt: number
): SoloBossEvent[] {
  b.vx = b.dir * BOSS_DASH_SPEED;
  b.x += b.vx * dt;
  const maxX = world.width - b.w;
  if (b.x < 0) {
    b.x = 0;
    b.dir = 1;
  } else if (b.x > maxX) {
    b.x = maxX;
    b.dir = -1;
  }
  b.dashIn -= dt;
  if (b.dashIn <= SOLO_TICK_EPS) {
    b.state = "idle";
    b.attackIn = BOSS_ATTACK_INTERVAL_S;
    return [];
  }

  // Dano por contato (AABB player × boss), respeitando a invulnerabilidade.
  const events: SoloBossEvent[] = [];
  for (const p of players) {
    if (p.hp <= 0) continue;
    if (
      b.x < p.x + p.w &&
      b.x + b.w > p.x &&
      b.y < p.y + p.h &&
      b.y + b.h > p.y
    ) {
      if ((b.contactCd[p.id] ?? 0) <= SOLO_TICK_EPS) {
        b.contactCd[p.id] = BOSS_CONTACT_COOLDOWN_S;
        events.push({ type: "playerHit", playerId: p.id, damage: BOSS_DASH_DAMAGE, x: b.x, y: b.y });
      }
    }
  }
  return events;
}

/** Salto: arco parabólico (impulso + gravidade). Sem dano no ar; ao tocar o
 * chão aplica UMA VEZ o dano em área (raio BOSS_AOE_RADIUS do centro dos pés)
 * e volta ao idle. */
function stepSalto(
  b: SoloBoss,
  players: SoloPlayer[],
  world: SoloWorld,
  dt: number
): SoloBossEvent[] {
  b.vy += BOSS_GRAVITY * dt;
  if (b.vy > 900) b.vy = 900; // velocidade terminal (mesma ordem dos inimigos)
  b.x += b.vx * dt;
  const maxX = world.width - b.w;
  if (b.x < 0) {
    b.x = 0;
    b.dir = 1;
    b.vx = b.dir * BOSS_JUMP_SPEED_H;
  } else if (b.x > maxX) {
    b.x = maxX;
    b.dir = -1;
    b.vx = b.dir * BOSS_JUMP_SPEED_H;
  }
  b.y += b.vy * dt;
  if (b.y < 0) {
    b.y = 0;
    b.vy = 0;
  }

  if (b.y + b.h >= world.groundY) {
    // Aterrissou: assenta e aplica o dano em área (uma vez).
    b.y = world.groundY - b.h;
    b.vy = 0;
    b.grounded = true;
    b.state = "idle";
    b.attackIn = BOSS_ATTACK_INTERVAL_S;
    if (b.landed) return [];
    b.landed = true;

    const events: SoloBossEvent[] = [];
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h; // centro dos pés = ponto de impacto
    for (const p of players) {
      if (p.hp <= 0) continue;
      const pcx = p.x + p.w / 2;
      const pcy = p.y + p.h / 2;
      const dx = pcx - cx;
      const dy = pcy - cy;
      if (dx * dx + dy * dy <= BOSS_AOE_RADIUS * BOSS_AOE_RADIUS) {
        events.push({ type: "playerHit", playerId: p.id, damage: BOSS_JUMP_DAMAGE, x: b.x, y: b.y });
      }
    }
    return events;
  }
  return [];
}

/** Alvo do boss: jogador vivo mais próximo (distância euclidiana entre os
 * centros), empate desfeito pelo menor ID — mesma regra dos inimigos. */
function selectBossTarget(b: SoloBoss, players: SoloPlayer[]): SoloPlayer | null {
  let best: SoloPlayer | null = null;
  let bestD = Infinity;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
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

/**
 * Aplica dano ao boss (tiro do jogador). Se o HP zerar, o boss é derrotado:
 * devolve o evento do drop gordo (BOSS_COIN_DROP moedas na posição final).
 */
export function applySoloBossDamage(b: SoloBoss, dmg: number): SoloBossEvent[] {
  b.hp -= dmg;
  if (b.hp > 0) return [];
  const ev: SoloBossEvent = { type: "defeated", coins: BOSS_COIN_DROP, x: b.x, y: b.y };
  b.hp = 0;
  return [ev];
}

/** Snapshot do boss no formato do wire (NetBoss) — alimenta bossLayer/HUD. */
export function soloBossSnapshot(b: SoloBoss | null): {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  phase: number;
} | null {
  if (!b) return null;
  return {
    id: b.id,
    x: Math.round(b.x),
    y: Math.round(b.y),
    hp: b.hp,
    maxHp: b.maxHp,
    state: b.state,
    phase: b.phase,
  };
}

// ===== Núcleo puro: power-ups (porta fiel de powerups.go) =====

/**
 * Registra os power-ups da fase no motor local: um por posição de
 * Level.powerUpSpawns, com ID único sequencial (p1, p2, …) e a conversão
 * tile→pixels (levelPowerUp: centro da coluna, flutuando 36px acima do topo)
 * — as MESMAS posições/IDs que o servidor atribuiria à fase. Determinístico.
 */
export function spawnSoloPowerUps(spawns: LevelData["powerUpSpawns"]): SoloPowerUp[] {
  return spawns.map((sp, i) => {
    const p = levelPowerUp(sp.x, sp.y, `p${i + 1}`, sp.kind);
    return { id: p.id, kind: sp.kind, x: p.x, y: p.y, w: p.w, h: p.h };
  });
}
/**
 * Detecta a coleta por sobreposição AABB entre o jogador e os power-ups da
 * fase. Cada power-up tocado é removido e devolvido (o chamador aplica o
 * efeito). Ordem determinística: power-ups por ID (ordem do array). Jogador
 * morto não coleta.
 */
export function collectSoloPowerUps(
  powerUps: SoloPowerUp[],
  player: SoloPlayer
): SoloPowerUp[] {
  if (player.hp <= 0) return [];
  const collected: SoloPowerUp[] = [];
  for (let i = powerUps.length - 1; i >= 0; i--) {
    const p = powerUps[i];
    if (
      p.x < player.x + player.w &&
      p.x + p.w > player.x &&
      p.y < player.y + player.h &&
      p.y + p.h > player.y
    ) {
      collected.push(p);
      powerUps.splice(i, 1);
    }
  }
  return collected.reverse(); // ordem de remoção original (por ID)
}

// ===== Núcleo puro: run (fase/carteira/stats/pausa/transições) =====

/** Estado da run singleplayer local. */
export interface SoloRunState {
  /** Fase atual (1-based). */
  phase: number;
  /** Caixa individual de moedas (persiste entre fases — a loja gasta). */
  wallet: number;
  /** Upgrades efetivos da run (loja local). */
  stats: ShopStats;
  /** Pausa do modo solo (mundo congelado). */
  paused: boolean;
  /** Transição de fase em andamento (fim de mapa → loja). */
  transitioning: boolean;
  /** Jogador morto (respawn pendente). */
  dead: boolean;
  /** Contador de moedas da fase atual (zera no rebuild da fase). */
  teamCoins: number;
}

export interface SoloRunOpts {
  phase?: number;
  wallet?: number;
  stats?: ShopStats;
}

/** Cria o estado inicial da run. */
export function createSoloRunState(opts: SoloRunOpts = {}): SoloRunState {
  return {
    phase: opts.phase ?? 1,
    wallet: opts.wallet ?? 0,
    stats: opts.stats ?? { maxHp: 100, fireRate: 1, shield: 0 },
    paused: false,
    transitioning: false,
    dead: false,
    teamCoins: 0,
  };
}

/**
 * Compra local na loja (offline): valida e debita como o servidor
 * (buyLocal do shop.ts — mesma semântica de erros). Devolve o resultado
 * completo; o chamador persiste wallet/stats no estado da run.
 */
export function soloBuy(run: SoloRunState, upgrade: string) {
  return buyLocal(run.wallet, run.stats, upgrade);
}

/** Aplica o comprovante de uma compra local no estado da run (imutável). */
export function soloApplyBuy(run: SoloRunState, upgrade: string): SoloRunState {
  const res = soloBuy(run, upgrade);
  if (!res.ok) return run;
  return { ...run, wallet: res.wallet, stats: res.stats };
}

/** Cooldown efetivo entre tiros em ms (mesmo do servidor: 150ms / fire_rate). */
export function soloFireCooldownMs(run: SoloRunState): number {
  return fireCooldownMs(run.stats.fireRate);
}

/** Efeitos ativos do jogador local (vazio quando a run não tem efeitos). */
export function emptySoloEffects(): SoloEffects {
  return { vida: 0, tripleShot: 0, shield: 0 };
}

// ===== Camada kaplay: startSolo =====

export interface SoloOpts {
  k: KAPLAYCtx;
  player: PlayerObject;
  coinLayer: CoinLayer;
  powerUpLayer: PowerUpLayer;
  bossLayer: BossLayer;
  shop: Shop;
  input: GameInput;
  particles: ParticlesHandle;
  /** Feedback de áudio (callbacks injetados pelo main.ts). */
  audio: {
    playCoin(): void;
    playDamage(): void;
    playDeath(): void;
    playJump(): void;
    playPowerUp(): void;
    playShoot(): void;
    playUI(): void;
  };
  /** Seed base da run (default SOLO_BASE_SEED — espelho do servidor). */
  baseSeed?: number;
}

/** Sessão do modo solo — API usada pelo main.ts. */
export interface SoloSession {
  /** Estado da run (fase/carteira/stats/pausa/transições) — mutável. */
  run: SoloRunState;
  /** Boss simulado da fase atual (null fora da régua de 5) — sempre ao vivo. */
  getBoss(): SoloBoss | null;
  /** Power-ups coletáveis da fase atual — sempre ao vivo. */
  getPowerUps(): SoloPowerUp[];
  /** Efeitos ativos do jogador local (vida/tripleShot/shield) — ao vivo. */
  getEffects(): SoloEffects;
  /** true quando o servidor assumiu (multiplayer) — motor inerte. */
  isServerDriven(): boolean;
  /** Liga/desliga o modo servidor (main.ts chama no primeiro broadcast). */
  setServerDriven(v: boolean): void;
  /** Constrói o mundo da fase `number` (tiles, inimigos, moedas, power-ups,
   * boss) e reposiciona o jogador no spawn com o teto efetivo. */
  buildWorld(number: number, maxHp: number): void;
  /** Coleta uma moeda (contador da fase) — main.ts chama do onCollide. */
  collectCoin(id: string, x: number, y: number): void;
  /** Dano no jogador local (escudo absorve, morte agenda respawn). */
  damagePlayer(n: number): void;
  /** Tiro do jogador local (cooldown da run + tiro triplo do efeito). */
  tryShoot(): boolean;
  /** Drop de moedas em x,y (inimigos/boss) — count opcional (default 1–3). */
  dropAt(x: number, y: number, count?: number): void;
  /** Compra local na loja (valida/debita como o servidor). true = comprou. */
  buy(upgrade: string): boolean;
  /** Abre a loja local (offline) — overlay com caixa individual. */
  openLocalShop(): void;
  /** Confirma 'pronto' na loja local — avança a fase e reconstrói o mundo. */
  confirmReady(): void;
  /** Pausa/retoma o mundo (modo solo). */
  togglePause(): boolean;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /** Destrói os listeners registrados pelo motor. */
  destroy(): void;
}

/**
 * Cria o motor do modo solo e inicia a run (fase 1). Registra o loop de
 * update (input → player, boss, efeitos, fim de fase → loja → avanço), as
 * colisões offline (player × power-up, bullet × boss) e a tecla de pausa.
 * NÃO abre WebSocket nem fetch — 100% offline.
 */
export function startSolo(opts: SoloOpts): SoloSession {
  const { k, player, coinLayer, powerUpLayer, bossLayer, shop, input, particles, audio } = opts;
  const baseSeed = opts.baseSeed ?? SOLO_BASE_SEED;

  const {
    add,
    onUpdate,
    onCollide,
    onKeyPress,
    vec2,
    pos,
    rect,
    color,
    z,
    destroy,
    destroyAll,
    wait,
    rand,
  } = k;

  // ===== Estado da run =====
  const run: SoloRunState = createSoloRunState();
  let boss: SoloBoss | null = null;
  let powerUps: SoloPowerUp[] = [];
  let effects: SoloEffects = emptySoloEffects();
  let serverDriven = false;
  // Marco do último tiro (performance.now) — cooldown local offline.
  let lastShotAt = 0;
  let destroyed = false;

  // Triple-shot ativo? (efeito com ticks restantes > 0)
  const tripleActive = () => effects.tripleShot > 0;

  // ===== Tags do mundo (mesmas do main.ts multiplayer) =====
  const WORLD_TAGS = ["solid", "enemy", "hostile"];

  /** Pausa/retoma os objetos do mundo (player, inimigos, projéteis). */
  function setWorldPaused(paused: boolean): void {
    for (const tag of ["enemy", "hostile", "bullet"]) {
      for (const obj of k.get(tag)) obj.paused = paused;
    }
    if (player.exists()) player.paused = paused;
  }

  // ===== Construção do mundo =====
  function buildWorld(number: number, maxHp: number): void {
    for (const tag of WORLD_TAGS) destroyAll(tag);
    coinLayer.clear();
    powerUpLayer.clear();
    bossLayer.clear();
    effects = emptySoloEffects();
    run.teamCoins = 0;

    const seed = (baseSeed + (number - 1)) >>> 0;
    const level: LevelData = generateLevel(k, {
      width: SOLO_WORLD_WIDTH_TILES,
      height: SOLO_WORLD_HEIGHT_TILES,
      seed,
      difficulty: number,
    });
    level.render();

    // Moedas da fase (mesmas regras/posições do servidor — levelCoin).
    // Offline (motor dono): spawn local. Multiplayer (serverDriven): o
    // servidor broadcasta o estado autoritativo (onCoins assume a camada).
    if (!serverDriven) {
      const localCoins = level.coinSpawns.map((t, i) => levelCoin(t.x, t.y, `c${i + 1}`));
      coinLayer.applyFull(localCoins);

      // Power-ups da fase (raros, determinísticos — nível do gerador).
      powerUps = spawnSoloPowerUps(level.powerUpSpawns);
      powerUpLayer.applyFull(powerUps);

      // Boss da fase (fases múltiplas de 5, no meio do mapa).
      boss = createSoloBoss(number, {
        width: SOLO_WORLD_WIDTH,
        height: SOLO_WORLD_HEIGHT,
        groundY: SOLO_GROUND_Y,
      }, seed);
      bossLayer.apply(soloBossSnapshot(boss));
    } else {
      // Multiplayer: sem spawn local — o servidor broadcasta.
      powerUps = [];
      boss = null;
    }

    // Inimigos (IA 100% local — mesma do multiplayer: o servidor NÃO
    // broadcasta inimigos, a simulação deles é sempre client-side).
    const solidTiles = new Set(level.tiles.map((t) => `${t.x},${t.y}`));
    const enemyWorld = {
      width: SOLO_WORLD_WIDTH,
      height: SOLO_WORLD_HEIGHT,
      solid: (tx: number, ty: number) => solidTiles.has(`${tx},${ty}`),
    };
    const localPlayerForAi = (): SoloPlayer[] => [
      {
        id: "local",
        x: player.pos.x,
        y: player.pos.y,
        w: PLAYER_W,
        h: PLAYER_H,
        hp: player.hp,
      },
    ];
    const enemyRng = mulberry32(seed);
    let enemySeq = 0;
    for (const p of level.enemySpawns) {
      enemySeq += 1;
      spawnEnemy(k, {
        pos: p,
        type: pickEnemyType(number, enemyRng),
        phase: number,
        id: `e${enemySeq}`,
        world: enemyWorld,
        players: localPlayerForAi,
        onShot: spawnHostileShot,
      });
    }

    // Player local: reposiciona no spawn com o teto efetivo.
    player.hp = maxHp;
    player.pos = vec2(level.playerSpawn.x, level.playerSpawn.y);
    player.hidden = false;
    player.paused = false;
    run.phase = number;
    run.dead = false;
    run.transitioning = false;
  }

  // ===== Projéteis hostis (atirador — IA local) =====
  function spawnHostileShot(shot: EnemyShot): void {
    const dx = shot.targetX - shot.x;
    const dy = shot.targetY - shot.y;
    const dist = Math.hypot(dx, dy) || 1;
    const vx = (dx / dist) * shot.speed;
    const vy = (dy / dist) * shot.speed;

    const hb = add([
      "hostile",
      pos(shot.x - 5, shot.y - 5),
      rect(10, 10),
      color(255, 140, 200),
      k.area(),
      z(8),
      { damage: 25 },
    ]);
    hb.onUpdate(() => {
      hb.move(vx, vy);
      if (
        hb.pos.x < -40 ||
        hb.pos.x > SOLO_WORLD_WIDTH + 40 ||
        hb.pos.y < -40 ||
        hb.pos.y > SOLO_WORLD_HEIGHT + 40
      ) {
        destroy(hb);
      }
    });
    wait(shot.lifetime, () => {
      if (hb.exists()) destroy(hb);
    });
  }

  // ===== Coleta de moedas (main.ts chama do onCollide offline) =====
  function collectCoin(id: string, x: number, y: number): void {
    if (serverDriven) return;
    audio.playCoin();
    particles.spawnCoinCollect(x, y);
    coinLayer.remove(id);
    run.teamCoins += 1;
  }

  // ===== Dano no jogador local =====
  // Aplica dano nos DOIS modos (inimigos são sempre client-side — o servidor
  // não broadcasta inimigos; o dano de contato local é o mesmo de sempre).
  // O escudo vem de effects (só populado offline — online o servidor decide).
  function damagePlayer(n: number): void {
    if (player.hp <= 0) return;
    // Escudo (offline — efeito de power-up/loja): consome 1 carga e zera o dano.
    // O power-up (effects.shield) tem prioridade — é temporário; o upgrade da
    // loja (run.stats.shield, espelho do AbsorbShield do servidor) é permanente
    // até ser consumido. Mesmo feedback do main.ts antigo (hurtLocalPlayer).
    if (effects.shield > 0) {
      effects.shield -= 1;
      audio.playPowerUp();
      particles.spawnShootImpact(player.pos.x, player.pos.y);
      return;
    }
    if (run.stats.shield > 0) {
      run.stats.shield -= 1;
      audio.playPowerUp();
      particles.spawnShootImpact(player.pos.x, player.pos.y);
      return;
    }
    player.hp -= n;
    audio.playDamage();
    particles.spawnDust(player.pos.x, player.pos.y + 20, 90);
    if (player.hp <= 0) {
      player.hp = 0;
      audio.playDeath();
      particles.spawnEnemyDeath(player.pos.x, player.pos.y);
      run.dead = true;
      player.hidden = true;
      player.paused = true;
      // Squad wipe com 1 player: reset da fase com a MESMA seed após 3 s
      // (DefaultRespawnTicks do servidor). Offline o motor reconstrói o
      // mundo; online o servidor revive e broadcasta (o reset local é inócuo).
      wait(3, () => {
        if (destroyed) return;
        buildWorld(run.phase, run.stats.maxHp);
        audio.playPowerUp();
        particles.spawnRespawn(player.pos.x, player.pos.y);
      });
    }
  }

  // ===== Tiro local =====
  function tryShoot(): boolean {
    const cooldownOk = performance.now() - lastShotAt >= soloFireCooldownMs(run);
    if (!cooldownOk) return false;
    lastShotAt = performance.now();
    audio.playShoot();
    particles.spawnShootImpact(player.pos.x + player.facing * 24, player.pos.y - 10);
    if (tripleActive()) player.shootTriple();
    else player.shoot();
    return true;
  }

  // ===== Loja local =====
  function openLocalShop(): void {
    shop.update(
      {
        phase: "shop",
        number: run.phase,
        ready: { local: false },
        players: [{ id: "local", coins: run.wallet, stats: run.stats }],
      },
      "local"
    );
    run.transitioning = true;
  }

  function confirmReady(): void {
    shop.update(
      { phase: "playing", number: run.phase + 1, ready: {}, players: [] },
      "local"
    );
    run.wallet += run.teamCoins;
    buildWorld(run.phase + 1, run.stats.maxHp);
    setWorldPaused(false); // mundo novo nasce destravado
  }

  // ===== Compra local (loja) =====
  function buy(upgrade: string): boolean {
    const res = soloBuy(run, upgrade);
    if (!res.ok) {
      shop.showError(res.error);
      return false;
    }
    run.wallet = res.wallet;
    run.stats = res.stats;
    shop.applyBuyResult(res.receipt);
    audio.playUI();
    return true;
  }

  // ===== Pausa =====
  function togglePause(): boolean {
    if (serverDriven || run.dead) return run.paused;
    run.paused = !run.paused;
    setWorldPaused(run.paused);
    return run.paused;
  }
  function pause(): void {
    if (!run.paused) togglePause();
  }
  function resume(): void {
    if (run.paused) togglePause();
  }

  // ===== Colisões offline =====

  // player × coin — coleta local (contador da fase + feedback).
  onCollide("player", "coin", (pl, c) => {
    if (serverDriven || run.paused) return;
    const id = (c as unknown as { coinId?: string }).coinId;
    if (id) collectCoin(id, c.pos.x, c.pos.y);
  });

  // player × power-up — coleta local (efeito aplicado pelo motor).
  onCollide("player", "powerup", (pl, pu) => {
    if (serverDriven || run.paused) return;
    const id = (pu as unknown as { powerUpId?: string }).powerUpId;
    if (!id) return;
    const idx = powerUps.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const p = powerUps[idx];
    powerUps.splice(idx, 1);
    // applyRemoved destrói o objeto e dispara o onCollect da camada (o
    // main.ts injeta playPowerUp + partículas no onCollect da powerUpLayer —
    // feedback único, sem duplicar som/partículas aqui).
    powerUpLayer.applyRemoved([{ id: p.id, kind: p.kind, x: p.x, y: p.y }]);
    // Aplica o efeito (mesmas regras do servidor — powerups.go).
    if (p.kind === "vida") {
      effects.vida = POWERUP_VIDA_BONUS;
      player.hp = Math.max(player.hp, playerMaxHp() + POWERUP_VIDA_BONUS);
    } else if (p.kind === "tiro_triplo") {
      effects.tripleShot = POWERUP_TRIPLE_TICKS;
    } else {
      effects.shield = 1;
    }
  });

  // bullet × boss — dano no boss (tiro local, offline).
  onCollide("bullet", "boss", (b) => {
    if (serverDriven || !boss) return;
    const events = applySoloBossDamage(boss, SOLO_BULLET_DAMAGE);
    particles.spawnShootImpact(b.pos.x, b.pos.y);
    for (const ev of events) {
      if (ev.type === "defeated") {
        boss = null;
        bossLayer.apply(null);
        audio.playDeath();
        particles.spawnEnemyDeath(ev.x, ev.y);
        dropCoins(ev.x, ev.y, ev.coins);
      }
    }
  });

  // player × enemy — dano de contato (mesmo do servidor: ENEMY_CONTACT_DAMAGE).
  onCollide("player", "enemy", (_pl, en) => {
    damagePlayer((en as unknown as { damage?: number }).damage ?? 10);
  });

  // hostile × player — projétil do atirador.
  onCollide("hostile", "player", (hb) => {
    damagePlayer((hb as unknown as { damage?: number }).damage ?? 25);
    destroy(hb);
  });

  // hostile × solid — impacto.
  onCollide("hostile", "solid", (hb) => {
    particles.spawnShootImpact(hb.pos.x, hb.pos.y);
    destroy(hb);
  });

  // bullet × solid — impacto de tiro + destrói a bala.
  onCollide("bullet", "solid", (b) => {
    particles.spawnShootImpact(b.pos.x, b.pos.y);
    destroy(b);
  });

  // bullet × enemy — dano no inimigo; morte → explosão + drop de moedas.
  onCollide("bullet", "enemy", (b, en) => {
    particles.spawnShootImpact(b.pos.x, b.pos.y);
    en.hp -= b.damage;
    if (en.hp <= 0) {
      audio.playDeath();
      particles.spawnEnemyDeath(en.pos.x, en.pos.y);
      dropCoins(en.pos.x, en.pos.y, 0); // drop aleatório 1–3
      destroy(en);
    } else {
      audio.playDamage();
    }
    destroy(b);
  });

  // ===== Drop de moedas (inimigos/boss) =====
  let dropSeq = 0;
  function dropCoins(x: number, y: number, count?: number): void {
    const n = count ?? Math.floor(rand(ENEMY_MIN_COIN_DROP, ENEMY_MAX_COIN_DROP + 1));
    const drops = [];
    for (let i = 0; i < n; i++) {
      dropSeq += 1;
      drops.push({
        id: `d${dropSeq}`,
        x: x + (i - (n - 1) / 2) * 16,
        y: y - 6,
        w: 14,
        h: 14,
      });
    }
    coinLayer.addCoins(drops);
  }

  // ===== Teto de vida efetivo (upgrades da loja) =====
  function playerMaxHp(): number {
    return run.stats.maxHp;
  }

  // ===== Loop de update (input → player, boss, efeitos, fim de fase) =====
  let wasGrounded = true;
  let acc = 0;
  onUpdate(() => {
    if (destroyed || serverDriven) return;

    // Pausa: mundo congelado (objetos paused — a IA também respeita).
    if (run.paused) return;

    const frame = input.poll();
    // Durante a loja (transição) o mundo está pausado (setWorldPaused) e o
    // overlay bloqueia o input — não mover/atirar atrás do overlay.
    if (!run.transitioning && player.exists()) {
      player.movePlayer(frame.direction);
      if (frame.jumpPressed) {
        if (player.isGrounded()) {
          audio.playJump();
          particles.spawnDust(player.pos.x, player.pos.y + 20, 90);
        }
        player.jumpPlayer();
      }
      if (frame.shootPressed) tryShoot();
    }

    // Boss: avança a máquina em dt real (acumulador garante passo >= 0).
    if (boss) {
      const dt = k.dt();
      const events = stepSoloBoss(boss, [playerSnapshot()], {
        width: SOLO_WORLD_WIDTH,
        height: SOLO_WORLD_HEIGHT,
        groundY: SOLO_GROUND_Y,
      }, dt);
      bossLayer.apply(soloBossSnapshot(boss));
      for (const ev of events) {
        if (ev.type === "playerHit") damagePlayer(ev.damage);
      }
    }

    // Efeitos: expira o tiro triplo (relógio em ticks — 10 s exatos).
    if (effects.tripleShot > 0) {
      acc += k.dt();
      while (acc >= 1 / SOLO_TPS) {
        acc -= 1 / SOLO_TPS;
        effects.tripleShot -= 1;
      }
    }

    // Fim do mapa → loja entre fases (offline): borda direita do player
    // cruzou a primeira coluna do fim (isLevelFinished do levelgen).
    if (
      !run.transitioning &&
      !run.dead &&
      player.exists() &&
      player.hp > 0 &&
      player.pos.x + PLAYER_W >= (SOLO_WORLD_WIDTH_TILES - 1) * TILE
    ) {
      run.transitioning = true;
      audio.playPowerUp();
      particles.spawnCoinCollect(player.pos.x, player.pos.y);
      run.wallet += run.teamCoins;
      setWorldPaused(true);
      openLocalShop();
    }

    const grounded = player.exists() && player.isGrounded();
    if (grounded && !wasGrounded) {
      particles.spawnDust(player.pos.x, player.pos.y + 20);
    }
    wasGrounded = grounded;
  });

  // ===== Tecla de pausa (modo solo) =====
  onKeyPress("p", () => {
    if (!serverDriven) {
      togglePause();
      audio.playUI();
    }
  });
  onKeyPress("escape", () => {
    if (!serverDriven) {
      togglePause();
      audio.playUI();
    }
  });

  function playerSnapshot(): SoloPlayer {
    return {
      id: "local",
      x: player.pos.x,
      y: player.pos.y,
      w: PLAYER_W,
      h: PLAYER_H,
      hp: player.hp,
    };
  }

  // Inicia a run na fase 1.
  buildWorld(1, run.stats.maxHp);

  return {
    run,
    getBoss: () => boss,
    getPowerUps: () => powerUps,
    getEffects: () => effects,
    isServerDriven: () => serverDriven,
    setServerDriven: (v: boolean) => {
      serverDriven = v;
      if (v) setWorldPaused(false); // o servidor assume o mundo
    },
    buildWorld,
    collectCoin,
    damagePlayer,
    tryShoot,
    buy,
    openLocalShop,
    confirmReady,
    togglePause,
    pause,
    resume,
    isPaused: () => run.paused,
    dropAt: (x, y, count) => dropCoins(x, y, count),
    destroy: () => {
      destroyed = true;
    },
  };
}
