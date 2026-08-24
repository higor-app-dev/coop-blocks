import { describe, expect, it, vi } from "vitest";
import { createPlayer, type PlayerObject } from "./player";
import type { KAPLAYCtx } from "kaplay";

// ===== Fake estrutural do engine Kaplay =====
// O player.ts importa kaplay apenas como tipo; o fake satisfaz o subconjunto
// usado por createPlayer (add/pos/rect/color/area/body/scale/z/destroy) e
// rastreia objetos criados, danos e eventos para as asserções.

interface FakeObj extends PlayerObject {
  move: ReturnType<typeof vi.fn>;
  jump: ReturnType<typeof vi.fn>;
  isGrounded: ReturnType<typeof vi.fn>;
  trigger: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
  onCollide: ReturnType<typeof vi.fn>;
  onDestroy: ReturnType<typeof vi.fn>;
}

function makeFakeEngine() {
  const created: Array<{ comps: unknown[]; obj: FakeObj }> = [];
  const destroyed: FakeObj[] = [];
  const handlers: Array<{ event: string; fn: (...a: unknown[]) => void }> = [];

  const engine = {
    add: vi.fn((comps: unknown[]) => {
      // O último componente do createPlayer é o behavior (métodos do player).
      const behavior = (comps[comps.length - 1] ?? {}) as Record<string, unknown>;
      const posComp = comps.find(
        (c) => typeof c === "object" && c !== null && "kind" in (c as object) && (c as { kind: string }).kind === "pos"
      ) as { x: number; y: number } | undefined;
      const obj = {
        ...behavior,
        pos: { x: posComp?.x ?? 0, y: posComp?.y ?? 0 },
        move: vi.fn(),
        jump: vi.fn(),
        isGrounded: vi.fn(() => true),
        trigger: vi.fn(),
        onUpdate: vi.fn(),
        onCollide: vi.fn(),
        onDestroy: vi.fn((fn: () => void) => {
          handlers.push({ event: "destroy", fn });
        }),
        hidden: false,
        paused: false,
        exists: vi.fn(() => true),
      } as unknown as FakeObj;
      created.push({ comps, obj });
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ kind: "pos", x, y })),
    rect: vi.fn((w: number, h: number) => ({ kind: "rect", w, h })),
    color: vi.fn((r: number, g: number, b: number) => ({ kind: "color", r, g, b })),
    area: vi.fn(() => ({ kind: "area" })),
    body: vi.fn(() => ({ kind: "body" })),
    scale: vi.fn((s: number) => ({ kind: "scale", s })),
    z: vi.fn((v: number) => ({ kind: "z", v })),
    destroy: vi.fn((obj: FakeObj) => {
      destroyed.push(obj);
    }),
  };

  return { engine: engine as unknown as KAPLAYCtx, created, destroyed };
}

describe("createPlayer — estrutura e HP", () => {
  it("nasce com HP = maxHp (100) e velocidade padrão", () => {
    const { engine, created } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 10, y: 20 }, maxHp: 100 });
    expect(p.hp).toBe(100);
    expect(p.speed).toBe(320);
    expect(p.facing).toBe(1);
    expect(created[0].obj.pos).toEqual({ x: 10, y: 20 });
  });

  it("adiciona o player com as tags/componentes esperados", () => {
    const { engine, created } = makeFakeEngine();
    createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    const comps = created[0].comps;
    expect(comps).toContain("player");
    const kinds = comps
      .filter((c) => typeof c === "object" && c !== null && "kind" in (c as object))
      .map((c) => (c as { kind: string }).kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["pos", "rect", "color", "area", "body", "scale", "z"])
    );
  });
});

describe("movePlayer — movimento", () => {
  it("anda para a direita com facing 1 e speed 320", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.movePlayer(1);
    expect(p.facing).toBe(1);
    expect(p.move).toHaveBeenCalledWith(320, 0);
  });

  it("anda para a esquerda com facing -1", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.movePlayer(-1);
    expect(p.facing).toBe(-1);
    expect(p.move).toHaveBeenCalledWith(-320, 0);
  });

  it("direção 0 não altera o facing", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.movePlayer(1);
    p.movePlayer(0);
    expect(p.facing).toBe(1);
  });
});

describe("jumpPlayer — pulo", () => {
  it("pula com força padrão 520 quando grounded", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.isGrounded.mockReturnValue(true);
    p.jumpPlayer();
    expect(p.jump).toHaveBeenCalledWith(520);
  });

  it("aceita força customizada", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.isGrounded.mockReturnValue(true);
    p.jumpPlayer(700);
    expect(p.jump).toHaveBeenCalledWith(700);
  });

  it("não pula no ar (isGrounded false)", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.isGrounded.mockReturnValue(false);
    p.jumpPlayer();
    expect(p.jump).not.toHaveBeenCalled();
  });
});

describe("shoot — tiro", () => {
  it("cria projétil com velocidade e dano na direção do facing", () => {
    const { engine, created } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 100, y: 200 }, maxHp: 100 });
    p.shoot();
    // A bala é o segundo objeto criado (o player é o primeiro).
    const bullet = created[1];
    expect(bullet).toBeDefined();
    expect(bullet.comps).toContain("bullet");
    const meta = bullet.obj as unknown as { vel: number; damage: number };
    expect(meta.vel).toBe(560);
    expect(meta.damage).toBe(25);
    expect(bullet.obj.pos.x).toBeGreaterThan(100); // nasce à frente do player
  });

  it("projétil aponta para a esquerda quando facing -1", () => {
    const { engine, created } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 100, y: 200 }, maxHp: 100 });
    p.facing = -1;
    p.shoot();
    const bullet = created[1];
    const meta = bullet.obj as unknown as { vel: number };
    expect(meta.vel).toBe(-560);
    expect(bullet.obj.pos.x).toBeLessThan(100);
  });
});

describe("takeDamage — dano e morte", () => {
  it("reduz o HP pelo valor do dano e notifica onHpChange", () => {
    const { engine } = makeFakeEngine();
    const onHpChange = vi.fn();
    const p = createPlayer(engine, {
      pos: { x: 0, y: 0 },
      maxHp: 100,
      onHpChange,
    });
    p.takeDamage(30);
    expect(p.hp).toBe(70);
    expect(onHpChange).toHaveBeenCalledWith(70);
  });

  it("não dispara death antes de zerar o HP", () => {
    const { engine } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.takeDamage(99);
    expect(p.hp).toBe(1);
    expect(p.trigger).not.toHaveBeenCalledWith("death");
  });

  it("HP <= 0 dispara o evento death e destrói o objeto", () => {
    const { engine, destroyed } = makeFakeEngine();
    const p = createPlayer(engine, { pos: { x: 0, y: 0 }, maxHp: 100 });
    p.takeDamage(100);
    expect(p.hp).toBe(0);
    expect(p.trigger).toHaveBeenCalledWith("death");
    expect(destroyed).toContain(p);
  });
});
