import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MUTE_STORAGE_KEY,
  arrowView,
  bossBarView,
  bossPercent,
  clampArrowPoint,
  clampHp,
  createHud,
  effectLabels,
  formatBossLabel,
  formatCoins,
  formatDeathMessage,
  formatEffectTime,
  formatHud,
  formatPhaseLabel,
  formatRespawnLabel,
  hpOverflow,
  hpPercent,
  hudArrows,
  isOffscreen,
  loadMutedSession,
  overMaxHp,
  playerAbbr,
  playerRowView,
  saveMutedSession,
  type HudBoss,
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

// ===== Contador de moedas — helpers puros =====

describe("formatCoins", () => {
  it("retorna vazio quando o estado não fornece o dado (modo desligado)", () => {
    expect(formatCoins(undefined)).toBe("");
  });

  it("formata o rótulo com o valor inteiro", () => {
    expect(formatCoins(0)).toBe("🪙 0");
    expect(formatCoins(1)).toBe("🪙 1");
    expect(formatCoins(42)).toBe("🪙 42");
  });

  it("nunca exibe valor negativo (clamp em 0)", () => {
    expect(formatCoins(-3)).toBe("🪙 0");
  });

  it("trunca valores fracionários", () => {
    expect(formatCoins(7.9)).toBe("🪙 7");
  });
});

// ===== Barra de HP do boss — helpers puros =====

describe("bossPercent", () => {
  const boss = (over: Partial<HudBoss> = {}): HudBoss => ({
    hp: 400,
    maxHp: 400,
    ...over,
  });

  it("100% com HP cheio", () => {
    expect(bossPercent(boss())).toBe(100);
  });

  it("proporcional ao meio da faixa", () => {
    expect(bossPercent(boss({ hp: 200, maxHp: 400 }))).toBe(50);
    expect(bossPercent(boss({ hp: 300, maxHp: 400 }))).toBe(75);
  });

  it("0% com HP zerado", () => {
    expect(bossPercent(boss({ hp: 0 }))).toBe(0);
  });

  it("clampa acima do maxHp e abaixo de 0", () => {
    expect(bossPercent(boss({ hp: 500, maxHp: 400 }))).toBe(100);
    expect(bossPercent(boss({ hp: -10, maxHp: 400 }))).toBe(0);
  });

  it("maxHp 0 não divide por zero", () => {
    expect(bossPercent(boss({ hp: 0, maxHp: 0 }))).toBe(0);
  });
});

describe("formatBossLabel", () => {
  it("sem fase → rótulo simples do boss", () => {
    expect(formatBossLabel()).toBe("👹 BOSS");
    expect(formatBossLabel(undefined)).toBe("👹 BOSS");
  });

  it("com fase → rótulo com contexto", () => {
    expect(formatBossLabel(5)).toBe("👹 BOSS — Fase 5");
    expect(formatBossLabel(10)).toBe("👹 BOSS — Fase 10");
  });

  it("fase zerada ou negativa cai no rótulo simples (fase não informada)", () => {
    expect(formatBossLabel(0)).toBe("👹 BOSS");
    expect(formatBossLabel(-1)).toBe("👹 BOSS");
  });
});

describe("bossBarView", () => {
  it("deriva rótulo, HP clampado e percentual", () => {
    const view = bossBarView({ hp: 168, maxHp: 400, phase: 5 });
    expect(view.label).toBe("👹 BOSS — Fase 5");
    expect(view.hp).toBe(168);
    expect(view.maxHp).toBe(400);
    expect(view.percent).toBe(42);
  });

  it("estado investida/salto mapeia para classe própria", () => {
    expect(bossBarView({ hp: 300, maxHp: 400, state: "investida" }).stateClass).toBe(
      "is-investida"
    );
    expect(bossBarView({ hp: 300, maxHp: 400, state: "salto" }).stateClass).toBe(
      "is-salto"
    );
  });

  it("estado idle ou desconhecido não carrega classe", () => {
    expect(bossBarView({ hp: 300, maxHp: 400, state: "idle" }).stateClass).toBe("");
    expect(bossBarView({ hp: 300, maxHp: 400, state: "zzz" }).stateClass).toBe("");
    expect(bossBarView({ hp: 300, maxHp: 400 }).stateClass).toBe("");
  });

  it("clampa HP fora da faixa no view", () => {
    expect(bossBarView({ hp: -5, maxHp: 400 }).hp).toBe(0);
    expect(bossBarView({ hp: 900, maxHp: 400 }).hp).toBe(400);
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

  it("carrega rótulo de moedas quando o estado fornece player.coins", () => {
    expect(playerRowView(player({ coins: 12 }), "p1").coinsLabel).toBe("🪙 12");
  });

  it("sem player.coins o rótulo de moedas fica vazio", () => {
    expect(playerRowView(player(), "p1").coinsLabel).toBe("");
    expect(playerRowView(player({ coins: undefined }), "p1").coinsLabel).toBe("");
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

// ===== Contador de moedas — render via createHud/update =====

const hudStateWith = (over: Partial<HudState> = {}, players = [player()]): HudState => ({
  ...hudState(players),
  ...over,
});

describe("createHud — contador de moedas", () => {
  it("modo time: mostra o total da equipe no canto superior direito", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ teamCoins: 42 }));
    const coins = byAttr(doc.body, "data-hud", "coins")!;
    expect(coins.textContent).toBe("🪙 42");
    expect(coins.style.display).toBe("");
  });

  it("modo time: zero coletado ainda exibe o contador (🪙 0)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ teamCoins: 0 }));
    const coins = byAttr(doc.body, "data-hud", "coins")!;
    expect(coins.textContent).toBe("🪙 0");
  });

  it("sem teamCoins o contador de equipe fica oculto", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([]));
    const coins = byAttr(doc.body, "data-hud", "coins")!;
    expect(coins.style.display).toBe("none");
  });

  it("modo individual: badge de moedas por jogador quando player.coins existe", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudStateWith(
        {},
        [
          player({ id: "p1", coins: 7 }),
          player({ id: "p2", coins: 3 }),
        ]
      )
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const badges = byClass(panel, "player-coins");
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toBe("🪙 7");
    expect(badges[1].textContent).toBe("🪙 3");
  });

  it("sem player.coins o badge individual não é renderizado", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudStateWith(
        {},
        [
          player({ id: "p1", coins: 7 }),
          player({ id: "p2" }),
        ]
      )
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const badges = byClass(panel, "player-coins");
    expect(badges).toHaveLength(1);
    expect(panel.children[1].children.map((c) => c.className)).not.toContain(
      "player-coins"
    );
  });

  it("modos time e individual coexistem quando ambos os dados chegam", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudStateWith(
        { teamCoins: 10 },
        [player({ id: "p1", coins: 6 }), player({ id: "p2", coins: 4 })]
      )
    );
    const coins = byAttr(doc.body, "data-hud", "coins")!;
    expect(coins.textContent).toBe("🪙 10");
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(byClass(panel, "player-coins")).toHaveLength(2);
  });

  it("badge de moedas é a última coluna da linha (após o HP)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({}, [player({ id: "p1", coins: 5 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(panel.children[0].children.map((c) => c.className)).toEqual([
      "player-name",
      "player-bar",
      "player-hp",
      "player-coins",
    ]);
  });

  it("morto/aguardando respawn esconde o badge (contador da fase zera na morte)", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudStateWith(
        {},
        [player({ id: "p1", hp: 0, respawning: true, coins: 9 })]
      )
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(byClass(panel, "player-coins")).toHaveLength(0);
  });
});

// ===== Barra de HP do boss — render via createHud/update =====

describe("createHud — barra de HP do boss", () => {
  it("aparece com boss ativo: rótulo, preenchimento e números", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudStateWith({
        boss: { hp: 168, maxHp: 400, phase: 5, state: "investida" },
      })
    );
    const boss = byAttr(doc.body, "data-hud", "boss")!;
    expect(boss.style.display).toBe("");
    expect(byClass(boss, "boss-label")[0].textContent).toBe("👹 BOSS — Fase 5");
    expect(byClass(boss, "boss-hp")[0].textContent).toBe("168/400");
    const fill = byClass(boss, "boss-fill")[0];
    expect(fill.style.width).toBe("42%");
    expect(fill.className).toContain("is-investida");
  });

  it("fica oculta sem boss ativo (estado sem o campo boss)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([]));
    const boss = byAttr(doc.body, "data-hud", "boss")!;
    expect(boss.style.display).toBe("none");
  });

  it("atualiza em tempo real conforme o dano (mesmo elemento, sem duplicar)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ boss: { hp: 400, maxHp: 400, phase: 5 } }));
    const boss = byAttr(doc.body, "data-hud", "boss")!;
    expect(byClass(boss, "boss-fill")).toHaveLength(1);
    expect(byClass(boss, "boss-fill")[0].style.width).toBe("100%");
    update(hudStateWith({ boss: { hp: 200, maxHp: 400, phase: 5 } }));
    expect(byClass(boss, "boss-fill")).toHaveLength(1);
    expect(byClass(boss, "boss-fill")[0].style.width).toBe("50%");
    expect(byClass(boss, "boss-hp")[0].textContent).toBe("200/400");
  });

  it("some quando o boss é derrotado (broadcast null → estado sem boss)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ boss: { hp: 400, maxHp: 400, phase: 5 } }));
    const boss = byAttr(doc.body, "data-hud", "boss")!;
    expect(boss.style.display).toBe("");
    update(hudState([]));
    expect(boss.style.display).toBe("none");
  });

  it("barra com HP zerado mostra 0% (estado residual antes do broadcast null)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ boss: { hp: 0, maxHp: 400, phase: 5 } }));
    const boss = byAttr(doc.body, "data-hud", "boss")!;
    expect(byClass(boss, "boss-fill")[0].style.width).toBe("0%");
    expect(byClass(boss, "boss-hp")[0].textContent).toBe("0/400");
  });
});

// ===== Fase/mapa — label no canto superior esquerdo =====

describe("formatPhaseLabel", () => {
  it("retorna vazio quando o estado não fornece fase nem mapa", () => {
    expect(formatPhaseLabel(undefined, undefined)).toBe("");
    expect(formatPhaseLabel("", "")).toBe("");
    expect(formatPhaseLabel("Fase 1", "")).toBe("Fase 1");
  });

  it("passa adiante strings prontas (ex.: 'Fase 1')", () => {
    expect(formatPhaseLabel("Fase 1", undefined)).toBe("Fase 1");
    expect(formatPhaseLabel(undefined, "Mapa 2")).toBe("Mapa 2");
  });

  it("formata número de fase como 'Fase N'", () => {
    expect(formatPhaseLabel(3, undefined)).toBe("Fase 3");
  });

  it("formata número de mapa como 'Mapa N' (ex.: 'Map 2')", () => {
    expect(formatPhaseLabel(undefined, 2)).toBe("Mapa 2");
  });

  it("junta fase e mapa com separador quando ambos existem", () => {
    expect(formatPhaseLabel("Fase 1", 2)).toBe("Fase 1 — Mapa 2");
    expect(formatPhaseLabel(1, 2)).toBe("Fase 1 — Mapa 2");
  });
});

describe("createHud — label de fase/mapa", () => {
  it("esconde a seção quando o estado não fornece fase nem mapa", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([]));
    const phase = byAttr(doc.body, "data-hud", "phase")!;
    expect(phase.style.display).toBe("none");
  });

  it("exibe a fase no canto superior esquerdo quando o estado fornece", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ phase: "Fase 1" }));
    const phase = byAttr(doc.body, "data-hud", "phase")!;
    expect(phase.textContent).toBe("📍 Fase 1");
    expect(phase.style.display).toBe("");
  });

  it("exibe '📍 Mapa N' quando o estado fornece só o número do mapa", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ map: 2 }));
    const phase = byAttr(doc.body, "data-hud", "phase")!;
    expect(phase.textContent).toBe("📍 Mapa 2");
  });

  it("atualiza o rótulo quando o estado muda (avanço de fase)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ phase: "Fase 1", map: 1 }));
    const phase = byAttr(doc.body, "data-hud", "phase")!;
    expect(phase.textContent).toBe("📍 Fase 1 — Mapa 1");
    update(hudStateWith({ phase: "Fase 2", map: 2 }));
    expect(phase.textContent).toBe("📍 Fase 2 — Mapa 2");
  });

  it("volta a esconder a seção quando o estado limpa fase/mapa", () => {
    const { update } = createHud({ root: doc.body });
    update(hudStateWith({ phase: "Fase 1" }));
    update(hudState([]));
    const phase = byAttr(doc.body, "data-hud", "phase")!;
    expect(phase.style.display).toBe("none");
  });
});

// ===== Setas de direção (companheiros fora do viewport) =====

describe("setas — helpers puros", () => {
  const cam = { x: 0, y: 0, width: 960, height: 540 };

  it("isOffscreen: dentro do viewport → false", () => {
    expect(isOffscreen(cam, 0, 0)).toBe(false);
    expect(isOffscreen(cam, 479, 269)).toBe(false);
    expect(isOffscreen(cam, -479, -269)).toBe(false);
  });

  it("isOffscreen: fora por qualquer lado → true", () => {
    expect(isOffscreen(cam, 481, 0)).toBe(true);
    expect(isOffscreen(cam, -481, 0)).toBe(true);
    expect(isOffscreen(cam, 0, 271)).toBe(true);
    expect(isOffscreen(cam, 0, -271)).toBe(true);
  });

  it("clampArrowPoint: alvo à direita → ponto na borda direita, mesma altura", () => {
    const p = clampArrowPoint(cam, 2000, 0);
    expect(p.x).toBe(480);
    expect(p.y).toBe(0);
  });

  it("clampArrowPoint: alvo à esquerda → ponto na borda esquerda", () => {
    const p = clampArrowPoint(cam, -2000, 0);
    expect(p.x).toBe(-480);
    expect(p.y).toBe(0);
  });

  it("clampArrowPoint: alvo abaixo → ponto na borda inferior", () => {
    const p = clampArrowPoint(cam, 0, 2000);
    expect(p.x).toBe(0);
    expect(p.y).toBe(270);
  });

  it("clampArrowPoint: diagonal preserva a direção (clampa no lado mais próximo)", () => {
    // 45° com |dx|=|dy|: halfW(480) > halfH(270) → clampa em y=270 e x=270.
    const p = clampArrowPoint(cam, 1000, 1000);
    expect(p.y).toBe(270);
    expect(p.x).toBeCloseTo(270, 5);
  });

  it("arrowView: null para alvo dentro do viewport", () => {
    expect(arrowView(cam, 100, 50)).toBeNull();
  });

  it("arrowView: posição em % da tela para alvo à direita", () => {
    const v = arrowView(cam, 2000, 0)!;
    expect(v.left).toBe(100);
    expect(v.top).toBe(50);
    expect(v.angleDeg).toBe(0);
  });

  it("arrowView: ângulo aponta para baixo (90°) e topo 100%", () => {
    const v = arrowView(cam, 0, 2000)!;
    expect(v.angleDeg).toBe(90);
    expect(v.top).toBe(100);
  });

  it("arrowView: ângulo para cima (-90°) e topo 0%", () => {
    const v = arrowView(cam, 0, -2000)!;
    expect(v.angleDeg).toBe(-90);
    expect(v.top).toBe(0);
  });

  it("playerAbbr: iniciais de nomes compostos / 2 primeiras letras / fallback", () => {
    expect(playerAbbr("Maria Silva")).toBe("MS");
    expect(playerAbbr("Jogador")).toBe("JO");
    expect(playerAbbr("")).toBe("?");
  });

  it("hudArrows: ignora o jogador local e quem está no viewport", () => {
    const arrows = hudArrows(
      hudState([
        player({ id: "p1", x: 0, y: 0 }), // local, dentro
        player({ id: "p2", x: 2000, y: 0 }), // remoto, fora
        player({ id: "p3", x: 100, y: 50 }), // remoto, dentro
      ])
    );
    expect(arrows.map((a) => a.id)).toEqual(["p2"]);
  });
});

describe("createHud — setas de direção", () => {
  it("renderiza seta para companheiro fora do viewport com cor e abreviatura", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([
        player({ id: "p1", x: 0, y: 0 }),
        player({ id: "p2", name: "Maria Silva", color: "rgb(255, 0, 0)", x: 2000, y: 0 }),
      ])
    );
    const layer = byAttr(doc.body, "data-hud", "arrows")!;
    const arrows = byClass(layer, "hud-arrow");
    expect(arrows).toHaveLength(1);
    expect(arrows[0].attrs["data-player-id"]).toBe("p2");
    expect(arrows[0].style.left).toBe("100%");
    expect(arrows[0].style.color).toBe("rgb(255, 0, 0)");
    const label = byClass(arrows[0], "hud-arrow-label")[0];
    expect(label.textContent).toBe("MS");
  });

  it("some quando o companheiro entra no viewport", () => {
    const { update } = createHud({ root: doc.body });
    const far = player({ id: "p2", x: 2000, y: 0 });
    update(hudState([player({ id: "p1", x: 0, y: 0 }), far]));
    const layer = byAttr(doc.body, "data-hud", "arrows")!;
    expect(byClass(layer, "hud-arrow")).toHaveLength(1);
    update(hudState([player({ id: "p1", x: 0, y: 0 }), { ...far, x: 100, y: 50 }]));
    expect(byClass(layer, "hud-arrow")).toHaveLength(0);
  });

  it("camada vazia sem companheiros fora do viewport", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([player({ id: "p1", x: 0, y: 0 }), player({ id: "p2", x: 100, y: 50 })])
    );
    const layer = byAttr(doc.body, "data-hud", "arrows")!;
    expect(layer.children).toHaveLength(0);
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

// ===== Efeitos de power-up + HP acima do teto =====

describe("formatEffectTime — tempo restante do tiro triplo (ticks → segundos)", () => {
  it("converte ticks do servidor em segundos (TicksPerSecond = 20)", () => {
    expect(formatEffectTime(200)).toBe("10s"); // PowerUpTiroTriploDurationTicks = 10 s exatos
    expect(formatEffectTime(20)).toBe("1s");
    expect(formatEffectTime(1)).toBe("1s");
  });

  it("arredonda para cima (nunca mostra 0s enquanto ativo)", () => {
    expect(formatEffectTime(21)).toBe("2s");
    expect(formatEffectTime(19)).toBe("1s");
    expect(formatEffectTime(5)).toBe("1s");
  });
});

describe("effectLabels — badges de efeitos ativos", () => {
  it("sem efeitos devolve lista vazia", () => {
    expect(effectLabels(undefined)).toEqual([]);
    expect(effectLabels({ vida: 0, tripleShot: 0, shield: 0 })).toEqual([]);
  });

  it("vida ativa mostra o bonus acima do teto", () => {
    expect(effectLabels({ vida: 25, tripleShot: 0, shield: 0 })).toEqual(["❤️+25"]);
  });

  it("tiro triplo ativo mostra o tempo restante", () => {
    expect(effectLabels({ vida: 0, tripleShot: 200, shield: 0 })).toEqual(["🔱10s"]);
    expect(effectLabels({ vida: 0, tripleShot: 150, shield: 0 })).toEqual(["🔱8s"]);
  });

  it("escudo ativo mostra o indicador de carga", () => {
    expect(effectLabels({ vida: 0, tripleShot: 0, shield: 1 })).toEqual(["🛡️"]);
  });

  it("todos os efeitos ativos aparecem juntos, em ordem estavel", () => {
    expect(effectLabels({ vida: 25, tripleShot: 200, shield: 1 })).toEqual([
      "❤️+25",
      "🔱10s",
      "🛡️",
    ]);
  });

  it("campos ausentes sao tratados como inativos (guarda defensiva)", () => {
    expect(effectLabels({} as any)).toEqual([]);
    expect(effectLabels({ vida: 25 } as any)).toEqual(["❤️+25"]);
  });
});

describe("HP acima do teto (power-up VIDA — 125/100)", () => {
  it("overMaxHp detecta HP acima do teto", () => {
    expect(overMaxHp(125, 100)).toBe(true);
    expect(overMaxHp(100, 100)).toBe(false);
    expect(overMaxHp(80, 100)).toBe(false);
  });

  it("hpOverflow devolve o excedente (0 quando dentro do teto)", () => {
    expect(hpOverflow(125, 100)).toBe(25);
    expect(hpOverflow(150, 100)).toBe(50);
    expect(hpOverflow(100, 100)).toBe(0);
    expect(hpOverflow(80, 100)).toBe(0);
    expect(hpOverflow(0, 100)).toBe(0);
  });

  it("playerRowView expoe hp sem clamp superior, overflow e labels", () => {
    const view = playerRowView(
      player({
        id: "p1",
        hp: 125,
        maxHp: 100,
        effects: { vida: 25, tripleShot: 200, shield: 1 },
      }),
      "p1"
    );
    expect(view.hp).toBe(125); // NAO clampa no teto — mostra o estado real
    expect(view.percent).toBe(100); // a barra satura no teto
    expect(view.overMax).toBe(true);
    expect(view.overflow).toBe(25);
    expect(view.effectsLabels).toEqual(["❤️+25", "🔱10s", "🛡️"]);
  });

  it("playerRowView mantem HP intermediario sem flags de over-max", () => {
    const view = playerRowView(player({ id: "p1", hp: 42, maxHp: 100 }), "p1");
    expect(view.hp).toBe(42);
    expect(view.percent).toBe(42);
    expect(view.overMax).toBe(false);
    expect(view.overflow).toBe(0);
    expect(view.effectsLabels).toEqual([]);
  });

  it("playerRowView clampa HP negativo em 0 (nunca mostra barra negativa)", () => {
    const view = playerRowView(player({ id: "p1", hp: -10, maxHp: 100 }), "p1");
    expect(view.hp).toBe(0);
    expect(view.percent).toBe(0);
  });
});

describe("createHud — render de efeitos e HP acima do teto", () => {
  it("HP acima do teto: texto cru, classe is-overmax e segmento de overflow", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([
        player({ id: "p1", hp: 125, maxHp: 100, effects: { vida: 25, tripleShot: 0, shield: 0 } }),
      ])
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const row = panel.children[0];
    expect(row.className).toContain("is-overmax");
    const hp = byClass(row, "player-hp")[0];
    expect(hp.textContent).toBe("125/100");
    const fill = byClass(row, "player-fill")[0];
    expect(fill.style.width).toBe("100%"); // barra satura no teto
    const over = byClass(row, "player-fill-over")[0];
    expect(over.style.width).toBe("25%"); // excedente em destaque
  });

  it("sem excedente nao renderiza o segmento de overflow", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1", hp: 75, maxHp: 100 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const row = panel.children[0];
    expect(row.className).not.toContain("is-overmax");
    expect(byClass(row, "player-fill-over")).toHaveLength(0);
  });

  it("renderiza badges de efeitos na linha do jogador", () => {
    const { update } = createHud({ root: doc.body });
    update(
      hudState([
        player({ id: "p1", hp: 125, maxHp: 100, effects: { vida: 25, tripleShot: 200, shield: 1 } }),
        player({ id: "p2", hp: 80, maxHp: 100 }),
      ])
    );
    const panel = byAttr(doc.body, "data-hud", "players")!;
    const withEffects = panel.children[0];
    const effects = byClass(withEffects, "player-effects")[0];
    expect(effects.textContent).toBe("❤️+25 🔱10s 🛡️");
    // Jogador sem efeitos nao ganha o elemento.
    expect(byClass(panel.children[1], "player-effects")).toHaveLength(0);
  });

  it("linha sem efeitos mantem a ordem original do grid (nome → barra → HP)", () => {
    const { update } = createHud({ root: doc.body });
    update(hudState([player({ id: "p1", hp: 42, maxHp: 100 })]));
    const panel = byAttr(doc.body, "data-hud", "players")!;
    expect(panel.children[0].children.map((c) => c.className)).toEqual([
      "player-name",
      "player-bar",
      "player-hp",
    ]);
  });
});
