import { describe, expect, it, vi } from "vitest";
import {
  createParticles,
  DEFAULT_CONFIG,
  type ParticleObj,
  type ParticlesEngine,
} from "./particles";

// ===== Fake estrutural do engine Kaplay =====
// O módulo não importa kaplay; o fake satisfaz ParticlesEngine e rastreia
// tudo que é criado (componentes, tweens, updates) para as asserções.
// rand() fixo em 0.5 → qualquer faixa [a, b] vira o ponto médio (a+b)/2;
// randInt() fixo em 0 → sempre a primeira cor da paleta (determinístico).

interface FakeParticle extends ParticleObj {
  vel: { x: number; y: number };
}

function makeFakeEngine() {
  const created: Array<{ comps: unknown[]; obj: FakeParticle }> = [];
  const tweens: Array<{
    from: number;
    to: number;
    dur: number;
    onUpdate: (v: number) => void;
    onEnd?: () => void;
  }> = [];
  const updates: Array<() => void> = [];

  const engine: ParticlesEngine = {
    add: vi.fn((comps: unknown[]) => {
      const obj = { pos: { x: 0, y: 0 }, opacity: 1, vel: { x: 0, y: 0 } };
      created.push({ comps, obj });
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ kind: "pos", x, y })),
    rect: vi.fn((w: number, h: number) => ({ kind: "rect", w, h })),
    color: vi.fn((r: number, g: number, b: number) => ({ kind: "color", rgb: [r, g, b] })),
    opacity: vi.fn((v: number) => ({ kind: "opacity", v })),
    z: vi.fn((v: number) => ({ kind: "z", v })),
    rotate: vi.fn((deg: number) => ({ kind: "rotate", deg })),
    rand: vi.fn((min: number, max: number) => min + 0.5 * (max - min)),
    randInt: vi.fn(() => 0),
    tween: vi.fn((from, to, dur, onUpdate, onEnd) => {
      tweens.push({ from, to, dur, onUpdate, onEnd });
    }),
    destroy: vi.fn(() => {}),
    onUpdate: vi.fn((fn: () => void) => {
      updates.push(fn);
    }),
    dt: vi.fn(() => 1 / 60),
  };

  return { engine, created, tweens, updates };
}

/** Busca um componente pelo `kind` no array criado; lança se não existir. */
function comp<T>(entry: { comps: unknown[]; obj: FakeParticle }, kind: string): T {
  const c = (entry.comps as Array<{ kind: string; [k: string]: unknown }>).find(
    (x) => x.kind === kind
  );
  if (!c) throw new Error(`component ${kind} not found`);
  return c as unknown as T;
}

/** Completa todos os tweens vivos (simula o fim da vida das partículas). */
function finishAllTweens(tweens: Array<{ onUpdate: (v: number) => void; onEnd?: () => void }>) {
  for (const t of tweens) {
    t.onUpdate(0);
    t.onEnd?.();
  }
}

describe("createParticles — spawns", () => {
  it("cada spawn cria exatamente a quantidade configurada de partículas", () => {
    const { engine, created } = makeFakeEngine();
    const p = createParticles(engine);

    p.spawnShootImpact(10, 20);
    p.spawnCoinCollect(30, 40);
    p.spawnEnemyDeath(50, 60);
    p.spawnRespawn(70, 80);
    p.spawnDust(90, 100);

    const total =
      DEFAULT_CONFIG.effects.shootImpact.count +
      DEFAULT_CONFIG.effects.coinCollect.count +
      DEFAULT_CONFIG.effects.enemyDeath.count +
      DEFAULT_CONFIG.effects.respawn.count +
      DEFAULT_CONFIG.effects.dust.count;
    expect(created.length).toBe(total);

    // Efeito a efeito (o fake cria na ordem dos spawns):
    const eff = DEFAULT_CONFIG.effects;
    expect(created.slice(0, eff.shootImpact.count).length).toBe(eff.shootImpact.count);
    expect(
      created
        .slice(eff.shootImpact.count, eff.shootImpact.count + eff.coinCollect.count)
        .length
    ).toBe(eff.coinCollect.count);
    expect(engine.add).toHaveBeenCalledTimes(total);
  });

  it("partículas são rects coloridos da paleta, com z configurado e opacidade inicial 1", () => {
    const { engine, created } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnShootImpact(10, 20);

    const first = created[0];
    expect(comp(first, "rect")).toBeDefined();
    const colorComp = comp<{ rgb: number[] }>(first, "color");
    expect(colorComp.rgb).toEqual([...DEFAULT_CONFIG.effects.shootImpact.colors[0]]);
    const zComp = comp<{ v: number }>(first, "z");
    expect(zComp.v).toBe(DEFAULT_CONFIG.z);
    const opacityComp = comp<{ v: number }>(first, "opacity");
    expect(opacityComp.v).toBe(1);
    // Tamanho no meio da faixa (rand = 0.5).
    const rectComp = comp<{ w: number; h: number }>(first, "rect");
    const eff = DEFAULT_CONFIG.effects.shootImpact;
    expect(rectComp.w).toBe((eff.sizeMin + eff.sizeMax) / 2);
    expect(rectComp.h).toBe(rectComp.w);
  });

  it("cada partícula agenda um tween de fade 1→0 com vida dentro da faixa configurada", () => {
    const { engine, tweens } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnCoinCollect(0, 0);

    expect(tweens.length).toBe(DEFAULT_CONFIG.effects.coinCollect.count);
    const eff = DEFAULT_CONFIG.effects.coinCollect;
    for (const t of tweens) {
      expect(t.from).toBe(1);
      expect(t.to).toBe(0);
      expect(t.dur).toBe((eff.lifeMin + eff.lifeMax) / 2);
    }
  });

  it("ao completar o tween a partícula é destruída (aparece e some)", () => {
    const { engine, created, tweens } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnEnemyDeath(5, 5);

    expect(engine.destroy).not.toHaveBeenCalled();
    finishAllTweens(tweens);
    expect(engine.destroy).toHaveBeenCalledTimes(created.length);
    for (const { obj } of created) {
      expect(engine.destroy).toHaveBeenCalledWith(obj);
    }
  });

  it("a física (gravidade) move a partícula ao longo do tempo", () => {
    const { engine, created, updates } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnShootImpact(100, 200);

    const physics = updates[0];
    expect(physics).toBeDefined();
    const s = created[0].obj;
    const eff = DEFAULT_CONFIG.effects.shootImpact;
    // rand = 0.5 → ângulo = (angleMin+angleMax)/2 = 180° → vel = (-speed, ~0)
    const speed = (eff.speedMin + eff.speedMax) / 2;
    expect(s.vel.x).toBeCloseTo(-speed, 5);
    expect(s.vel.y).toBeCloseTo(0, 5);

    const y0 = s.pos.y;
    physics(); // dt = 1/60
    // Gravidade + drag: vel.y += g*scale*dt, depois damp exponencial.
    const dt = 1 / 60;
    const damp = Math.max(0, 1 - DEFAULT_CONFIG.drag * dt);
    expect(s.vel.y).toBeCloseTo((980 * eff.gravityScale * dt) * damp, 5);
    expect(s.pos.y).toBeGreaterThan(y0);
  });

  it("após o fim da vida a partícula sai do loop de física (não move mais)", () => {
    const { engine, created, tweens, updates } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnShootImpact(0, 0);

    const physics = updates[0];
    const s = created[0].obj;
    const posBefore = { ...s.pos };
    finishAllTweens(tweens);
    physics(); // roda a física mesmo assim
    expect(s.pos).toEqual(posBefore); // pos não muda mais (fora do Set)
  });

  it("registra apenas um onUpdate de física mesmo com vários spawns", () => {
    const { engine, updates } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnShootImpact(0, 0);
    p.spawnCoinCollect(0, 0);
    p.spawnEnemyDeath(0, 0);
    expect(updates.length).toBe(1);
  });
});

describe("spawnDust com direction", () => {
  it("com direction, a velocidade aponta para dir ± 0 (rand fixo = 0.5)", () => {
    const { engine, created } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnDust(0, 0, 90); // 90° = para baixo

    const eff = DEFAULT_CONFIG.effects.dust;
    const speed = (eff.speedMin + eff.speedMax) / 2;
    for (const { obj } of created) {
      expect(obj.vel.x).toBeCloseTo(Math.cos((90 * Math.PI) / 180) * speed, 5);
      expect(obj.vel.y).toBeCloseTo(Math.sin((90 * Math.PI) / 180) * speed, 5);
    }
  });

  it("sem direction, usa a faixa completa de ângulos (nuvem radial)", () => {
    const { engine, created } = makeFakeEngine();
    const p = createParticles(engine);
    p.spawnDust(0, 0);

    const eff = DEFAULT_CONFIG.effects.dust;
    const speed = (eff.speedMin + eff.speedMax) / 2;
    const mid = (eff.angleMin + eff.angleMax) / 2; // 180° com rand = 0.5
    for (const { obj } of created) {
      expect(obj.vel.x).toBeCloseTo(Math.cos((mid * Math.PI) / 180) * speed, 5);
    }
  });
});

describe("createParticles — configuração", () => {
  it("override parcial de config (merge profundo) muda quantidade e cores", () => {
    const { engine, created } = makeFakeEngine();
    const p = createParticles(engine, {
      effects: {
        dust: {
          count: 3,
          colors: [[1, 2, 3]],
        },
      },
    });
    p.spawnDust(0, 0);

    expect(created.length).toBe(3);
    for (const entry of created) {
      const c = comp<{ rgb: number[] }>(entry, "color");
      expect(c.rgb).toEqual([1, 2, 3]);
    }
    // Campos não sobrescritos continuam com o default:
    expect(comp(created[0], "z")).toBeDefined();
  });

  it("override do z global é aplicado", () => {
    const { engine, created } = makeFakeEngine();
    const p = createParticles(engine, { z: 99 });
    p.spawnShootImpact(0, 0);
    expect(comp<{ v: number }>(created[0], "z").v).toBe(99);
  });
});
