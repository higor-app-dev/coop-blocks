/**
 * Loja entre fases (client) — apps/web/src/shop.ts
 *
 * Overlay DOM full-screen que aparece quando o servidor abre a loja
 * (broadcast phase="shop", enviado ao fim de cada mapa) e some quando TODOS
 * os jogadores confirmam 'pronto' (broadcast phase="playing" do próximo mapa).
 *
 * Contrato com o servidor (wire protocol, espelho de messages.go):
 *   server → client:
 *     {type:"phase", phase:"shop"|"playing", number, ready:{id:bool},
 *      players:[{id, coins, stats:{maxHp, fireRate, shield}}]}
 *     {type:"shop_buy_result", ok:true, upgrade, level, cost, coins,
 *      stats:{maxHp, fireRate, shield}}   — resposta INDIVIDUAL de compra
 *     {type:"shop_buy_result", ok:false, error} / {type:"shop_ready_result",
 *      ok:false, error}
 *   client → server:
 *     {type:"shop_buy", upgrade:"max_hp"|"fire_rate"|"shield"}
 *     {type:"shop_ready"}
 *
 * O módulo NÃO importa kaplay: recebe o estado pronto via `update(state, myId)`
 * e devolve chamadas de intenção (`onBuy` / `onReady`). A lógica pura
 * (catálogo, nível derivado de stats, habilitação de compra) fica exportada
 * para testes sem DOM.
 */

// ===== Tipos do wire protocol =====

/** IDs dos upgrades do catálogo (mesmos do servidor, shop.go). */
export type UpgradeID = "max_hp" | "fire_rate" | "shield";

/** Estatísticas efetivas de um jogador (upgrades aplicados). */
export interface ShopStats {
  maxHp: number;
  fireRate: number;
  shield: number;
}

/** Estado individual de um jogador no broadcast de fase. */
export interface ShopPlayer {
  id: string;
  coins: number;
  stats: ShopStats;
}

/** Estado de fase broadcastado pelo servidor. */
export interface ShopPhaseState {
  phase: "shop" | "playing";
  number: number;
  ready: Record<string, boolean>;
  players: ShopPlayer[];
}

/** Comprovante de compra (resposta individual de shop_buy). */
export interface BuyReceipt {
  upgrade: UpgradeID;
  level: number;
  cost: number;
  coins: number;
  stats: ShopStats;
}

/**
 * Comprovante como chega do wire protocol (upgrade em string livre).
 * O overlay não valida o id — ele só atualiza saldo/stats do comprador.
 */
export type ShopReceipt = Omit<BuyReceipt, "upgrade"> & { upgrade: string };

// ===== Catálogo (espelho das constantes do servidor, shop.go) =====

export const BASE_MAX_HP = 100; // teto base (DefaultMaxHP)
export const MAX_HP_PER_LEVEL = 25; // +HP por nível de max_hp
export const FIRE_RATE_PER_LEVEL = 0.2; // +multiplicador por nível de fire_rate

export interface UpgradeDef {
  id: UpgradeID;
  name: string;
  icon: string;
  desc: string;
  cost: number;
  maxLevel: number;
}

/** Catálogo exibido na loja. Custos/níveis máximos alinhados ao servidor. */
export const UPGRADE_CATALOG: UpgradeDef[] = [
  {
    id: "max_hp",
    name: "Vida Máxima",
    icon: "❤️",
    desc: `+${MAX_HP_PER_LEVEL} HP por nível`,
    cost: 50,
    maxLevel: 3,
  },
  {
    id: "fire_rate",
    name: "Cadência de Tiro",
    icon: "🔥",
    desc: `+${Math.round(FIRE_RATE_PER_LEVEL * 100)}% cadência por nível`,
    cost: 40,
    maxLevel: 3,
  },
  {
    id: "shield",
    name: "Escudo",
    icon: "🛡️",
    desc: "+1 carga que absorve um hit",
    cost: 30,
    maxLevel: 3,
  },
];

// ===== Lógica pura (testável sem DOM) =====

/**
 * Nível atual de um upgrade derivado das stats efetivas do jogador.
 * As stats são a fonte autoritativa (o servidor as calcula de shop.Stats);
 * aqui invertemos a fórmula do servidor para exibir "Lv X/3" no card.
 */
export function upgradeLevel(stats: ShopStats, id: UpgradeID): number {
  switch (id) {
    case "max_hp":
      return Math.max(0, Math.round((stats.maxHp - BASE_MAX_HP) / MAX_HP_PER_LEVEL));
    case "fire_rate":
      return Math.max(0, Math.round((stats.fireRate - 1) / FIRE_RATE_PER_LEVEL));
    case "shield":
      return Math.max(0, stats.shield);
  }
}

/** true quando o upgrade já está no nível máximo (não pode mais comprar). */
export function isMaxed(stats: ShopStats, def: UpgradeDef): boolean {
  return upgradeLevel(stats, def.id) >= def.maxLevel;
}

/**
 * Habilita a compra de um upgrade: precisa ter moedas para o custo E ainda
 * não estar no nível máximo. Espelha as rejeições do servidor
 * (ErrInsufficientCoins / ErrUpgradeMaxed) para o botão desabilitar antes.
 */
export function canBuy(coins: number, stats: ShopStats, def: UpgradeDef): boolean {
  return coins >= def.cost && !isMaxed(stats, def);
}

/** Conta quantos jogadores da loja já confirmaram 'pronto'. */
export function readyCount(state: ShopPhaseState): number {
  return state.players.filter((p) => state.ready[p.id]).length;
}

// ===== Overlay DOM =====

const SHOP_ATTR = "data-shop";

export interface ShopOpts {
  /** Container onde o overlay será anexado (default: document.body). */
  root?: HTMLElement;
  /** Chamado quando o jogador clica em "Comprar" num upgrade. */
  onBuy: (upgrade: UpgradeID) => void;
  /** Chamado quando o jogador clica em "Pronto". */
  onReady: () => void;
}

export interface Shop {
  /** Elemento raiz do overlay. */
  el: HTMLElement;
  /** Atualiza a tela a partir do último broadcast de fase. */
  update(state: ShopPhaseState, myId: string): void;
  /** Aplica o comprovante de compra (resposta individual do servidor). */
  applyBuyResult(rc: ShopReceipt): void;
  /** Exibe uma mensagem de erro transitória (compra/pronto rejeitados). */
  showError(msg: string): void;
  /** Remove o overlay do DOM. */
  destroy(): void;
}

/**
 * Cria o overlay da loja e o anexa ao root. Nasce oculto
 * (display:none) — `update` com phase="shop" o exibe e renderiza.
 */
export function createShop(opts: ShopOpts): Shop {
  const root = opts.root ?? document.body;

  const el = document.createElement("div");
  el.className = "shop-root";
  el.setAttribute(SHOP_ATTR, "root");
  el.style.display = "none";

  // Estado interno: último broadcast + meu id, para re-render após compra.
  let state: ShopPhaseState = { phase: "playing", number: 1, ready: {}, players: [] };
  let myId = "";
  let errorMsg = "";

  // ---- Estrutura estática ----
  const title = document.createElement("h2");
  title.className = "shop-title";
  title.setAttribute(SHOP_ATTR, "title");

  const balance = document.createElement("div");
  balance.className = "shop-balance";
  balance.setAttribute(SHOP_ATTR, "balance");

  const cards = document.createElement("div");
  cards.className = "shop-cards";
  cards.setAttribute(SHOP_ATTR, "cards");

  const readyList = document.createElement("div");
  readyList.className = "shop-ready-list";
  readyList.setAttribute(SHOP_ATTR, "ready-list");

  const readyBtn = document.createElement("button");
  readyBtn.type = "button";
  readyBtn.className = "shop-ready";
  readyBtn.setAttribute(SHOP_ATTR, "ready");
  readyBtn.addEventListener("click", () => opts.onReady());

  const error = document.createElement("div");
  error.className = "shop-error";
  error.setAttribute(SHOP_ATTR, "error");

  el.append(title, balance, cards, readyList, readyBtn, error);
  root.appendChild(el);

  // ---- Render ----

  function renderCard(def: UpgradeDef): HTMLDivElement {
    const mine = state.players.find((p) => p.id === myId);
    const coins = mine?.coins ?? 0;
    const stats = mine?.stats ?? { maxHp: BASE_MAX_HP, fireRate: 1, shield: 0 };
    const level = upgradeLevel(stats, def.id);
    const maxed = isMaxed(stats, def);
    const affordable = canBuy(coins, stats, def);

    const card = document.createElement("div");
    card.className = "shop-card";
    card.setAttribute(SHOP_ATTR, "card");
    card.setAttribute("data-upgrade", def.id);

    const icon = document.createElement("div");
    icon.className = "shop-card-icon";
    icon.textContent = def.icon;

    const name = document.createElement("div");
    name.className = "shop-card-name";
    name.textContent = def.name;

    const desc = document.createElement("div");
    desc.className = "shop-card-desc";
    desc.textContent = `${def.desc} — Lv ${level}/${def.maxLevel}`;

    const info = document.createElement("div");
    info.className = "shop-card-info";
    info.append(name, desc);

    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "shop-buy";
    buy.setAttribute(SHOP_ATTR, "buy");
    buy.setAttribute("data-upgrade", def.id);
    if (maxed) {
      buy.textContent = "MÁXIMO";
      buy.disabled = true;
    } else {
      buy.textContent = `Comprar — ${def.cost} 🪙`;
      buy.disabled = !affordable;
      buy.title = affordable ? "" : "Moedas insuficientes";
      buy.addEventListener("click", () => opts.onBuy(def.id));
    }

    card.append(icon, info, buy);
    return card;
  }

  function renderReadyList(): void {
    readyList.replaceChildren();
    for (const p of state.players) {
      const isMe = p.id === myId;
      const ready = !!state.ready[p.id];
      const item = document.createElement("div");
      item.className = "shop-ready-item";
      item.setAttribute(SHOP_ATTR, "ready-item");
      item.setAttribute("data-ready", String(ready));
      item.textContent = `${ready ? "✅" : "⏳"} ${isMe ? "Você" : "Jogador"} — ${p.coins} 🪙`;
      readyList.append(item);
    }
  }

  function renderReadyButton(): void {
    const mine = state.players.find((p) => p.id === myId);
    const meReady = mine ? !!state.ready[myId] : false;
    const total = state.players.length;
    const done = readyCount(state);
    if (meReady) {
      readyBtn.textContent = `Aguardando outros jogadores... (${done}/${total})`;
      readyBtn.disabled = true;
    } else {
      readyBtn.textContent = "Pronto ✓";
      readyBtn.disabled = false;
    }
  }

  function render(): void {
    title.textContent = `🛒 Loja — Fase ${state.number}`;
    const mine = state.players.find((p) => p.id === myId);
    balance.textContent = mine ? `🪙 ${mine.coins} moedas` : "🪙 —";

    cards.replaceChildren(...state.players.length ? UPGRADE_CATALOG.map(renderCard) : []);

    renderReadyList();
    renderReadyButton();

    if (errorMsg) {
      error.textContent = errorMsg;
      error.style.display = "";
    } else {
      error.style.display = "none";
    }
  }

  // ---- API ----

  function update(next: ShopPhaseState, id: string): void {
    state = next;
    myId = id;
    el.style.display = next.phase === "shop" ? "" : "none";
    if (next.phase === "shop") render();
  }

  function applyBuyResult(rc: ShopReceipt): void {
    // Atualiza o estado local com o comprovante (saldo + stats do comprador)
    // sem esperar o próximo broadcast de fase — a tela reflete a compra na
    // hora. O servidor já debitou; o próximo broadcast traz o mesmo estado.
    state = {
      ...state,
      players: state.players.map((p) =>
        p.id === myId
          ? { ...p, coins: rc.coins, stats: rc.stats }
          : p
      ),
    };
    render();
  }

  function showError(msg: string): void {
    errorMsg = msg;
    if (state.phase === "shop") render();
  }

  function destroy(): void {
    el.remove();
  }

  return { el, update, applyBuyResult, showError, destroy };
}
