import { describe, expect, it } from "vitest";
import {
  BOSS_AOE_RADIUS,
  BOSS_ATTACK_INTERVAL_S,
  BOSS_COIN_DROP,
  BOSS_CONTACT_COOLDOWN_S,
  BOSS_DASH_DAMAGE,
  BOSS_DASH_S,
  BOSS_DASH_SPEED,
  BOSS_HEIGHT,
  BOSS_JUMP_DAMAGE,
  BOSS_JUMP_SPEED_H,
  BOSS_JUMP_SPEED_V,
  BOSS_MAX_HP,
  BOSS_PHASE_STEP,
  BOSS_WIDTH,
  POWERUP_TRIPLE_S,
  POWERUP_VIDA_BONUS,
  SOLO_BASE_SEED,
  SOLO_GROUND_Y,
  SOLO_WORLD_HEIGHT,
  SOLO_WORLD_WIDTH,
  applySoloBossDamage,
  collectSoloPowerUps,
  createSoloBoss,
  createSoloRunState,
  emptySoloEffects,
  soloApplyBuy,
  soloBossSnapshot,
  soloBuy,
  soloFireCooldownMs,
  spawnSoloPowerUps,
  stepSoloBoss,
  type SoloBoss,
  type SoloPlayer,
  type SoloRunState,
  type SoloWorld,
} from "./solo";

const world: SoloWorld = {
  width: SOLO_WORLD_WIDTH,
  height: SOLO_WORLD_HEIGHT,
  groundY: SOLO_GROUND_Y,
};

function player(id: string, x: number, y: number, hp = 100): SoloPlayer {
  return { id, x, y, w: 28, h: 40, hp };
}

/** Avança o boss N ticks (50 ms cada) e devolve todos os eventos. */
function stepTicks(b: SoloBoss, players: SoloPlayer[], ticks: number) {
  const events = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...stepSoloBoss(b, players, world, 0.05));
  }
  return events;
}

// ===== createSoloBoss — régua de aparição =====

describe("createSoloBoss — régua de aparição", () => {
  it("spawna apenas em fases múltiplas de BOSS_PHASE_STEP", () => {
    for (const phase of [1, 2, 4, 6, 7, 11]) {
      expect(createSoloBoss(phase, world, phase)).toBeNull();
    }
    for (const phase of [5, 10, 15, 20]) {
      const b = createSoloBoss(phase, world, phase);
      expect(b).not.toBeNull();
      expect(b!.phase).toBe(phase);
    }
  });

  it("nasce no meio do mapa, pés no chão, HP cheio, em idle", () => {
    const b = createSoloBoss(5, world, 5)!;
    expect(b.x).toBe(SOLO_WORLD_WIDTH / 2 - BOSS_WIDTH / 2);
    expect(b.y).toBe(SOLO_GROUND_Y - BOSS_HEIGHT);
    expect(b.hp).toBe(BOSS_MAX_HP);
    expect(b.maxHp).toBe(BOSS_MAX_HP);
    expect(b.state).toBe("idle");
    expect(b.attackIn).toBe(BOSS_ATTACK_INTERVAL_S);
  });

  it("determinístico: mesma fase+seed ⇒ mesma sequência de ataques", () => {
    const a = createSoloBoss(5, world, 42)!;
    const b = createSoloBoss(5, world, 42)!;
    const seqA = stepTicks(a, [player("local", 500, 400)], 400).map((e) => e.type);
    const seqB = stepTicks(b, [player("local", 500, 400)], 400).map((e) => e.type);
    expect(seqB).toEqual(seqA);
  });
});

// ===== stepSoloBoss — ciclo idle → ataque =====

describe("stepSoloBoss — ciclo de ataques", () => {
  it("fica idle por BOSS_ATTACK_INTERVAL_S e então ataca", () => {
    const b = createSoloBoss(5, world, 5)!;
    const target = player("local", b.x + b.w + 50, b.y + b.h / 2);
    stepTicks(b, [target], Math.floor(BOSS_ATTACK_INTERVAL_S / 0.05) - 1);
    expect(b.state).toBe("idle");
    stepTicks(b, [target], 1);
    expect(["investida", "salto"]).toContain(b.state);
  });

  /** Força o boss para um estado de ataque (determinístico, sem depender do RNG). */
  function forceAttack(b: SoloBoss, state: "investida" | "salto", vx?: number): void {
    b.state = state;
    b.grounded = false;
    b.landed = false;
    if (state === "investida") {
      b.dashIn = BOSS_DASH_S;
      b.vx = vx ?? b.dir * BOSS_DASH_SPEED;
      b.vy = 0;
      b.grounded = true;
    } else {
      b.dashIn = 0;
      b.vx = vx ?? b.dir * BOSS_JUMP_SPEED_H;
      b.vy = -BOSS_JUMP_SPEED_V;
    }
  }

  it("investida: dano por contato na hitbox, respeitando o cooldown pós-contato", () => {
    const b = createSoloBoss(5, world, 5)!;
    forceAttack(b, "investida");
    // Estende a investida além do cooldown pós-contato (30 ticks) para testar
    // a re-aplicação do dano na MESMA investida — com o dash padrão (24
    // ticks) o boss voltaria ao idle antes do cooldown expirar.
    b.dashIn = 10;
    expect(b.state).toBe("investida");

    // Jogador que acompanha a hitbox do boss (o boss se move durante a
    // investida — o jogador do teste fica grudado na frente dele).
    const inside = () => player("local", b.x + 10, b.y + 10);
    const stepInside = (ticks: number) => {
      const events = [];
      for (let i = 0; i < ticks; i++) {
        events.push(...stepSoloBoss(b, [inside()], world, 0.05));
      }
      return events;
    };

    // Primeiro contato causa dano.
    const hits1 = stepInside(2).filter((e) => e.type === "playerHit");
    expect(hits1.length).toBeGreaterThan(0);
    expect(hits1[0].damage).toBe(BOSS_DASH_DAMAGE);

    // Cooldown pós-contato: contatos seguidos não repetem dano imediato.
    const hits2 = stepInside(5).filter((e) => e.type === "playerHit");
    expect(hits2.length).toBe(0);

    // Após o cooldown (1,5 s) o contato volta a causar dano.
    const cdTicks = Math.ceil(BOSS_CONTACT_COOLDOWN_S / 0.05);
    const hits3 = stepInside(cdTicks + 1).filter((e) => e.type === "playerHit");
    expect(hits3.length).toBeGreaterThan(0);
  });

  it("investida: quica nas bordas do mundo e volta ao idle", () => {
    const b = createSoloBoss(5, world, 5)!;
    b.dir = -1;
    b.x = 10; // perto da borda esquerda
    forceAttack(b, "investida");
    const before = b.dir;
    stepTicks(b, [player("local", 500, 400)], 5);
    expect(b.dir).toBe(-before); // virou
    expect(b.x).toBeGreaterThanOrEqual(0);
    // A investida dura BOSS_DASH_S (24 ticks) — após ela o boss volta ao idle.
    stepTicks(b, [player("local", 500, 400)], 19); // 5 + 19 = 24 ticks
    expect(b.state).toBe("idle");
    expect(b.attackIn).toBeCloseTo(BOSS_ATTACK_INTERVAL_S, 5);
  });

  it("salto: sem dano no ar; dano em área ao aterrissar (raio BOSS_AOE_RADIUS)", () => {
    const b = createSoloBoss(5, world, 5)!;
    // Salto VERTICAL (vx = 0) para aterrissar no mesmo lugar — determinístico.
    const spawnX = b.x;
    forceAttack(b, "salto", 0);
    expect(b.state).toBe("salto");

    // Jogador dentro da hitbox durante o arco: sem dano de contato no ar.
    const near = player("local", b.x + 20, b.y + 20);
    const midHits = stepTicks(b, [near], 10).filter((e) => e.type === "playerHit");
    expect(midHits.length).toBe(0);

    // Jogador no centro dos pés NO CHÃO (o boss aterrissa no mesmo ponto):
    // dano em área quando aterrissa (~1,26 s no ar).
    const t2 = player("local", spawnX + BOSS_WIDTH / 2, world.groundY);
    const all = stepTicks(b, [t2], Math.ceil(1.5 / 0.05)).filter((e) => e.type === "playerHit");
    expect(all.length).toBeGreaterThan(0);
    expect(all[0].damage).toBe(BOSS_JUMP_DAMAGE);
    expect(b.state).toBe("idle");
    expect(b.grounded).toBe(true);
  });

  it("jogador morto não toma dano de contato", () => {
    const b = createSoloBoss(5, world, 5)!;
    b.state = "investida";
    b.dashIn = 1.2;
    const dead = player("local", b.x + 10, b.y + 10, 0);
    const hits = stepTicks(b, [dead], 5).filter((e) => e.type === "playerHit");
    expect(hits.length).toBe(0);
  });
});

// ===== applySoloBossDamage — derrota + drop =====

describe("applySoloBossDamage — derrota", () => {
  it("dano acumula e derrota devolve o drop gordo na posição final", () => {
    const b = createSoloBoss(5, world, 5)!;
    const shots = Math.ceil(BOSS_MAX_HP / 25);
    let defeated = false;
    for (let i = 0; i < shots; i++) {
      const evs = applySoloBossDamage(b, 25);
      for (const ev of evs) {
        if (ev.type === "defeated") {
          defeated = true;
          expect(ev.coins).toBe(BOSS_COIN_DROP);
          expect(ev.x).toBe(b.x);
          expect(ev.y).toBe(b.y);
        }
      }
    }
    expect(defeated).toBe(true);
    expect(b.hp).toBe(0);
  });

  it("boss vivo com HP restante não emite evento", () => {
    const b = createSoloBoss(5, world, 5)!;
    const evs = applySoloBossDamage(b, 25);
    expect(evs.length).toBe(0);
    expect(b.hp).toBe(BOSS_MAX_HP - 25);
  });
});

// ===== soloBossSnapshot =====

describe("soloBossSnapshot — wire", () => {
  it("converte o boss para o formato do broadcast (NetBoss)", () => {
    const b = createSoloBoss(5, world, 5)!;
    const snap = soloBossSnapshot(b)!;
    expect(snap).toMatchObject({ id: "boss", state: "idle", phase: 5 });
    expect(snap.hp).toBe(BOSS_MAX_HP);
    expect(snap.maxHp).toBe(BOSS_MAX_HP);
    expect(snap.x).toBe(Math.round(b.x));
    expect(snap.y).toBe(Math.round(b.y));
  });

  it("null sem boss", () => {
    expect(soloBossSnapshot(null)).toBeNull();
  });
});

// ===== spawnSoloPowerUps / collectSoloPowerUps =====

describe("power-ups — spawn e coleta", () => {
  it("registra IDs p1..pN na ordem do gerador (mesmas posições do servidor)", () => {
    const powerUps = spawnSoloPowerUps([
      { x: 8, y: 8, kind: "vida" },
      { x: 20, y: 6, kind: "tiro_triplo" },
      { x: 30, y: 7, kind: "escudo" },
    ]);
    expect(powerUps.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(powerUps.map((p) => p.kind)).toEqual(["vida", "tiro_triplo", "escudo"]);
    // Posição espelhando o servidor: centro da coluna, flutuando 36px.
    expect(powerUps[0].x).toBe(8 * 48 + 24 - 10);
    expect(powerUps[0].y).toBe(8 * 48 - 36 - 10);
  });

  it("coleta por sobreposição AABB e remove do array", () => {
    const powerUps = spawnSoloPowerUps([
      { x: 8, y: 8, kind: "vida" },
      { x: 20, y: 6, kind: "tiro_triplo" },
      { x: 30, y: 7, kind: "escudo" },
    ]);
    // Power-up p1: centro da coluna 8, flutuando 36px acima do topo do tile.
    // O jogador precisa sobrepor a hitbox 20x20 dele (pulando até lá).
    const p1 = powerUps[0];
    const collected = collectSoloPowerUps(
      powerUps,
      player("local", p1.x - 5, p1.y - 5, 100)
    );
    expect(collected.map((p) => p.kind)).toEqual(["vida"]);
    expect(powerUps.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("jogador morto não coleta", () => {
    const powerUps = spawnSoloPowerUps([{ x: 8, y: 8, kind: "vida" }]);
    const collected = collectSoloPowerUps(powerUps, player("local", 8 * 48, 8 * 48, 0));
    expect(collected.length).toBe(0);
    expect(powerUps.length).toBe(1);
  });
});

// ===== Run state (fase/carteira/stats/loja) =====

describe("run state — fase, carteira, stats, loja", () => {
  it("estado inicial: fase 1, carteira 0, stats base, sem pausa/morte", () => {
    const run = createSoloRunState();
    expect(run).toEqual({
      phase: 1,
      wallet: 0,
      stats: { maxHp: 100, fireRate: 1, shield: 0 },
      paused: false,
      transitioning: false,
      dead: false,
      teamCoins: 0,
    });
  });

  it("soloBuy valida como o servidor e debita a carteira", () => {
    const run: SoloRunState = createSoloRunState({ wallet: 100 });
    const res = soloBuy(run, "max_hp");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.wallet).toBe(50);
      expect(res.stats.maxHp).toBe(125);
      expect(res.receipt.level).toBe(1);
    }
  });

  it("soloApplyBuy é imutável e aplica o upgrade nas stats", () => {
    const run = createSoloRunState({ wallet: 100 });
    const next = soloApplyBuy(run, "fire_rate");
    expect(run.wallet).toBe(100); // original intacto
    expect(next.wallet).toBe(60);
    expect(next.stats.fireRate).toBe(1.2);
    expect(run.stats.fireRate).toBe(1);
  });

  it("soloBuy rejeita saldo insuficiente com a mesma semântica do servidor", () => {
    const run = createSoloRunState({ wallet: 10 });
    const res = soloBuy(run, "max_hp");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("moedas insuficientes");
  });

  it("soloFireCooldownMs espelha o servidor (150ms / fire_rate)", () => {
    expect(soloFireCooldownMs(createSoloRunState())).toBe(150);
    expect(soloFireCooldownMs({ ...createSoloRunState(), stats: { maxHp: 100, fireRate: 1.5, shield: 0 } })).toBeCloseTo(100, 5);
  });

  it("emptySoloEffects devolve efeitos zerados", () => {
    expect(emptySoloEffects()).toEqual({ vida: 0, tripleShot: 0, shield: 0 });
  });
});

// ===== Garantia: sem rede =====

describe("solo.ts — sem rede (aceite do card)", () => {
  it("SOLO_BASE_SEED é a mesma do servidor (baseSeed=1)", () => {
    expect(SOLO_BASE_SEED).toBe(1);
  });

  it("constantes de relógio espelham os ticks do servidor", () => {
    expect(BOSS_ATTACK_INTERVAL_S).toBeCloseTo(4.5, 5);
    expect(BOSS_DASH_S).toBeCloseTo(1.2, 5);
    expect(BOSS_CONTACT_COOLDOWN_S).toBeCloseTo(1.5, 5);
    expect(POWERUP_TRIPLE_S).toBeCloseTo(10, 5);
    expect(POWERUP_VIDA_BONUS).toBe(25);
  });
});
