import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE_MAX_HP,
  UPGRADE_CATALOG,
  canBuy,
  createShop,
  isMaxed,
  readyCount,
  upgradeLevel,
  type BuyReceipt,
  type ShopPhaseState,
} from "./shop";

// ===== Fake DOM mínimo (vitest roda em node, sem jsdom) =====

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  disabled = false;
  title = "";
  type = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};

  constructor(tag: string) {
    this.tagName = tag;
  }

  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }

  appendChild(node: FakeElement) {
    this.children.push(node);
  }

  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes;
  }

  remove() {
    // no-op no fake — o teste inspeciona o objeto diretamente
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }

  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = fn;
  }

  click() {
    this.listeners["click"]?.();
  }
}

function fakeDoc() {
  return {
    createElement: (tag: string) => new FakeElement(tag),
    body: new FakeElement("body"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Busca o primeiro elemento com o atributo data-shop = value.
function byAttr(root: FakeElement, name: string, value: string): FakeElement | undefined {
  if (root.attrs[name] === value) return root;
  for (const c of root.children) {
    const found = byAttr(c, name, value);
    if (found) return found;
  }
  return undefined;
}

function allByAttr(root: FakeElement, name: string, value: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (root.attrs[name] === value) out.push(root);
  for (const c of root.children) out.push(...allByAttr(c, name, value));
  return out;
}

// ===== Fixtures =====

const shopState = (over: Partial<ShopPhaseState> = {}): ShopPhaseState => ({
  phase: "shop",
  number: 2,
  ready: { alice: false, bob: false },
  players: [
    { id: "alice", coins: 120, stats: { maxHp: 100, fireRate: 1, shield: 0 } },
    { id: "bob", coins: 20, stats: { maxHp: 125, fireRate: 1.2, shield: 1 } },
  ],
  ...over,
});

let doc: ReturnType<typeof fakeDoc>;

beforeEach(() => {
  doc = fakeDoc();
  vi.stubGlobal("document", doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===== Catálogo alinhado ao servidor =====

describe("UPGRADE_CATALOG — alinhamento com o servidor (shop.go)", () => {
  it("traz os 3 upgrades na ordem canônica", () => {
    expect(UPGRADE_CATALOG.map((u) => u.id)).toEqual(["max_hp", "fire_rate", "shield"]);
  });

  it("custos batem com as constantes do servidor (50/40/30)", () => {
    expect(UPGRADE_CATALOG.find((u) => u.id === "max_hp")?.cost).toBe(50);
    expect(UPGRADE_CATALOG.find((u) => u.id === "fire_rate")?.cost).toBe(40);
    expect(UPGRADE_CATALOG.find((u) => u.id === "shield")?.cost).toBe(30);
  });

  it("níveis máximos batem com o servidor (3 para todos)", () => {
    for (const u of UPGRADE_CATALOG) {
      expect(u.maxLevel).toBe(3);
    }
  });
});

// ===== Nível derivado das stats =====

describe("upgradeLevel — deriva o nível das stats efetivas", () => {
  const base = { maxHp: BASE_MAX_HP, fireRate: 1, shield: 0 };

  it("stats base → nível 0 em todos os upgrades", () => {
    expect(upgradeLevel(base, "max_hp")).toBe(0);
    expect(upgradeLevel(base, "fire_rate")).toBe(0);
    expect(upgradeLevel(base, "shield")).toBe(0);
  });

  it("max_hp: cada +25 HP é um nível", () => {
    expect(upgradeLevel({ ...base, maxHp: 125 }, "max_hp")).toBe(1);
    expect(upgradeLevel({ ...base, maxHp: 150 }, "max_hp")).toBe(2);
    expect(upgradeLevel({ ...base, maxHp: 175 }, "max_hp")).toBe(3);
  });

  it("fire_rate: cada +0.2 no multiplicador é um nível", () => {
    expect(upgradeLevel({ ...base, fireRate: 1.2 }, "fire_rate")).toBe(1);
    expect(upgradeLevel({ ...base, fireRate: 1.4 }, "fire_rate")).toBe(2);
    expect(upgradeLevel({ ...base, fireRate: 1.6 }, "fire_rate")).toBe(3);
  });

  it("shield: o número de cargas é o nível", () => {
    expect(upgradeLevel({ ...base, shield: 2 }, "shield")).toBe(2);
  });
});

// ===== Habilitação de compra =====

describe("canBuy / isMaxed", () => {
  const base = { maxHp: BASE_MAX_HP, fireRate: 1, shield: 0 };
  const def = UPGRADE_CATALOG[0]; // max_hp, custo 50

  it("permite comprar com saldo suficiente e nível abaixo do máximo", () => {
    expect(canBuy(50, base, def)).toBe(true);
    expect(canBuy(999, base, def)).toBe(true);
  });

  it("bloqueia com moedas insuficientes", () => {
    expect(canBuy(49, base, def)).toBe(false);
    expect(canBuy(0, base, def)).toBe(false);
  });

  it("bloqueia no nível máximo (já comprou tudo)", () => {
    const maxed = { ...base, maxHp: 175 }; // nível 3
    expect(isMaxed(maxed, def)).toBe(true);
    expect(canBuy(999, maxed, def)).toBe(false);
  });

  it("bloqueia no nível máximo mesmo com saldo", () => {
    const maxed = { ...base, maxHp: 175 };
    expect(canBuy(999, maxed, def)).toBe(false);
  });
});

// ===== Contagem de prontos =====

describe("readyCount", () => {
  it("conta apenas os jogadores marcados prontos", () => {
    expect(readyCount(shopState({ ready: { alice: true, bob: false } }))).toBe(1);
    expect(readyCount(shopState({ ready: { alice: true, bob: true } }))).toBe(2);
    expect(readyCount(shopState())).toBe(0);
  });
});

// ===== Overlay DOM =====

describe("createShop — render da loja", () => {
  it("nasce oculto e fica visível quando o servidor abre a loja", () => {
    const { el, update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    expect(el.style.display).toBe("none");
    update(shopState(), "alice");
    expect(el.style.display).toBe("");
  });

  it("some ao receber phase=playing", () => {
    const { el, update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    update(shopState(), "alice");
    update(shopState({ phase: "playing", ready: {} }), "alice");
    expect(el.style.display).toBe("none");
  });

  it("exibe o título da fase e o saldo individual do jogador", () => {
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    update(shopState(), "alice");
    const title = byAttr(doc.body, "data-shop", "title")!;
    const balance = byAttr(doc.body, "data-shop", "balance")!;
    expect(title.textContent).toBe("🛒 Loja — Fase 2");
    expect(balance.textContent).toBe("🪙 120 moedas");
  });

  it("renderiza um card por upgrade com botão desabilitado quando não pode pagar", () => {
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    // bob tem 20 moedas — nenhum upgrade custa <= 20 → todos desabilitados
    update(shopState(), "bob");
    const buys = allByAttr(doc.body, "data-shop", "buy");
    expect(buys).toHaveLength(3);
    for (const b of buys) expect(b.disabled).toBe(true);
  });

  it("habilita só o que o saldo cobre", () => {
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    // alice com 45 moedas: escudo (30) e cadência (40) ok; vida (50) não
    update(shopState({ players: [{ id: "alice", coins: 45, stats: { maxHp: 100, fireRate: 1, shield: 0 } }] }), "alice");
    const buys = allByAttr(doc.body, "data-shop", "buy");
    expect(buys.find((b) => b.attrs["data-upgrade"] === "max_hp")?.disabled).toBe(true);
    expect(buys.find((b) => b.attrs["data-upgrade"] === "fire_rate")?.disabled).toBe(false);
    expect(buys.find((b) => b.attrs["data-upgrade"] === "shield")?.disabled).toBe(false);
  });

  it("mostra MÁXIMO no botão do upgrade já no nível máximo", () => {
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    // bob já tem max_hp nível 3 (175 HP)
    update(
      shopState({
        players: [
          { id: "alice", coins: 999, stats: { maxHp: 100, fireRate: 1, shield: 0 } },
          { id: "bob", coins: 999, stats: { maxHp: 175, fireRate: 1, shield: 0 } },
        ],
      }),
      "bob"
    );
    const buy = byAttr(doc.body, "data-shop", "buy")!;
    expect(buy.textContent).toBe("MÁXIMO");
    expect(buy.disabled).toBe(true);
  });

  it("clique em Comprar dispara onBuy com o id do upgrade", () => {
    const onBuy = vi.fn();
    const { update } = createShop({ root: doc.body, onBuy, onReady: vi.fn() });
    update(shopState(), "alice");
    byAttr(doc.body, "data-shop", "buy")!.click();
    expect(onBuy).toHaveBeenCalledWith("max_hp");
  });

  it("clique em Pronto dispara onReady", () => {
    const onReady = vi.fn();
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady });
    update(shopState(), "alice");
    byAttr(doc.body, "data-shop", "ready")!.click();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("applyBuyResult atualiza o saldo e as stats exibidos sem novo broadcast", () => {
    const { update, applyBuyResult } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    update(shopState(), "alice");
    const rc: BuyReceipt = {
      upgrade: "shield",
      level: 1,
      cost: 30,
      coins: 90,
      stats: { maxHp: 100, fireRate: 1, shield: 1 },
    };
    applyBuyResult(rc);
    const balance = byAttr(doc.body, "data-shop", "balance")!;
    expect(balance.textContent).toBe("🪙 90 moedas");
  });

  it("lista os jogadores com estado de pronto (meu nome é 'Você')", () => {
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    update(shopState({ ready: { alice: true, bob: false } }), "alice");
    const items = allByAttr(doc.body, "data-shop", "ready-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("✅ Você");
    expect(items[1].textContent).toContain("⏳ Jogador");
  });

  it("desabilita o botão Pronto após eu confirmar e mostra a espera", () => {
    const { update } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    update(shopState({ ready: { alice: true, bob: false } }), "alice");
    const readyBtn = byAttr(doc.body, "data-shop", "ready")!;
    expect(readyBtn.disabled).toBe(true);
    expect(readyBtn.textContent).toContain("Aguardando outros jogadores... (1/2)");
  });

  it("showError exibe a mensagem de rejeição do servidor", () => {
    const { update, showError } = createShop({ root: doc.body, onBuy: vi.fn(), onReady: vi.fn() });
    update(shopState(), "alice");
    showError("moedas insuficientes");
    const err = byAttr(doc.body, "data-shop", "error")!;
    expect(err.textContent).toBe("moedas insuficientes");
    expect(err.style.display).toBe("");
  });
});
