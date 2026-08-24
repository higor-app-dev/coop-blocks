/**
 * particles.ts — Módulo de partículas 2D leve via Kaplay.
 *
 * Zero assets externos: cada partícula é um rect colorido (k.rect + k.color)
 * criado em tempo real, com física manual simples (velocidade inicial +
 * gravidade + drag) e fade-out via k.tween até ser destruída.
 *
 * O módulo NÃO importa kaplay diretamente: recebe o contexto do jogo (ou um
 * fake estruturalmente compatível, nos testes) via createParticles(k, ...),
 * seguindo o mesmo padrão de createPlayer/generateLevel do resto do código.
 *
 * API pública:
 *   const particles = createParticles(k, config?) → ParticlesHandle
 *   particles.spawnShootImpact(x, y)
 *   particles.spawnCoinCollect(x, y)
 *   particles.spawnEnemyDeath(x, y)
 *   particles.spawnRespawn(x, y)
 *   particles.spawnDust(x, y, direction?)   — direction em graus, 0 = direita,
 *                                             90 = baixo (coordenadas de tela)
 *
 * A configuração (cores e quantidades por efeito) vive em DEFAULT_CONFIG e
 * pode ser sobrescrita parcialmente no createParticles — merge profundo.
 * Partículas com vida curta são rastreadas num Set interno; a física roda em
 * um único k.onUpdate registrado sob demanda (no primeiro spawn).
 */

// ===== Tipos =====

export interface Vec2Like {
  x: number;
  y: number;
}

/** Objeto de jogo mínimo que o módulo manipula (structural — compatível com GameObj do Kaplay). */
export interface ParticleObj {
  pos: Vec2Like;
  opacity: number;
  /** Velocidade da partícula em px/s — propriedade custom gravada pelo módulo no objeto. */
  vel?: Vec2Like;
}

/** Superfície mínima do motor usada pelo módulo (testável com um fake). */
export interface ParticlesEngine {
  add(comps: unknown[]): ParticleObj;
  pos(x: number, y: number): unknown;
  rect(w: number, h: number): unknown;
  color(r: number, g: number, b: number): unknown;
  opacity(v: number): unknown;
  z(v: number): unknown;
  rotate(deg: number): unknown;
  rand(min: number, max: number): number;
  randInt(min: number, max: number): number;
  tween(
    from: number,
    to: number,
    duration: number,
    onUpdate: (v: number) => void,
    onEnd?: () => void
  ): unknown;
  destroy(obj: ParticleObj): void;
  onUpdate(fn: () => void): unknown;
  dt(): number;
}

/** Config de um efeito: quantidades, cores (RGB 0-255) e faixas de parâmetros. */
export interface EffectConfig {
  /** Número de partículas por spawn. */
  count: number;
  /** Paleta de cores — cada cor é [r, g, b] com 0-255. Escolhida aleatoriamente por partícula. */
  colors: ReadonlyArray<readonly [number, number, number]>;
  /** Tamanho do lado do quadrado (px). */
  sizeMin: number;
  sizeMax: number;
  /** Velocidade inicial (px/s) — módulo do vetor de arremesso. */
  speedMin: number;
  speedMax: number;
  /**
   * Faixa de ângulo de arremesso em graus (0 = direita, 90 = baixo),
   * usada quando o spawn NÃO recebe direction explícita.
   */
  angleMin: number;
  angleMax: number;
  /** Meia-abertura em graus em torno de `direction` quando ela é fornecida (0 = reto). */
  spread: number;
  /** Tempo de vida (s) — o fade-out leva a vida inteira. */
  lifeMin: number;
  lifeMax: number;
  /** Multiplicador da gravidade global do mundo (0 = flutua, 1 = cai como o jogador). */
  gravityScale: number;
}

export interface ParticlesConfig {
  /** Camada z das partículas (acima de tiles=1, inimigos=5, jogador=9/10). */
  z: number;
  /** Gravidade global em px/s² aplicada a todas as partículas. */
  gravity: number;
  /** Drag exponencial por segundo (0..1) — amortece a velocidade. */
  drag: number;
  effects: {
    shootImpact: EffectConfig;
    coinCollect: EffectConfig;
    powerUpCollect: EffectConfig;
    enemyDeath: EffectConfig;
    respawn: EffectConfig;
    dust: EffectConfig;
  };
}

export interface ParticlesHandle {
  spawnShootImpact(x: number, y: number): void;
  spawnCoinCollect(x: number, y: number): void;
  spawnPowerUpCollect(x: number, y: number): void;
  spawnEnemyDeath(x: number, y: number): void;
  spawnRespawn(x: number, y: number): void;
  spawnDust(x: number, y: number, direction?: number): void;
}

/** Partial recursivo — permite sobrescrever só um pedaço da config (merge profundo). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

// ===== Configuração padrão (cores e quantidades) =====

export const DEFAULT_CONFIG: ParticlesConfig = {
  z: 50,
  gravity: 980, // mesma do mundo (main.ts: k.setGravity(980))
  drag: 0.15,

  effects: {
    // Impacto de tiro: faíscas rápidas, cores quentes, vida curtíssima.
    shootImpact: {
      count: 8,
      colors: [
        [255, 216, 77], // amarelo
        [255, 140, 40], // laranja
        [255, 255, 255], // branco
      ],
      sizeMin: 3,
      sizeMax: 6,
      speedMin: 120,
      speedMax: 280,
      angleMin: 0,
      angleMax: 360,
      spread: 0,
      lifeMin: 0.2,
      lifeMax: 0.4,
      gravityScale: 0.6,
    },

    // Coleta de moeda: jato dourado para cima que cai (fonte), brilho curto.
    coinCollect: {
      count: 10,
      colors: [
        [255, 215, 60], // dourado
        [255, 180, 40], // âmbar
        [255, 255, 220], // brilho claro
      ],
      sizeMin: 3,
      sizeMax: 5,
      speedMin: 90,
      speedMax: 210,
      angleMin: 200,
      angleMax: 340,
      spread: 0,
      lifeMin: 0.35,
      lifeMax: 0.6,
      gravityScale: 1.0,
    },

    // Coleta de power-up: jato verde/ciano "de poder" que sobe e some devagar
    // (feedback visual do power-up coletado — disparado pelo onCollect).
    powerUpCollect: {
      count: 14,
      colors: [
        [120, 255, 150], // verde vivo
        [80, 220, 255], // ciano
        [255, 255, 255], // brilho claro
      ],
      sizeMin: 4,
      sizeMax: 7,
      speedMin: 90,
      speedMax: 240,
      angleMin: 190,
      angleMax: 350,
      spread: 0,
      lifeMin: 0.4,
      lifeMax: 0.8,
      gravityScale: 0.4,
    },

    // Morte de inimigo: explosão maior, vermelho/roxo, alguns flutuam mais.
    enemyDeath: {
      count: 14,
      colors: [
        [255, 80, 80], // vermelho
        [190, 90, 230], // roxo
        [190, 190, 200], // cinza metálico
      ],
      sizeMin: 4,
      sizeMax: 8,
      speedMin: 140,
      speedMax: 320,
      angleMin: 0,
      angleMax: 360,
      spread: 0,
      lifeMin: 0.4,
      lifeMax: 0.8,
      gravityScale: 1.2,
    },

    // Respawn: anel ciano/azul suave que flutua e some devagar.
    respawn: {
      count: 12,
      colors: [
        [80, 220, 255], // ciano
        [255, 255, 255], // branco
        [120, 160, 255], // azul claro
      ],
      sizeMin: 4,
      sizeMax: 7,
      speedMin: 80,
      speedMax: 200,
      angleMin: 0,
      angleMax: 360,
      spread: 0,
      lifeMin: 0.5,
      lifeMax: 0.9,
      gravityScale: 0.2,
    },

    // Poeira (aterrissagem/impacto no chão): leve, marrom/cinza, quase sem gravidade.
    // Sem direction vira uma nuvem radial; com direction, um sopro lateral.
    dust: {
      count: 8,
      colors: [
        [200, 195, 185], // cinza claro
        [175, 155, 135], // marrom claro
        [235, 230, 220], // areia
      ],
      sizeMin: 3,
      sizeMax: 6,
      speedMin: 40,
      speedMax: 110,
      angleMin: 0,
      angleMax: 360,
      spread: 45,
      lifeMin: 0.3,
      lifeMax: 0.6,
      gravityScale: 0.15,
    },
  },
};

// ===== Merge profundo de config (partial override) =====

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeDeep<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override)) {
    const b = out[key];
    const o = (override as Record<string, unknown>)[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? mergeDeep(b, o) : o;
  }
  return out as T;
}

// ===== Fábrica =====

/**
 * Cria o módulo de partículas ligado a um engine Kaplay (ou fake de teste).
 * Aceita um override parcial de DEFAULT_CONFIG (merge profundo).
 */
export function createParticles(
  engine: ParticlesEngine,
  config?: DeepPartial<ParticlesConfig>
): ParticlesHandle {
  const cfg = mergeDeep(DEFAULT_CONFIG, config ?? {});

  // Partículas vivas: o onUpdate de física itera este Set. A velocidade vive
  // no próprio objeto (obj.vel), como é costume com GameObj do Kaplay.
  interface ParticleState {
    obj: ParticleObj;
    gravityScale: number;
  }
  const live = new Set<ParticleState>();
  let physicsRegistered = false;

  /** Registra (uma única vez) o loop de física manual: gravidade + drag + integração. */
  function ensurePhysics(): void {
    if (physicsRegistered) return;
    physicsRegistered = true;
    engine.onUpdate(() => {
      const dt = engine.dt();
      for (const s of live) {
        const vel = s.obj.vel ?? { x: 0, y: 0 };
        // Gravidade (px/s²) e drag exponencial.
        vel.y += cfg.gravity * s.gravityScale * dt;
        const damp = Math.max(0, 1 - cfg.drag * dt);
        vel.x *= damp;
        vel.y *= damp;
        s.obj.pos.x += vel.x * dt;
        s.obj.pos.y += vel.y * dt;
      }
    });
  }

  /**
   * Gera um grupo de partículas.
   * @param dir direction explícita (graus) — ângulo = dir ± spread. Ausente → faixa completa angleMin..angleMax.
   */
  function burst(x: number, y: number, effect: EffectConfig, dir?: number): void {
    ensurePhysics();

    for (let i = 0; i < effect.count; i++) {
      const size = engine.rand(effect.sizeMin, effect.sizeMax);
      const speed = engine.rand(effect.speedMin, effect.speedMax);
      const angleDeg =
        dir !== undefined
          ? dir + engine.rand(-effect.spread, effect.spread)
          : engine.rand(effect.angleMin, effect.angleMax);
      const rad = (angleDeg * Math.PI) / 180;
      const vel: Vec2Like = {
        x: Math.cos(rad) * speed,
        y: Math.sin(rad) * speed,
      };
      const life = engine.rand(effect.lifeMin, effect.lifeMax);
      const rgb = effect.colors[engine.randInt(0, effect.colors.length - 1)];

      const obj = engine.add([
        engine.pos(x, y),
        engine.rect(size, size),
        engine.color(rgb[0], rgb[1], rgb[2]),
        engine.opacity(1),
        engine.z(cfg.z),
        engine.rotate(engine.rand(0, 360)),
      ]);
      obj.vel = vel;

      const state: ParticleState = { obj, gravityScale: effect.gravityScale };
      live.add(state);

      // Fade-out linear da vida inteira; ao final, remove do rastreio e destrói.
      engine.tween(
        1,
        0,
        life,
        (v) => {
          state.obj.opacity = v;
        },
        () => {
          live.delete(state);
          engine.destroy(state.obj);
        }
      );
    }
  }

  return {
    spawnShootImpact: (x, y) => burst(x, y, cfg.effects.shootImpact),
    spawnCoinCollect: (x, y) => burst(x, y, cfg.effects.coinCollect),
    spawnPowerUpCollect: (x, y) => burst(x, y, cfg.effects.powerUpCollect),
    spawnEnemyDeath: (x, y) => burst(x, y, cfg.effects.enemyDeath),
    spawnRespawn: (x, y) => burst(x, y, cfg.effects.respawn),
    spawnDust: (x, y, direction) => burst(x, y, cfg.effects.dust, direction),
  };
}
