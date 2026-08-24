/**
 * Camada única de input do jogo (teclado + touch).
 *
 * Responsabilidades:
 * - Detectar o modo de entrada (touch vs teclado), usando k.isTouchscreen()
 *   do Kaplay como chute inicial e eventos de teclado/toque para decidir de
 *   forma definitiva: o PRIMEIRO input real (keydown ou toque) trava o modo.
 * - Teclado (desktop): setas esquerda/direita, A/D, Espaço (pulo) e J (tiro).
 *   Expõe estado digital de direção (-1/0/1), jumpPressed e shootPressed com
 *   detecção de borda — dispara uma única vez por pressão, sem repetição
 *   contínua enquanto a tecla é segurada.
 * - Touch (mobile): zonas virtuais generosas (raio ≥ 48px) no canto inferior
 *   esquerdo (◀ ▶) e inferior direito (PULO, TIRO), respeitando safe-area.
 *
 * O módulo NÃO desenha botões: expõe os retângulos/centros das zonas e APIs
 * para o main.ts criar os sprites e fazer hit-test de pontos nas zonas.
 *
 * Partes puras (computeTouchZones, isPointInZone, InputController) não tocam
 * em DOM/Kaplay e são testáveis isoladamente com vitest. A fiação real com o
 * Kaplay acontece em createInput(k).
 */

import type { KAPLAYCtx, KEventController } from "kaplay";

// ===== Tipos públicos =====

/** Modo de entrada atual. */
export type InputMode = "touch" | "keyboard";

/** Nome canônico de ação do jogador. */
export type ActionName = "left" | "right" | "jump" | "shoot";

/**
 * Estado digital consumido pelo game loop (uma vez por frame, via poll()).
 * jumpPressed/shootPressed são borda: true apenas no poll seguinte à
 * pressão, e false em seguida mesmo que a tecla/zona continue pressionada.
 */
export interface InputFrame {
  direction: -1 | 0 | 1;
  jumpPressed: boolean;
  shootPressed: boolean;
}

export interface Vec2Like {
  x: number;
  y: number;
}

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TouchZoneId = "left" | "right" | "jump" | "shoot";

/**
 * Zona virtual de toque. center/radius servem para hit-test (polegar);
 * rect serve para o main.ts desenhar o botão.
 */
export interface TouchZone {
  id: TouchZoneId;
  center: Vec2Like;
  radius: number;
  rect: RectLike;
}

/** Insetos de safe-area (notch/home bar), em px, lidos do CSS env(). */
export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// ===== Mapeamento de teclas (desktop) =====

/** Teclas ligadas no main.ts atual (legado, compatível com o bind antigo). */
export const ACTION_KEYS = ["left", "right", "space", "x"] as const;

export type PlayerAction =
  | { type: "move"; dir: -1 | 1 }
  | { type: "jump" }
  | { type: "shoot" };

/** Mapa completo tecla Kaplay → ação. Cobre setas, WASD, espaço e J. */
const KEY_TO_ACTION: Readonly<Record<string, PlayerAction>> = {
  left: { type: "move", dir: -1 },
  right: { type: "move", dir: 1 },
  a: { type: "move", dir: -1 },
  d: { type: "move", dir: 1 },
  space: { type: "jump" },
  j: { type: "shoot" },
  // mantido por compatibilidade com o bind legado do main.ts
  x: { type: "shoot" },
};

/** Teclas que alimentam o InputController (estado digital com borda). */
const KEY_ACTIONS: Readonly<Record<string, ActionName>> = {
  left: "left",
  right: "right",
  a: "left",
  d: "right",
  space: "jump",
  j: "shoot",
  // compat com o bind legado do main.ts (X também atira)
  x: "shoot",
};
export { KEY_ACTIONS };

/**
 * Traduz o nome de uma tecla Kaplay na ação correspondente (legado, puro).
 * Normaliza para minúsculas; teclas desconhecidas retornam null (não lança).
 */
export function keyToAction(key: string): PlayerAction | null {
  if (typeof key !== "string") return null;
  return KEY_TO_ACTION[key.toLowerCase()] ?? null;
}

// ===== Geometria das zonas de toque (pura) =====

export interface TouchZoneLayoutOpts {
  /** Largura do canvas (coordenadas internas do jogo). */
  width: number;
  /** Altura do canvas (coordenadas internas do jogo). */
  height: number;
  /** Insetos de safe-area nas mesmas coordenadas (default: 0). */
  safe?: Partial<SafeArea>;
  /** Raio mínimo da zona de toque (default 56; nunca abaixo de 48). */
  radius?: number;
  /** Margem das bordas do canvas (default 12). */
  margin?: number;
  /** Espaço entre botões (default 16). */
  gap?: number;
}

/**
 * Calcula as zonas virtuais de toque:
 * - ◀ ▶ no canto inferior esquerdo (movimento);
 * - PULO no canto inferior direito e TIRO logo acima dele (polegar direito).
 *
 * Zonas generosas para polegar (raio ≥ 48px) e deslocadas pelos insetos de
 * safe-area. Função pura — não toca em DOM/Kaplay.
 */
export function computeTouchZones(opts: TouchZoneLayoutOpts): TouchZone[] {
  const { width, height } = opts;
  const safe: SafeArea = { top: 0, bottom: 0, left: 0, right: 0, ...opts.safe };
  const radius = Math.max(48, opts.radius ?? 56);
  const margin = Math.max(8, opts.margin ?? 12);
  const gap = Math.max(8, opts.gap ?? 16);
  const d = radius * 2;

  const bottomY = height - safe.bottom - margin;
  const leftX = safe.left + margin;

  const left: TouchZone = {
    id: "left",
    center: { x: leftX + radius, y: bottomY - radius },
    radius,
    rect: { x: leftX, y: bottomY - d, w: d, h: d },
  };

  const right: TouchZone = {
    id: "right",
    center: { x: left.center.x + d + gap, y: left.center.y },
    radius,
    rect: { x: left.rect.x + d + gap, y: left.rect.y, w: d, h: d },
  };

  const jump: TouchZone = {
    id: "jump",
    center: { x: width - safe.right - margin - radius, y: bottomY - radius },
    radius,
    rect: { x: width - safe.right - margin - d, y: bottomY - d, w: d, h: d },
  };

  const shoot: TouchZone = {
    id: "shoot",
    center: { x: jump.center.x, y: jump.center.y - d - gap },
    radius,
    rect: { x: jump.rect.x, y: jump.rect.y - d - gap, w: d, h: d },
  };

  return [left, right, jump, shoot];
}

/** Hit-test circular: ponto dentro do raio da zona? (pura) */
export function isPointInZone(zone: TouchZone, p: Vec2Like): boolean {
  const dx = p.x - zone.center.x;
  const dy = p.y - zone.center.y;
  return dx * dx + dy * dy <= zone.radius * zone.radius;
}

/**
 * Fator de conversão CSS px → unidades de jogo sob letterbox.
 *
 * Com letterbox o viewport do jogo (k.width()×k.height(), ex.: 960x540) é
 * escalado para caber no canvas; o fator uniforme é min(cssW/gameW,
 * cssH/gameH). Dimensões inválidas (0/negativo) retornam 1 — sem divisão por
 * zero. Função pura — testável sem DOM/Kaplay.
 */
export function cssToGameScale(
  cssW: number,
  cssH: number,
  gameW: number,
  gameH: number
): number {
  if (cssW <= 0 || cssH <= 0 || gameW <= 0 || gameH <= 0) return 1;
  return Math.min(cssW / gameW, cssH / gameH);
}

/**
 * Converte insetos de safe-area de CSS px para unidades de jogo.
 *
 * `scale` é o fator de `cssToGameScale`. Quando css/game são informados,
 * desconta a barra do letterbox antes de converter: o trecho do inset que
 * cai na barra (fora da área do jogo) não desloca elementos do jogo. Sem
 * dimensões CSS (ou escala ≤ 0) faz a divisão simples — fallback preserva
 * os insetos quando a escala é inválida.
 */
export function safeAreaToGame(
  safe: SafeArea,
  scale: number,
  css?: { w: number; h: number },
  game?: { w: number; h: number }
): SafeArea {
  const s = scale > 0 ? scale : 1;
  // Barra do letterbox em CSS px por borda (0 quando o jogo encosta nela).
  let barTop = 0;
  let barRight = 0;
  let barBottom = 0;
  let barLeft = 0;
  if (
    css &&
    game &&
    css.w > 0 &&
    css.h > 0 &&
    game.w > 0 &&
    game.h > 0
  ) {
    const vpW = game.w * s;
    const vpH = game.h * s;
    barLeft = Math.max(0, (css.w - vpW) / 2);
    barRight = barLeft;
    barTop = Math.max(0, (css.h - vpH) / 2);
    barBottom = barTop;
  }
  const toGame = (inset: number, bar: number): number =>
    Math.max(0, inset - bar) / s;
  return {
    top: toGame(safe.top, barTop),
    right: toGame(safe.right, barRight),
    bottom: toGame(safe.bottom, barBottom),
    left: toGame(safe.left, barLeft),
  };
}

/**
 * Lê os insetos de safe-area do CSS env(safe-area-inset-*). Em ambiente sem
 * DOM (vitest/node) ou quando o browser não suporta env(), retorna 0s.
 *
 * O resultado é cacheado por orientação (retrato/paisagem): os insetos só
 * mudam na rotação, e este helper é consultado a cada evento de toque
 * (hit-test de zonas) — sondar o DOM por chamada causaria jank no mobile.
 */
export function readSafeArea(): SafeArea {
  const zero: SafeArea = { top: 0, bottom: 0, left: 0, right: 0 };
  if (typeof document === "undefined") return zero;
  try {
    const key =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(orientation: portrait)").matches ?? true)
        ? "portrait"
        : "landscape";
    if (safeAreaCacheKey === key && safeAreaCacheValue) {
      return safeAreaCacheValue;
    }
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) " +
      "env(safe-area-inset-bottom) env(safe-area-inset-left);";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const parse = (v: string): number => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const safe: SafeArea = {
      top: parse(cs.paddingTop),
      right: parse(cs.paddingRight),
      bottom: parse(cs.paddingBottom),
      left: parse(cs.paddingLeft),
    };
    probe.remove();
    safeAreaCacheKey = key;
    safeAreaCacheValue = safe;
    return safe;
  } catch {
    return zero;
  }
}

/** Cache por orientação do probe de safe-area (ver readSafeArea). */
let safeAreaCacheKey = "";
let safeAreaCacheValue: SafeArea | null = null;

// Os insetos também mudam quando a barra do browser recolhe/expande (sem
// rotação) — invalidar no resize mantém o cache fresco sem sondar o DOM a
// cada toque. Guard para ambientes sem window (vitest/node).
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    safeAreaCacheKey = "";
    safeAreaCacheValue = null;
  });
}

// ===== Máquina de estado de input (pura, sem DOM/Kaplay) =====

export interface InputControllerOpts {
  /** Modo inicial (default "keyboard"). Em runtime, createInput passa k.isTouchscreen(). */
  initialMode?: InputMode;
  /** Chamado quando o modo muda por causa do primeiro input real. */
  onModeChange?: (mode: InputMode) => void;
}

/**
 * Controlador de input puro: recebe eventos (pressKey/releaseKey/touchStart/
 * touchEnd) e produz o estado digital via poll().
 *
 * Detecção de borda: jumpPressed/shootPressed viram true apenas na transição
 * solto → pressionado; segurar não re-dispara (imune a auto-repeat do teclado
 * e a onKeyPress repetido do Kaplay).
 *
 * Modo: o primeiro input real (keydown ou toque) trava o modo; antes disso o
 * modo inicial (k.isTouchscreen()) vale.
 */
export class InputController {
  private mode: InputMode;
  private modeLocked = false;
  private onModeChange?: (mode: InputMode) => void;
  private keys = new Set<ActionName>();
  private touchZones = new Set<TouchZoneId>();
  private jumpEdge = false;
  private shootEdge = false;

  constructor(opts: InputControllerOpts = {}) {
    this.mode = opts.initialMode ?? "keyboard";
    this.onModeChange = opts.onModeChange;
  }

  getMode(): InputMode {
    return this.mode;
  }

  isTouchMode(): boolean {
    return this.mode === "touch";
  }

  /**
   * Registra o primeiro input real e trava o modo definitivamente.
   * "Tocar na tela antes de um keydown deve marcar o modo como touch" —
   * e simetricamente, keydown antes de qualquer toque marca teclado.
   */
  private noteInput(mode: InputMode): void {
    if (this.modeLocked) return;
    this.modeLocked = true;
    if (mode !== this.mode) {
      this.mode = mode;
      this.onModeChange?.(mode);
    }
  }

  pressKey(action: ActionName): void {
    this.noteInput("keyboard");
    if (this.keys.has(action)) return; // segurando: sem re-disparo de borda
    this.keys.add(action);
    if (action === "jump") this.jumpEdge = true;
    if (action === "shoot") this.shootEdge = true;
  }

  releaseKey(action: ActionName): void {
    this.keys.delete(action);
  }

  /** Toque começou numa zona (ou fora de qualquer zona: null ainda marca touch). */
  touchStart(zone: TouchZoneId | null): void {
    this.noteInput("touch");
    if (zone === null) return;
    if (this.touchZones.has(zone)) return; // dedo já ativo na zona
    this.touchZones.add(zone);
    if (zone === "jump") this.jumpEdge = true;
    if (zone === "shoot") this.shootEdge = true;
  }

  /** Toque saiu da zona (dedo levantado ou deslizado para fora). */
  touchEnd(zone: TouchZoneId | null): void {
    if (zone === null) return;
    this.touchZones.delete(zone);
  }

  /**
   * Snapshot do estado digital para o frame atual. Limpa as bordas de
   * jump/shoot — chame uma vez por frame no game loop.
   */
  poll(): InputFrame {
    const left = this.keys.has("left") || this.touchZones.has("left");
    const right = this.keys.has("right") || this.touchZones.has("right");
    const direction: -1 | 0 | 1 = left && right ? 0 : left ? -1 : right ? 1 : 0;
    const frame: InputFrame = {
      direction,
      jumpPressed: this.jumpEdge,
      shootPressed: this.shootEdge,
    };
    this.jumpEdge = false;
    this.shootEdge = false;
    return frame;
  }

  /** Zera todo o estado (útil em reset de fase). */
  reset(): void {
    this.keys.clear();
    this.touchZones.clear();
    this.jumpEdge = false;
    this.shootEdge = false;
  }
}

// ===== Fiação com o Kaplay =====

export interface CreateInputOpts {
  /** Chamado quando o modo muda após o primeiro input real. */
  onModeChange?: (mode: InputMode) => void;
  /** Layout customizado de zonas (default: computeTouchZones com tamanho do canvas). */
  zones?: () => TouchZone[];
}

/** API exposta para o main.ts consumir. */
export interface GameInput {
  getMode(): InputMode;
  isTouchMode(): boolean;
  /** Snapshot do estado do frame (limpa bordas). Chame uma vez por frame. */
  poll(): InputFrame;
  /** Zonas virtuais atuais (para desenhar botões e hit-test). */
  getZones(): TouchZone[];
  /** Hit-test circular de um ponto em uma zona. */
  isPointInZone(zone: TouchZone, p: Vec2Like): boolean;
  /** Desliga os listeners registrados no Kaplay. */
  destroy(): void;
}

/**
 * Cria a camada de input ligada ao Kaplay:
 * - k.isTouchscreen() define o modo inicial;
 * - onKeyPress/onKeyRelease (setas, A/D, Espaço, J) alimentam o estado;
 * - onTouchStart/Move/End fazem hit-test nas zonas virtuais (coordenadas de
 *   jogo, já convertidas pelo Kaplay) e alimentam o estado de toque.
 *
 * NÃO desenha nada — só estado, zonas e APIs de consulta.
 */
export function createInput(k: KAPLAYCtx, opts: CreateInputOpts = {}): GameInput {
  const controller = new InputController({
    initialMode: k.isTouchscreen() ? "touch" : "keyboard",
    onModeChange: opts.onModeChange,
  });

  const getZones: () => TouchZone[] =
    opts.zones ??
    (() => {
      // Coordenadas de JOGO (k.width()×k.height(), ex.: 960x540): o Kaplay
      // converte eventos de toque para esse espaço (letterbox + transform do
      // viewport), então as zonas precisam viver aqui. canvas.width/height
      // são o buffer em px de dispositivo (dpr) — usá-los quebraria o
      // hit-test em telas retina (zonas fora de escala e posição).
      const gameW = k.width();
      const gameH = k.height();
      const canvas = k.canvas;
      const dpr =
        typeof window !== "undefined"
          ? Math.min(window.devicePixelRatio || 1, 2)
          : 1;
      const cssW = canvas?.offsetWidth || (canvas?.width ?? gameW) / dpr;
      const cssH = canvas?.offsetHeight || (canvas?.height ?? gameH) / dpr;
      const scale = cssToGameScale(cssW, cssH, gameW, gameH);
      return computeTouchZones({
        width: gameW,
        height: gameH,
        safe: safeAreaToGame(readSafeArea(), scale, { w: cssW, h: cssH }, { w: gameW, h: gameH }),
      });
    });

  const zoneAt = (p: Vec2Like): TouchZoneId | null => {
    for (const zone of getZones()) {
      if (isPointInZone(zone, p)) return zone.id;
    }
    return null;
  };

  const evts: KEventController[] = [];

  // Teclado: onKeyPress dispara no keydown (inclusive auto-repeat do sistema);
  // o InputController ignora repeats porque a borda só dispara na transição
  // solto → pressionado.
  evts.push(
    k.onKeyPress((key) => {
      const action = KEY_ACTIONS[key];
      if (action) controller.pressKey(action);
    })
  );

  evts.push(
    k.onKeyRelease((key) => {
      const action = KEY_ACTIONS[key];
      if (action) controller.releaseKey(action);
    })
  );

  // Touch: um dedo pode se mover entre zonas; acompanhamos por touch id
  // (Touch.identifier da DOM — o kaplay repassa o Touch nativo).
  const activeTouches = new Map<number, TouchZoneId | null>();

  evts.push(
    k.onTouchStart((pos, t) => {
      const zone = zoneAt(pos);
      activeTouches.set(t.identifier, zone);
      controller.touchStart(zone);
    })
  );

  evts.push(
    k.onTouchMove((pos, t) => {
      const zone = zoneAt(pos);
      const prev = activeTouches.get(t.identifier) ?? null;
      if (zone === prev) return;
      if (prev) controller.touchEnd(prev);
      activeTouches.set(t.identifier, zone);
      if (zone) controller.touchStart(zone);
    })
  );

  evts.push(
    k.onTouchEnd((_pos, t) => {
      const prev = activeTouches.get(t.identifier) ?? null;
      activeTouches.delete(t.identifier);
      if (prev) controller.touchEnd(prev);
    })
  );

  return {
    getMode: () => controller.getMode(),
    isTouchMode: () => controller.isTouchMode(),
    poll: () => controller.poll(),
    getZones,
    isPointInZone,
    destroy: () => {
      for (const evt of evts) evt.cancel();
      evts.length = 0;
      activeTouches.clear();
    },
  };
}
