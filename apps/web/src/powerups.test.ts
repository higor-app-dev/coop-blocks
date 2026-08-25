import { describe, expect, it, vi } from "vitest";
import { TILE } from "./levelgen";
import {
  POWERUP_FLOAT_HEIGHT,
  POWERUP_HEIGHT,
  POWERUP_WIDTH,
  createPowerUpLayer,
  levelPowerUp,
  type PowerUpLayer,
} from "./powerups";

// ===== Fake estrutural do engine Kaplay =====
// A camada só toca add/pos/rect/color/outline/z/destroy; o fake rastreia os
// objetos criados/destruídos e expõe exists() para os guards defensivos.

interface FakePowerUpObj {
  tags: string[];
  pos: { x: number; y: number };
  powerUpId?: string;
  powerUpKind?: string;
  exists(): boolean;
}

function makeFakeKaplay() {
  const created: FakePowerUpObj[] = [];
  const destroyed: FakePowerUpObj[] = [];
  const k = {
    add: vi.fn((comps: unknown[]) => {
      const obj: FakePowerUpObj = {
        tags: comps.filter((c): c is string => typeof c === "string"),
        pos: { x: 0, y: 0 },
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
      const idComp = comps.find(
        (c): c is { powerUpId: string } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { powerUpId?: unknown }).powerUpId === "string"
      );
      if (idComp) obj.powerUpId = idComp.powerUpId;
      const kindComp = comps.find(
        (c): c is { powerUpKind: string } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { powerUpKind?: unknown }).powerUpKind === "string"
      );
      if (kindComp) obj.powerUpKind = kindComp.powerUpKind;
      created.push(obj);
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ x, y })),
    rect: vi.fn((w: number, h: number, opts?: unknown) => ({ kind: "rect", w, h, opts })),
    color: vi.fn((r: number, g: number, b: number) => ({ kind: "color", rgb: [r, g, b] })),
    rgb: vi.fn((r: number, g: number, b: number) => ({ r, g, b })),
    outline: vi.fn((w: number, c?: unknown) => ({ kind: "outline", w, c })),
    z: vi.fn((v: number) => ({ kind: "z", v })),
    // area() SEM body — a camada só precisa do colisor para o onCollide do
    // motor solo; o fake registra o componente como marcador (padrão do
    // fake kaplay do boss-e2e).
    area: vi.fn(() => ({ kind: "area" })),
    destroy: vi.fn((obj: FakePowerUpObj) => {
      destroyed.push(obj);
    }),
  };
  return { k, created, destroyed };
}

function powerUp(id: string, kind: string, x: number, y: number, w = 20, h = 20) {
  return { id, kind, x, y, w, h };
}

// ===== levelPowerUp — conversão tile→px (espelho do servidor) =====

describe("levelPowerUp — posição espelhando o servidor", () => {
  it("centraliza na coluna e flutua POWERUP_FLOAT_HEIGHT acima do topo (top-left da hitbox)", () => {
    const p = levelPowerUp(6, 10, "p1", "vida");
    expect(p).toEqual({
      id: "p1",
      kind: "vida",
      x: 6 * TILE + TILE / 2 - POWERUP_WIDTH / 2,
      y: 10 * TILE - POWERUP_FLOAT_HEIGHT - POWERUP_HEIGHT / 2,
      w: POWERUP_WIDTH,
      h: POWERUP_HEIGHT,
    });
    // Centro do power-up: centro da coluna, 36px acima do topo do tile
    // (PowerUpFloatHeight > CoinFloatHeight 30 — flutua acima da moeda).
    expect(p.x + POWERUP_WIDTH / 2).toBe(6 * TILE + TILE / 2);
    expect(p.y + POWERUP_HEIGHT / 2).toBe(10 * TILE - POWERUP_FLOAT_HEIGHT);
  });
});

// ===== Camada kaplay — criação e sincronização =====

describe("createPowerUpLayer — applyFull (estado completo)", () => {
  it("cria um objeto por power-up na posição do servidor com visual por tipo", () => {
    const { k, created } = makeFakeKaplay();
    const layer = createPowerUpLayer(k as never);
    layer.applyFull([
      powerUp("p1", "vida", 100, 200),
      powerUp("p2", "tiro_triplo", 300, 400, 24, 18),
      powerUp("p3", "escudo", 500, 600),
    ]);

    expect(created).toHaveLength(3);
    const [a, b, c] = created;
    expect(a.tags).toContain("powerup");
    expect(a.pos).toEqual({ x: 100, y: 200 });
    expect(a.powerUpId).toBe("p1");
    expect(a.powerUpKind).toBe("vida");
    expect(b.powerUpKind).toBe("tiro_triplo");
    expect(c.powerUpKind).toBe("escudo");
    // Hitbox do servidor (w/h do broadcast) usada no rect.
    expect(k.rect).toHaveBeenNthCalledWith(1, 20, 20, expect.anything());
    expect(k.rect).toHaveBeenNthCalledWith(2, 24, 18, expect.anything());
    // Cor por tipo: vida vermelho, tiro triplo amarelo, escudo azul.
    expect(k.color).toHaveBeenCalledWith(235, 80, 90);
    expect(k.color).toHaveBeenCalledWith(255, 205, 70);
    expect(k.color).toHaveBeenCalledWith(90, 165, 235);
    // Outline branco para destacar do fundo escuro.
    expect(k.outline).toHaveBeenCalled();
    expect(layer.size()).toBe(3);
    expect(layer.has("p1")).toBe(true);
  });

  it("tipo desconhecido cai no visual de vida (guarda defensiva)", () => {
    const { k } = makeFakeKaplay();
    createPowerUpLayer(k as never).applyFull([powerUp("p9", "lixo", 10, 20)]);
    expect(k.color).toHaveBeenCalledWith(235, 80, 90);
  });

  it("reconcilia: cria ausentes, reposiciona existentes e destrói os que sumiram", () => {
    const { k, destroyed, created } = makeFakeKaplay();
    const layer = createPowerUpLayer(k as never);
    layer.applyFull([powerUp("p1", "vida", 100, 200), powerUp("p2", "escudo", 300, 400)]);

    // Novo estado: p1 reposicionado, p2 sumiu (coletado), p3 apareceu.
    layer.applyFull([powerUp("p1", "vida", 150, 210), powerUp("p3", "tiro_triplo", 500, 600)]);

    expect(created).toHaveLength(3);
    expect(created[0].pos).toEqual({ x: 150, y: 210 }); // p1 reposicionado (não recriado)
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].powerUpId).toBe("p2");
    expect(layer.size()).toBe(2);
    expect(layer.has("p3")).toBe(true);
  });

  it("estado vazio destrói tudo (fase sem power-ups)", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createPowerUpLayer(k as never);
    layer.applyFull([powerUp("p1", "vida", 100, 200), powerUp("p2", "escudo", 300, 400)]);
    layer.applyFull([]);
    expect(destroyed).toHaveLength(2);
    expect(layer.size()).toBe(0);
  });
});

describe("createPowerUpLayer — applyRemoved (broadcast de coleta)", () => {
  it("destrói os removidos e dispara onCollect com tipo+posição", () => {
    const { k, destroyed } = makeFakeKaplay();
    const onCollect = vi.fn();
    const layer = createPowerUpLayer(k as never, { onCollect });
    layer.applyFull([powerUp("p1", "vida", 100, 200), powerUp("p2", "escudo", 300, 400)]);

    layer.applyRemoved([{ id: "p1", kind: "vida", x: 100, y: 200 }]);

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].powerUpId).toBe("p1");
    expect(layer.size()).toBe(1);
    expect(layer.has("p2")).toBe(true);
    expect(onCollect).toHaveBeenCalledWith({ id: "p1", kind: "vida", x: 100, y: 200 });
  });

  it("ignora ids desconhecidos sem disparar onCollect", () => {
    const { k } = makeFakeKaplay();
    const onCollect = vi.fn();
    const layer = createPowerUpLayer(k as never, { onCollect });
    layer.applyFull([powerUp("p1", "vida", 100, 200)]);
    layer.applyRemoved([{ id: "fantasma", kind: "vida", x: 0, y: 0 }]);
    expect(onCollect).not.toHaveBeenCalled();
    expect(layer.size()).toBe(1);
  });
});

describe("createPowerUpLayer — clear e contrato", () => {
  it("clear destrói tudo e zera a camada (idempotente)", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createPowerUpLayer(k as never);
    layer.applyFull([powerUp("p1", "vida", 100, 200), powerUp("p2", "escudo", 300, 400)]);
    layer.clear();
    expect(destroyed).toHaveLength(2);
    expect(layer.size()).toBe(0);
    layer.clear();
    expect(destroyed).toHaveLength(2);
  });

  it("expõe o contrato completo (applyFull/applyRemoved/clear/size/has)", () => {
    const { k } = makeFakeKaplay();
    const layer: PowerUpLayer = createPowerUpLayer(k as never);
    for (const method of ["applyFull", "applyRemoved", "clear", "size", "has"] as const) {
      expect(typeof layer[method]).toBe("function");
    }
  });
});
