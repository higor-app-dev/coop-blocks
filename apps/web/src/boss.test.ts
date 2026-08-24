import { describe, expect, it, vi } from "vitest";
import {
  BOSS_COLORS,
  BOSS_HEIGHT,
  BOSS_WIDTH,
  createBossLayer,
  type BossLayer,
} from "./boss";
import type { NetBoss } from "./net";

// ===== Fake estrutural do engine Kaplay =====
// A camada só toca add/pos/rect/color/z/destroy e muta pos/color/campos
// custom do objeto; o fake rastreia criação/destruição e reflete as mutações.

interface FakeBossObj {
  tags: string[];
  pos: { x: number; y: number };
  color: { r: number; g: number; b: number };
  bossId?: string;
  bossState?: string;
  bossHp?: number;
  bossMaxHp?: number;
  bossPhase?: number;
  exists(): boolean;
}

function makeFakeKaplay() {
  const created: FakeBossObj[] = [];
  const destroyed: FakeBossObj[] = [];
  const k = {
    add: vi.fn((comps: unknown[]) => {
      const obj: FakeBossObj = {
        tags: comps.filter((c): c is string => typeof c === "string"),
        pos: { x: 0, y: 0 },
        color: { r: 0, g: 0, b: 0 },
        exists: () => true,
      };
      const posComp = comps.find(
        (c): c is { x: number; y: number } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { x?: unknown }).x === "number" &&
          typeof (c as { y?: unknown }).y === "number"
      );
      if (posComp) obj.pos = { x: posComp.x, y: posComp.y };
      const colorComp = comps.find(
        (c): c is { r: number; g: number; b: number } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { r?: unknown }).r === "number"
      );
      if (colorComp) obj.color = { r: colorComp.r, g: colorComp.g, b: colorComp.b };
      const custom = comps.find(
        (c): c is Record<string, unknown> =>
          typeof c === "object" &&
          c !== null &&
          "bossId" in (c as Record<string, unknown>)
      );
      if (custom) {
        obj.bossId = custom.bossId as string;
        obj.bossState = custom.bossState as string;
        obj.bossHp = custom.bossHp as number;
        obj.bossMaxHp = custom.bossMaxHp as number;
        obj.bossPhase = custom.bossPhase as number;
      }
      created.push(obj);
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ x, y })),
    rect: vi.fn((w: number, h: number) => ({ kind: "rect", w, h })),
    color: vi.fn((r: number, g: number, b: number) => ({ r, g, b })),
    z: vi.fn((v: number) => ({ kind: "z", v })),
    destroy: vi.fn((obj: FakeBossObj) => {
      destroyed.push(obj);
    }),
  };
  return { k, created, destroyed };
}

function boss(overrides: Partial<NetBoss> = {}): NetBoss {
  return {
    id: "boss",
    x: 5472,
    y: 288,
    hp: 400,
    maxHp: 400,
    state: "idle",
    phase: 5,
    ...overrides,
  };
}

// ===== Camada kaplay — criação e sincronização =====

describe("createBossLayer — apply (estado do servidor)", () => {
  it("cria um único bloco gigante na posição broadcastada com visual do estado", () => {
    const { k, created } = makeFakeKaplay();
    const layer = createBossLayer(k as never);
    layer.apply(boss({ x: 5472, y: 288, state: "investida" }));

    expect(created).toHaveLength(1);
    const o = created[0];
    expect(o.tags).toContain("boss");
    expect(o.pos).toEqual({ x: 5472, y: 288 });
    expect(k.rect).toHaveBeenCalledWith(BOSS_WIDTH, BOSS_HEIGHT, { radius: 8 });
    expect(k.z).toHaveBeenCalledWith(4);
    // Cor do estado "investida" (vermelho vivo); idle/salto têm as próprias.
    expect(o.color).toEqual({ r: BOSS_COLORS.investida[0], g: BOSS_COLORS.investida[1], b: BOSS_COLORS.investida[2] });
    expect(o.bossId).toBe("boss");
    expect(o.bossState).toBe("investida");
    expect(o.bossHp).toBe(400);
    expect(o.bossMaxHp).toBe(400);
    expect(o.bossPhase).toBe(5);
    expect(layer.active()).toBe(true);
  });

  it("atualiza posição/HP/estado no MESMO objeto (sem recriar) a cada broadcast", () => {
    const { k, created } = makeFakeKaplay();
    const layer = createBossLayer(k as never);
    layer.apply(boss({ x: 5000, y: 300, state: "idle", hp: 400 }));

    // Investida: boss avança e toma dano.
    layer.apply(boss({ x: 5230, y: 300, state: "investida", hp: 375 }));
    layer.apply(boss({ x: 5450, y: 300, state: "salto", hp: 350 }));

    expect(created).toHaveLength(1); // nunca recriou
    const o = created[0];
    expect(o.pos).toEqual({ x: 5450, y: 300 });
    expect(o.bossState).toBe("salto");
    expect(o.bossHp).toBe(350);
    expect(o.color).toEqual({ r: BOSS_COLORS.salto[0], g: BOSS_COLORS.salto[1], b: BOSS_COLORS.salto[2] });
    expect(layer.hp()).toBe(350);
    expect(layer.maxHp()).toBe(400);
    expect(layer.state()).toBe("salto");
    expect(layer.phase()).toBe(5);
    // Color do kaplay é mutado no lugar (objeto color), não recriado.
    expect(k.color).toHaveBeenCalledTimes(1);
  });

  it("estado desconhecido cai no visual idle (guarda defensiva)", () => {
    const { k, created } = makeFakeKaplay();
    const layer = createBossLayer(k as never);
    layer.apply(boss({ state: "teleporte" }));
    expect(created[0].color).toEqual({ r: BOSS_COLORS.idle[0], g: BOSS_COLORS.idle[1], b: BOSS_COLORS.idle[2] });
  });

  it("apply(null) destrói o bloco, zera o estado e dispara onClear", () => {
    const { k, destroyed } = makeFakeKaplay();
    const onClear = vi.fn();
    const layer = createBossLayer(k as never, { onClear });
    layer.apply(boss());
    expect(layer.active()).toBe(true);

    layer.apply(null);

    expect(destroyed).toHaveLength(1);
    expect(layer.active()).toBe(false);
    expect(layer.hp()).toBeNull();
    expect(layer.maxHp()).toBeNull();
    expect(layer.state()).toBeNull();
    expect(layer.phase()).toBeNull();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("apply(null) sem boss é no-op (não destrói nem dispara onClear)", () => {
    const { k, destroyed } = makeFakeKaplay();
    const onClear = vi.fn();
    const layer = createBossLayer(k as never, { onClear });
    layer.apply(null);
    expect(destroyed).toHaveLength(0);
    expect(onClear).not.toHaveBeenCalled();
    expect(layer.active()).toBe(false);
  });
});

describe("createBossLayer — clear (reconstrução de mundo)", () => {
  it("clear destrói o bloco e zera o estado; idempotente", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createBossLayer(k as never);
    layer.apply(boss());
    layer.clear();
    expect(destroyed).toHaveLength(1);
    expect(layer.active()).toBe(false);
    expect(layer.hp()).toBeNull();
    // Clear de novo (sem boss) é no-op.
    layer.clear();
    expect(destroyed).toHaveLength(1);
  });

  it("clear NÃO dispara onClear (só a ausência via broadcast dispara)", () => {
    const { k } = makeFakeKaplay();
    const onClear = vi.fn();
    const layer = createBossLayer(k as never, { onClear });
    layer.apply(boss());
    layer.clear();
    expect(onClear).not.toHaveBeenCalled();
  });
});

// Garante que o contrato da camada está completo (o main.ts e o card do HUD usam todos).
describe("createBossLayer — contrato", () => {
  it("expõe apply/clear/active/hp/maxHp/state/phase", () => {
    const { k } = makeFakeKaplay();
    const layer: BossLayer = createBossLayer(k as never);
    for (const method of ["apply", "clear", "active", "hp", "maxHp", "state", "phase"] as const) {
      expect(typeof layer[method]).toBe("function");
    }
  });
});
