import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MUTE_STORAGE_KEY,
  clampHp,
  createHud,
  formatDeathMessage,
  formatHud,
  formatRespawnLabel,
  hpPercent,
  loadMutedSession,
  playerRowView,
  saveMutedSession,
  type HudPlayer,
  type HudState,
} from "./hud";

describe("clampHp", () => {
  it("mantém valores dentro da faixa", () => {
    expect(clampHp(100, 100)).toBe(100);
    expect(clampHp(42, 100)).toBe(42);
    expect(clampHp(0, 100)).toBe(0);
  });

  it("clampa abaixo de 0", () => {
    expect(clampHp(-5, 100)).toBe(0);
    expect(clampHp(-100, 100)).toBe(0);
  });

  it("clampa acima do maxHp", () => {
    expect(clampHp(150, 100)).toBe(100);
    expect(clampHp(101, 100)).toBe(100);
  });
});

describe("formatHud", () => {
  it("formata o caso normal", () => {
    expect(formatHud(100, 100, 3)).toBe(
      "🧱 coop-blocks — HP 100/100 — jogadores online: 3"
    );
  });

  it("formata HP intermediário e zero jogadores", () => {
    expect(formatHud(42, 100, 0)).toBe(
      "🧱 coop-blocks — HP 42/100 — jogadores online: 0"
    );
  });

  it("formata com maxHp arbitrário", () => {
    expect(formatHud(7, 20, 1)).toBe(
      "🧱 coop-blocks — HP 7/20 — jogadores online: 1"
    );
  });

  it("clampa HP em 0 (alinhado ao servidor, que nunca deixa HP negativo)", () => {
    expect(formatHud(0, 100, 1)).toContain("HP 0/100");
    expect(formatHud(-5, 100, 1)).toContain("HP 0/100");
    expect(formatHud(-100, 100, 1)).toContain("HP 0/100");
  });

  it("clampa HP no maxHp", () => {
    expect(formatHud(150, 100, 1)).toContain("HP 100/100");
    expect(formatHud(100, 100, 1)).toContain("HP 100/100");
  });

  it("preserva valores fracionários no meio da faixa", () => {
    expect(formatHud(42.5, 100, 1)).toContain("HP 42.5/100");
  });
});

describe("formatDeathMessage", () => {
  it("retorna a mensagem de morte", () => {
    expect(formatDeathMessage()).toBe(
      "💀 Você morreu! Voltando em instantes..."
    );
  });
});

// ===== Painel de jogadores — helpers puros =====

describe("hpPercent", () => {
  const player = (over: Partial<HudPlayer> = {}): HudPlayer => ({
    id: "p1",
    name: "Jogador",
    color: "#fff",
    hp: 100,
    maxHp: 100,
    x: 0,
    y: 0,
    ...over,
  });

  it("100% com HP cheio", () => {
    expect(hpPercent(player())).toBe(100);
  });

  it("proporcional ao meio da faixa", () => {
    expect(hpPercent(player({ hp: 42, maxHp: 100 }))).toBe(42);
    expect(hpPercent(player({ hp: 75, maxHp: 150 }))).toBe(50);
  });

  it("0% com HP zerado (morto)", () => {
    expect(hpPercent(player({ hp: 0 }))).toBe(0);
  });

  it("clampa acima do maxHp e abaixo de 0", () => {
    expect(hpPercent(player({ hp: 150, maxHp: 100 }))).toBe(100);
    expect(hpPercent(player({ hp: -10, maxHp: 100 }))).toBe(0);
  });

  it("maxHp 0 não divide por zero", () => {
    expect(hpPercent(player({ hp: 0, maxHp: 0 }))).toBe(0);
  });
});

describe("formatRespawnLabel", () => {
  it("sem timer informado → rótulo genérico de espera", () => {
    expect(formatRespawnLabel(undefined)).toBe("💀 respawn...");
  });

  it("timer zerado ou negativo → rótulo genérico", () => {
    expect(formatRespawnLabel(0)).toBe("💀 respawn...");
    expect(formatRespawnLabel(-1)).toBe("💀 respawn...");
  });

  it("arredonda para cima (ceil) os segundos restantes", () => {
    expect(formatRespawnLabel(1.5)).toBe("💀 2s");
    expect(formatRespawnLabel(2.1)).toBe("💀 3s");
  });

  it("clampa em 3 segundos (teto do servidor: DefaultRespawnTicks)", () => {
    expect(formatRespawnLabel(5)).toBe("💀 3s");
    expect(formatRespawnLabel(3.4)).toBe("💀 3s");
  });

  it("segundo inteiro exato", () => {
    expect(formatRespawnLabel(2)).toBe("💀 2s");
    expect(formatRespawnLabel(3)).toBe("💀 3s");
  });
});

describe("playerRowView", () => {
  const player = (over: Partial<HudPlayer> = {}): HudPlayer => ({
    id: "p1",
    name: "Jogador",
    color: "rgb(66, 200, 245)",
    hp: 100,
    maxHp: 100,
    x: 0,
    y: 0,
    ...over,
  });

  it("marca down quando respawning=true", () => {
    expect(playerRowView(player({ respawning: true, hp: 0 }), "p1").down).toBe(true);
  });

  it("marca down quando hp<=0 mesmo sem a flag respawning", () => {
    expect(playerRowView(player({ hp: 0 }), "p1").down).toBe(true);
    expect(playerRowView(player({ hp: -3 }), "p1").down).toBe(true);
  });

  it("não marca down com hp acima de zero", () => {
    expect(playerRowView(player({ hp: 42 }), "p1").down).toBe(false);
  });

  it("identifica o jogador local pelo id", () => {
    expect(playerRowView(player(), "p1").local).toBe(true);
    expect(playerRowView(player(), "outro").local).toBe(false);
  });

  it("calcula percentual e rótulo de respawn para o estado", () => {
    const view = playerRowView(
      player({ hp: 42, maxHp: 100, respawning: true, respawnIn: 1.5 }),
      "p1"
    );
    expect(view.percent).toBe(42);
    expect(view.respawnLabel).toBe("💀 2s");
    expect(view.name).toBe("Jogador");
    expect(view.color).toBe("rgb(66, 200, 245)");
  });

  it("vivo não carrega rótulo de respawn", () => {
    const view = playerRowView(player({ hp: 42 }), "p1");
    expect(view.respawnLabel).toBe("");
  });
});

// ===== Fake DOM mínimo (vitest roda em node, sem jsdom) =====
// Mesma estratégia de shop.test.ts: elementos mínimos com filhos/atributos/
// estilos para inspecionar a árvore renderizada pelo HUD.

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};

  constructor(tag: string) {
    this.tagName = tag;
  }

  classList = {
    add: (cls: string) => {
      const parts = this.className.split(/\s+/).filter(Boolean);
      if (!parts.includes(cls)) parts.push(cls);
      this.className = parts.join(" ");
    },
  };

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

// Busca o primeiro elemento com o atributo name = value na subárvore.
function byAttr(root: FakeElement, name: string, value: string): FakeElement | undefined {
  if (root.attrs[name] === value) return root;
  for (const c of root.children) {
    const found = byAttr(c, name, value);
    if (found) return found;
  }
  return undefined;
}

// Busca todos os elementos cuja classe contém o token informado.
function byClass(root: FakeElement, cls: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (root.className.split(/\s+/).includes(cls)) out.push(root);
  for (const c of root.children) out.push(...byClass(c, cls));
  return out;
}

// ===== Painel de jogadores — render via createHud/update =====

const player = (over: Partial<HudPlayer> = {}): HudPlayer => ({
  id: "p1",
  name: "Jogador",
  color: "rgb(200, 200, 200)",
  hp: 100,
  maxHp: 100,
  x: 10,
  y: 20,
  ...over,
});

const hudState = (players: HudPlayer[], localId = "p1"): HudState => ({
  players,
  localPlayerId: localId,
  camera: { x: 0, y: 0, width: 960, height: 540 },
});

let doc: ReturnType<typeof fakeDoc>;

beforeEach(() => {
  doc = fakeDoc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = doc;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).document;
});

describe("createHud — painel de HP dos jogadores", () => {
  it("renderiza uma linha por jogador da sala (local + remotos)", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([
        player({ id: "p1", name: "Você" }),
        player({ id: "p2", name: "Jogador" }),
        player({ id: "p3", name: "Jogador" }),
      ])
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(byClass(panel, "player-row")).toHaveLength(3);
    expect(panel.children.map((r) => r.attrs["data-player-id"])).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("exibe o nome na cor do jogador e o HP numérico", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1", name: "Você", color: "rgb(66, 200, 245)", hp: 42, maxHp: 100 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const row = panel.children[0];
    const name = byClass(row, "player-name")[0];
    const hp = byClass(row, "player-hp")[0];
    expect(name.textContent).toBe("Você");
    expect(name.style.color).toBe("rgb(66, 200, 245)");
    expect(hp.textContent).toBe("42/100");
  });

  it("linha segue a ordem nome → barra → números (grid do CSS)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1", name: "Você", hp: 42, maxHp: 100 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(panel.children[0].children.map((c) => c.className)).toEqual([
      "player-name",
      "player-bar",
      "player-hp",
    ]);
  });

  it("preenche a barra conforme hp/maxHp", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1", hp: 75, maxHp: 150 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const fill = byClass(panel, "player-fill")[0];
    expect(fill.style.width).toBe("50%");
    expect(fill.style.background).toBe("rgb(200, 200, 200)");
  });

  it("destaca o jogador local com a classe is-local", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([
        player({ id: "p1", name: "Você" }),
        player({ id: "p2", name: "Jogador" }),
      ])
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(panel.children[0].className).toContain("is-local");
    expect(panel.children[1].className).not.toContain("is-local");
  });

  it("morto/aguardando respawn mostra o estado com contagem no lugar da barra", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([player({ id: "p1", hp: 0, respawning: true, respawnIn: 2 }), player({ id: "p2", hp: 60 })])
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const dead = panel.children[0];
    const alive = panel.children[1];
    expect(dead.className).toContain("is-down");
    const respawn = byClass(dead, "player-respawn")[0];
    expect(respawn.textContent).toBe("💀 2s");
    expect(byClass(alive, "player-respawn")).toHaveLength(0);
    expect(alive.className).not.toContain("is-down");
  });

  it("hp zerado sem a flag respawning também entra em estado de morte", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1", hp: 0 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(panel.children[0].className).toContain("is-down");
    expect(byClass(panel.children[0], "player-respawn")[0].textContent).toBe(
      "💀 respawn..."
    );
  });

  it("painel vazio quando não há jogadores", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(panel.children).toHaveLength(0);
  });

  it("re-render substitui a lista anterior (sem linhas duplicadas)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1" }), player({ id: "p2" })]));
    update(hudState([player({ id: "p1" })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(byClass(panel, "player-row")).toHaveLength(1);
  });
});

describe("persistência do mute (sessão)", () => {
  // Stub de sessionStorage em memória (node não tem sessionStorage).
  const storage = new Map<string, string>();
  const original = globalThis.sessionStorage;

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: original,
    });
  });

  it("usa a chave documentada", () => {
    expect(MUTE_STORAGE_KEY).toBe("coop-blocks:muted");
  });

  it("retorna fallback quando nada foi persistido", () => {
    expect(loadMutedSession()).toBe(false);
    expect(loadMutedSession(true)).toBe(true);
  });

  it("persiste e lê de volta o estado de mute", () => {
    saveMutedSession(true);
    expect(loadMutedSession()).toBe(true);
    saveMutedSession(false);
    expect(loadMutedSession()).toBe(false);
  });

  it("lê valores crus persistidos manualmente", () => {
    storage.set(MUTE_STORAGE_KEY, "1");
    expect(loadMutedSession()).toBe(true);
    storage.set(MUTE_STORAGE_KEY, "0");
    expect(loadMutedSession()).toBe(false);
  });
});
