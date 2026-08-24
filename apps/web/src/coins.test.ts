import { describe, expect, it, vi } from "vitest";
import { TILE } from "./levelgen";
import {
  COIN_FLOAT_HEIGHT,
  COIN_HEIGHT,
  COIN_WIDTH,
  createCoinLayer,
  levelCoin,
  type CoinLayer,
} from "./coins";

// ===== Fake estrutural do engine Kaplay =====
// A camada só toca add/pos/rect/color/area/z/destroy; o fake rastreia os
// objetos criados/destruídos e expõe exists() para os guards defensivos.

interface FakeCoinObj {
  tags: string[];
  pos: { x: number; y: number };
  coinId?: string;
  exists(): boolean;
}

function makeFakeKaplay() {
  const created: FakeCoinObj[] = [];
  const destroyed: FakeCoinObj[] = [];
  const k = {
    add: vi.fn((comps: unknown[]) => {
      const obj: FakeCoinObj = {
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
        (c): c is { coinId: string } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { coinId?: unknown }).coinId === "string"
      );
      if (idComp) obj.coinId = idComp.coinId;
      created.push(obj);
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ x, y })),
    rect: vi.fn((w: number, h: number) => ({ kind: "rect", w, h })),
    color: vi.fn((r: number, g: number, b: number) => ({ kind: "color", rgb: [r, g, b] })),
    area: vi.fn(() => ({ kind: "area" })),
    z: vi.fn((v: number) => ({ kind: "z", v })),
    destroy: vi.fn((obj: FakeCoinObj) => {
      destroyed.push(obj);
    }),
  };
  return { k, created, destroyed };
}

function coin(id: string, x: number, y: number, w = 14, h = 14) {
  return { id, x, y, w, h };
}

// ===== levelCoin — conversão tile→px (espelho do servidor) =====

describe("levelCoin — posição espelhando o servidor", () => {
  it("centraliza na coluna e flutua COIN_FLOAT_HEIGHT acima do topo (top-left da hitbox)", () => {
    const c = levelCoin(6, 10, "c1");
    expect(c).toEqual({
      id: "c1",
      x: 6 * TILE + TILE / 2 - COIN_WIDTH / 2,
      y: 10 * TILE - COIN_FLOAT_HEIGHT - COIN_HEIGHT / 2,
      w: COIN_WIDTH,
      h: COIN_HEIGHT,
    });
    // Centro da moeda: centro da coluna, 30px acima do topo do tile.
    expect(c.x + COIN_WIDTH / 2).toBe(6 * TILE + TILE / 2);
    expect(c.y + COIN_HEIGHT / 2).toBe(10 * TILE - COIN_FLOAT_HEIGHT);
  });
});

// ===== Camada kaplay — criação e sincronização =====

describe("createCoinLayer — applyFull (estado completo)", () => {
  it("cria um objeto por moeda na posição do servidor com tag/visual corretos", () => {
    const { k, created } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200), coin("c2", 300, 400, 20, 16)]);

    expect(created).toHaveLength(2);
    const [a, b] = created;
    expect(a.tags).toContain("coin");
    expect(a.pos).toEqual({ x: 100, y: 200 });
    expect(a.coinId).toBe("c1");
    expect(b.pos).toEqual({ x: 300, y: 400 });
    expect(b.coinId).toBe("c2");
    expect(k.rect).toHaveBeenNthCalledWith(1, 14, 14);
    expect(k.rect).toHaveBeenNthCalledWith(2, 20, 16); // w/h vindos do servidor
    expect(k.color).toHaveBeenCalledWith(255, 215, 60);
    expect(k.z).toHaveBeenCalledWith(3);
    expect(layer.size()).toBe(2);
    expect(layer.has("c1")).toBe(true);
  });

  it("reconcilia: cria ausentes, reposiciona existentes e destrói as que sumiram", () => {
    const { k, destroyed, created } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200), coin("c2", 300, 400)]);

    // Novo estado: c1 reposicionada, c2 sumiu (coletada), c3 apareceu (drop).
    layer.applyFull([coin("c1", 150, 210), coin("c3", 500, 600)]);

    expect(created).toHaveLength(3);
    expect(created[0].pos).toEqual({ x: 150, y: 210 }); // c1 reposicionada (não recriada)
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].coinId).toBe("c2");
    expect(layer.size()).toBe(2);
    expect(layer.has("c3")).toBe(true);
  });

  it("estado vazio destrói tudo (fase sem moedas)", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200), coin("c2", 300, 400)]);
    layer.applyFull([]);
    expect(destroyed).toHaveLength(2);
    expect(layer.size()).toBe(0);
  });
});

describe("createCoinLayer — addCoins (drops locais)", () => {
  it("acrescenta sem tocar nas existentes e não duplica ids", () => {
    const { k, created } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200)]);
    layer.addCoins([coin("d1", 500, 600), coin("c1", 999, 999)]);
    expect(created).toHaveLength(2); // c1 duplicada é ignorada
    expect(layer.size()).toBe(2);
    expect(created[1].coinId).toBe("d1");
    expect(created[1].pos).toEqual({ x: 500, y: 600 });
  });
});

describe("createCoinLayer — applyRemoved (broadcast de coleta)", () => {
  it("destrói as moedas removidas e dispara onCollect com a posição", () => {
    const { k, destroyed } = makeFakeKaplay();
    const onCollect = vi.fn();
    const layer = createCoinLayer(k as never, { onCollect });
    layer.applyFull([coin("c1", 100, 200), coin("c2", 300, 400)]);

    layer.applyRemoved([{ id: "c1", x: 100, y: 200 }]);

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].coinId).toBe("c1");
    expect(layer.size()).toBe(1);
    expect(layer.has("c2")).toBe(true);
    expect(onCollect).toHaveBeenCalledWith({ id: "c1", x: 100, y: 200 });
  });

  it("ignora ids desconhecidos sem disparar onCollect", () => {
    const { k } = makeFakeKaplay();
    const onCollect = vi.fn();
    const layer = createCoinLayer(k as never, { onCollect });
    layer.applyFull([coin("c1", 100, 200)]);
    layer.applyRemoved([{ id: "fantasma", x: 0, y: 0 }]);
    expect(onCollect).not.toHaveBeenCalled();
    expect(layer.size()).toBe(1);
  });
});

describe("createCoinLayer — remove e clear", () => {
  it("remove destrói apenas a moeda do id dado", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200), coin("c2", 300, 400)]);
    layer.remove("c1");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].coinId).toBe("c1");
    expect(layer.size()).toBe(1);
    expect(layer.has("c2")).toBe(true);
  });

  it("remove de id inexistente é no-op", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200)]);
    layer.remove("nope");
    expect(destroyed).toHaveLength(0);
    expect(layer.size()).toBe(1);
  });

  it("clear destrói tudo e zera a camada", () => {
    const { k, destroyed } = makeFakeKaplay();
    const layer = createCoinLayer(k as never);
    layer.applyFull([coin("c1", 100, 200), coin("c2", 300, 400)]);
    layer.clear();
    expect(destroyed).toHaveLength(2);
    expect(layer.size()).toBe(0);
    // Clear idempotente.
    layer.clear();
    expect(destroyed).toHaveLength(2);
  });
});

// Garante que o contrato da camada está completo (o main.ts usa todos).
describe("createCoinLayer — contrato", () => {
  it("expõe applyFull/addCoins/applyRemoved/remove/clear/size/has", () => {
    const { k } = makeFakeKaplay();
    const layer: CoinLayer = createCoinLayer(k as never);
    for (const method of [
      "applyFull",
      "addCoins",
      "applyRemoved",
      "remove",
      "clear",
      "size",
      "has",
    ] as const) {
      expect(typeof layer[method]).toBe("function");
    }
  });
});
