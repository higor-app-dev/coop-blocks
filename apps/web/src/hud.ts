/**
 * HUD — módulo único da interface do coop-blocks.
 *
 * Responsabilidades:
 * - criar e anexar o overlay DOM do HUD (`createHud`)
 * - receber o estado completo do jogo via `hud.update(state)` a cada frame
 * - expor o contrato de estado (`HudState` / `HudPlayer` / `HudCamera`) que os
 *   subtasks de feature (placar, setas, moedas, fase) implementam em cima
 *
 * O módulo NÃO importa kaplay: recebe posições/câmera prontas via state, então
 * é testável isoladamente. Os helpers puros de formatação continuam aqui
 * (`formatHud` / `formatDeathMessage`) para compatibilidade com o main.ts.
 *
 * Estrutura DOM gerada (seções encontradas via atributo `data-hud`):
 *   div.hud-root                    overlay fixo, pointer-events: none
 *     div.hud-phase   [data-hud="phase"]    fase/mapa (canto sup. esquerdo)
 *     div.hud-coins   [data-hud="coins"]    moedas da equipe (sup. direito)
 *     div.hud-status  [data-hud="status"]   mensagem transitória (centro-topo)
 *     div.hud-players [data-hud="players"]  painel de HP dos jogadores + moedas individuais
 *     div.hud-arrows  [data-hud="arrows"]   camada de setas de direção (vazia até o subtask de setas)
 *     button.hud-mute [data-hud="mute"]     mute de áudio (🔊/🔇, pointer-events: auto)
 */

// ===== Contrato de estado =====

/** Um jogador na sala (local ou remoto). */
export interface HudPlayer {
  id: string;
  /** Nome exibido no HUD. */
  name: string;
  /** Cor do jogador/equipe em formato CSS (hex ou rgb). */
  color: string;
  /** Identificador da equipe (opcional — agrupa jogadores por time). */
  team?: string;
  hp: number;
  maxHp: number;
  /** Posição no mundo (unidades do jogo). */
  x: number;
  y: number;
  /** Moedas individuais do jogador (opcional — só aparece se o servidor mandar). */
  coins?: number;
  /** true = morto/aguardando respawn. */
  respawning?: boolean;
  /** Segundos restantes até o respawn (opcional). */
  respawnIn?: number;
}

/** Câmera/viewport em coordenadas de mundo. */
export interface HudCamera {
  /** Centro da câmera no mundo. */
  x: number;
  y: number;
  /** Largura visível do viewport em unidades de mundo. */
  width: number;
  /** Altura visível do viewport em unidades de mundo. */
  height: number;
}

/**
 * Contrato de estado do HUD — passado a cada frame via `hud.update(state)`.
 * Campos opcionais ficam ocultos até os dados existirem: o servidor ainda não
 * envia nome/cor/moedas/fase; quando enviar, os subtasks de feature ligam os
 * campos e o HUD renderiza automaticamente.
 */
export interface HudState {
  /** Todos os jogadores da sala, incluindo o local. */
  players: HudPlayer[];
  /** Id do jogador local (para destacar na lista/setas). */
  localPlayerId: string;
  camera: HudCamera;
  /** Total de moedas da equipe (opcional). */
  teamCoins?: number;
  /** Fase atual (ex.: "Fase 1") ou número (opcional). */
  phase?: string | number;
  /** Número do mapa (opcional). */
  map?: string | number;
  /** Mensagem de status transitória (conexão, morte, ...). */
  status?: string;
}

/** Instância do HUD retornada por `createHud`. */
export interface Hud {
  /** Elemento raiz do overlay (anexado ao root em `createHud`). */
  el: HTMLElement;
  /** Atualiza todo o HUD a partir do estado do jogo. Chamar a cada frame. */
  update(state: HudState): void;
  /** Remove o overlay do DOM. */
  destroy(): void;
}

export interface CreateHudOpts {
  /** Container onde o overlay será anexado (default: document.body). */
  root?: HTMLElement;
  /** Estado inicial do mute (default: false). */
  muted?: boolean;
  /** Chamado quando o usuário alterna o mute (recebe o novo estado). */
  onMuteToggle?: (muted: boolean) => void;
}

// ===== Persistência do mute (sessão) =====

/** Chave no sessionStorage que guarda o estado de mute ("1" | "0"). */
export const MUTE_STORAGE_KEY = "coop-blocks:muted";

/**
 * Lê o estado de mute persistido na sessão. Nunca lança: em ambientes sem
 * sessionStorage (SSR/testes) retorna o fallback informado.
 */
export function loadMutedSession(fallback = false): boolean {
  try {
    const raw = globalThis.sessionStorage?.getItem(MUTE_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Persiste o estado de mute na sessão. No-op silencioso sem sessionStorage. */
export function saveMutedSession(muted: boolean): void {
  try {
    globalThis.sessionStorage?.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // sem storage — mute vale só para esta sessão de execução
  }
}

// ===== Helpers puros (testáveis) =====

/** Clamp de HP em [0, maxHp], alinhado ao servidor que nunca deixa HP negativo. */
export function clampHp(hp: number, maxHp: number): number {
  return Math.max(0, Math.min(hp, maxHp));
}

/**
 * Formata a linha do HUD: HP (com clamp) e contagem de jogadores online.
 * Mantido para compatibilidade; o fluxo principal agora usa `hud.update`.
 */
export function formatHud(hp: number, maxHp: number, netCount: number): string {
  const shown = clampHp(hp, maxHp);
  return `🧱 coop-blocks — HP ${shown}/${maxHp} — jogadores online: ${netCount}`;
}

/** Mensagem exibida quando o jogador local morre (respawn automático em ~3s). */
export function formatDeathMessage(): string {
  return "💀 Você morreu! Voltando em instantes...";
}

// ===== Contador de moedas =====
//
// O contador tem dois modos, definidos pelos dados que o estado fornece:
//   - modo time:    state.teamCoins definido → total da equipe no canto
//                   superior direito ([data-hud=coins]);
//   - modo individual: player.coins definido → badge por jogador na linha
//                   do painel ([data-hud=players]).
// Os dois modos coexistem quando ambos os dados chegam.

/**
 * Rótulo de moedas exibido no HUD. Retorna "" quando o estado não fornece
 * o dado (modo desligado); caso contrário formata "🪙 N" com o valor
 * inteiro, nunca negativo.
 */
export function formatCoins(coins?: number): string {
  if (coins === undefined) return "";
  return `🪙 ${Math.max(0, Math.floor(coins))}`;
}

// ===== Painel de jogadores — helpers puros (testáveis) =====

/**
 * Percentual de HP exibido na barra do painel (0–100, clamp).
 * maxHp <= 0 nunca divide por zero (estado indefinido → barra vazia).
 */
export function hpPercent(p: HudPlayer): number {
  if (p.maxHp <= 0) return 0;
  return Math.round((clampHp(p.hp, p.maxHp) / p.maxHp) * 100);
}

/**
 * Rótulo do estado de respawn com contagem regressiva.
 * - Sem timer informado (ou zerado/negativo): rótulo genérico de espera.
 * - Com timer: segundos arredondados para cima, clampados em 3s (teto do
 *   servidor — DefaultRespawnTicks = 60 ticks @ 20 tps = 3 s).
 */
export function formatRespawnLabel(respawnIn?: number): string {
  if (respawnIn === undefined || respawnIn <= 0) return "💀 respawn...";
  return `💀 ${Math.min(3, Math.ceil(respawnIn))}s`;
}

/** true = jogador fora de combate (morto ou aguardando respawn). */
export function isPlayerDown(p: HudPlayer): boolean {
  return p.respawning === true || p.hp <= 0;
}

/** Visão derivada de um jogador para o painel — pura e testável. */
export interface PlayerRowView {
  name: string;
  color: string;
  /** HP exibido (clampado em [0, maxHp]). */
  hp: number;
  maxHp: number;
  /** Percentual de preenchimento da barra (0–100). */
  percent: number;
  /** true = morto/aguardando respawn (barra trocada pelo estado de espera). */
  down: boolean;
  /** true = jogador local (destacado na lista). */
  local: boolean;
  /** Rótulo de respawn com contagem (vazio quando vivo). */
  respawnLabel: string;
  /** Rótulo de moedas individuais (vazio quando o estado não fornece). */
  coinsLabel: string;
}

/** Deriva a visão de exibição de um jogador a partir do estado bruto. */
export function playerRowView(p: HudPlayer, localPlayerId: string): PlayerRowView {
  const down = isPlayerDown(p);
  return {
    name: p.name,
    color: p.color,
    hp: clampHp(p.hp, p.maxHp),
    maxHp: p.maxHp,
    percent: hpPercent(p),
    down,
    local: p.id === localPlayerId,
    respawnLabel: down ? formatRespawnLabel(p.respawnIn) : "",
    coinsLabel: formatCoins(p.coins),
  };
}

/** Constrói a linha do painel de um jogador (nome + barra de HP + respawn). */
function renderPlayerRow(p: HudPlayer, localPlayerId: string): HTMLDivElement {
  const view = playerRowView(p, localPlayerId);

  const row = document.createElement("div");
  row.className = view.local ? "player-row is-local" : "player-row";
  row.setAttribute("data-player-id", p.id);

  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = view.name;
  name.style.color = view.color;

  const hp = document.createElement("span");
  hp.className = "player-hp";
  hp.textContent = `${view.hp}/${view.maxHp}`;

  const bar = document.createElement("div");
  bar.className = "player-bar";
  const fill = document.createElement("div");
  fill.className = "player-fill";
  fill.style.width = `${view.percent}%`;
  fill.style.background = view.color;
  bar.appendChild(fill);

  // Ordem = grid do CSS (auto | minmax(70px,1fr) | auto | auto): nome fixo,
  // barra flexível no meio, números à direita e moedas na última coluna.
  row.append(name, bar, hp);

  // Moedas individuais — badge na última coluna do grid; só aparece quando
  // o estado fornece player.coins e o jogador está vivo (morto/aguardando
  // respawn troca a linha pelo estado de espera e o contador da fase zera).
  if (view.coinsLabel && !view.down) {
    const coins = document.createElement("span");
    coins.className = "player-coins";
    coins.textContent = view.coinsLabel;
    row.appendChild(coins);
  }

  // Morto/aguardando respawn: a barra é ocultada via CSS (.is-down) e o
  // estado de espera com contagem aparece no lugar.
  if (view.down) {
    row.classList.add("is-down");
    const respawn = document.createElement("div");
    respawn.className = "player-respawn";
    respawn.textContent = view.respawnLabel;
    row.appendChild(respawn);
  }

  return row;
}

// ===== Overlay DOM =====

const SECTION_ATTR = "data-hud";

function section(className: string, name: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.setAttribute(SECTION_ATTR, name);
  return el;
}

/**
 * Cria o overlay do HUD e o anexa ao root (default: document.body).
 * O overlay nasce vazio; `update(state)` preenche fase/moedas/status e guarda
 * o estado para as seções de placar/setas, que os subtasks de feature
 * implementam em cima desta mesma estrutura.
 */
export function createHud(opts: CreateHudOpts = {}): Hud {
  const root = opts.root ?? document.body;

  const el = document.createElement("div");
  el.className = "hud-root";
  el.setAttribute("aria-hidden", "true");

  const phaseEl = section("hud-phase", "phase");
  const coinsEl = section("hud-coins", "coins");
  const statusEl = section("hud-status", "status");
  const playersEl = section("hud-players", "players");
  const arrowsEl = section("hud-arrows", "arrows");

  // Botão de mute: estado visual sincronizado, clique chama onMuteToggle.
  // O overlay raiz tem pointer-events: none (para não bloquear o jogo); o
  // botão reabilita pointer-events via classe CSS .hud-mute.
  let muted = opts.muted ?? false;
  const muteBtn = document.createElement("button");
  muteBtn.className = "hud-mute";
  muteBtn.type = "button";
  muteBtn.setAttribute(SECTION_ATTR, "mute");
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteBtn.setAttribute("aria-label", muted ? "Ativar som" : "Silenciar");
  muteBtn.title = muted ? "Ativar som" : "Silenciar";
  muteBtn.textContent = muted ? "🔇" : "🔊";
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    muteBtn.textContent = muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.setAttribute("aria-label", muted ? "Ativar som" : "Silenciar");
    muteBtn.title = muted ? "Ativar som" : "Silenciar";
    opts.onMuteToggle?.(muted);
  });

  el.append(phaseEl, coinsEl, statusEl, playersEl, arrowsEl, muteBtn);
  root.appendChild(el);

  function update(state: HudState): void {
    // Fase/mapa — topo, à esquerda (ex.: "📍 Fase 1 — Mapa 2").
    const phaseText = [state.phase, state.map]
      .filter((v) => v !== undefined && v !== "")
      .join(" — ");

    if (phaseText) {
      phaseEl.textContent = `📍 ${phaseText}`;
      phaseEl.style.display = "";
    } else {
      phaseEl.style.display = "none";
    }

    // Moedas da equipe — topo, à direita (modo time do contador; o modo
    // individual renderiza por jogador no painel abaixo).
    if (state.teamCoins !== undefined) {
      coinsEl.textContent = formatCoins(state.teamCoins);
      coinsEl.style.display = "";
    } else {
      coinsEl.style.display = "none";
    }

    // Mensagem transitória (conexão, morte, ...).
    if (state.status) {
      statusEl.textContent = state.status;
      statusEl.style.display = "";
    } else {
      statusEl.style.display = "none";
    }

    // O botão de mute está sempre presente e é interativo — o overlay nunca
    // fica aria-hidden (seções vazias não são anunciadas, pois não têm texto).
    el.setAttribute("aria-hidden", "false");

    // Painel de HP: uma linha por jogador da sala (local incluso e
    // destacado). Mortos/aguardando respawn trocam a barra pelo estado de
    // espera com contagem regressiva (quando o estado fornece o timer).
    playersEl.replaceChildren(
      ...state.players.map((p) => renderPlayerRow(p, state.localPlayerId))
    );

    // Seções de setas (arrows) ficam vazias até o subtask de setas
    // implementar o render em cima do mesmo state.
  }

  function destroy(): void {
    el.remove();
  }

  return { el, update, destroy };
}
