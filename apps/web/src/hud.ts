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
 *     div.hud-players [data-hud="players"]  painel de HP dos jogadores (vazio até o subtask de placar)
 *     div.hud-arrows  [data-hud="arrows"]   camada de setas de direção (vazia até o subtask de setas)
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

/** Mensagem exibida quando o jogador local morre. */
export function formatDeathMessage(): string {
  return "💀 Você morreu! Recarregue a página para reiniciar.";
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

  el.append(phaseEl, coinsEl, statusEl, playersEl, arrowsEl);
  root.appendChild(el);

  function update(state: HudState): void {
    // Fase/mapa — topo, à esquerda (ex.: "📍 Fase 1 — Mapa 2").
    const phaseText = [state.phase, state.map]
      .filter((v) => v !== undefined && v !== "")
      .join(" — ");
    let anyVisible = false;

    if (phaseText) {
      phaseEl.textContent = `📍 ${phaseText}`;
      phaseEl.style.display = "";
      anyVisible = true;
    } else {
      phaseEl.style.display = "none";
    }

    // Moedas da equipe — topo, à direita.
    if (state.teamCoins !== undefined) {
      coinsEl.textContent = `🪙 ${state.teamCoins}`;
      coinsEl.style.display = "";
      anyVisible = true;
    } else {
      coinsEl.style.display = "none";
    }

    // Mensagem transitória (conexão, morte, ...).
    if (state.status) {
      statusEl.textContent = state.status;
      statusEl.style.display = "";
      anyVisible = true;
    } else {
      statusEl.style.display = "none";
    }

    // Overlay vazio não deve ser anunciado por leitores de tela; com conteúdo,
    // o aria-hidden é removido para as seções ficarem acessíveis.
    el.setAttribute("aria-hidden", anyVisible ? "false" : "true");

    // Seções de placar (players) e setas (arrows) ficam vazias até os
    // subtasks de feature implementarem o render em cima do mesmo state.
  }

  function destroy(): void {
    el.remove();
  }

  return { el, update, destroy };
}
