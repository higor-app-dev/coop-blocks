import type { GameObj, KAPLAYCtx } from "kaplay";
import { TILE } from "./levelgen";
import type { NetPowerUp, NetPowerUpRemoved } from "./net";

/**
 * Power-ups coletáveis do client web.
 *
 * A camada é um espelho PURO do estado autoritativo do servidor
 * (apps/api/internal/game/powerups.go — PowerUpManager): o servidor decide
 * quais power-ups existem, onde estão e que efeito cada coleta concede; o
 * client apenas renderiza o estado broadcastado (WorldMsg `powerUps` /
 * PowerUpsMsg) e reage às remoções (efeito de coleta). NÃO existe geração
 * local nem decisão de efeito no client — em singleplayer offline (sem
 * servidor) a camada permanece vazia e nenhum power-up aparece.
 *
 * Posições vêm do servidor em px (top-left da hitbox 20x20); o visual é
 * colorido por tipo (vida vermelho, tiro triplo âmbar, escudo azul) com
 * outline branco para destacar do fundo escuro, arredondado (radius 6).
 * A reconciliação segue o padrão das moedas (coins.ts): applyFull cria as
 * ausentes, reposiciona as existentes e destrói as que sumiram do estado.
 */

// ===== Constantes (espelho do servidor — apps/api/internal/game/powerups.go) =====

/** Largura da hitbox do power-up em px (PowerUpDefaultWidth). */
export const POWERUP_WIDTH = 20;
/** Altura da hitbox do power-up em px (PowerUpDefaultHeight). */
export const POWERUP_HEIGHT = 20;
/**
 * Distância do CENTRO do power-up ao topo do tile de apoio (PowerUpFloatHeight
 * = 36 > CoinFloatHeight 30 — flutua acima da moeda quando co-localizado,
 * ambos visíveis).
 */
export const POWERUP_FLOAT_HEIGHT = 36;

/**
 * Cor do bloco por tipo (PowerUpType.String do servidor): VIDA em vermelho,
 * TIRO TRIPLO em âmbar e ESCUDO em azul. Tipos desconhecidos caem no VIDA
 * (guarda defensiva).
 */
export const POWERUP_COLORS: Record<string, [number, number, number]> = {
  vida: [235, 80, 90],
  tiro_triplo: [255, 205, 70],
  escudo: [90, 165, 235],
};

/**
 * Power-up da fase para um tile (chão/plataforma), espelhando a conversão
 * tile→pixels do servidor (PowerUpManager.SpawnForLevel): centro da coluna,
 * flutuando POWERUP_FLOAT_HEIGHT px acima do topo, com o top-left da hitbox
 * 20x20 deslocado em metade do tamanho. Documenta a paridade da posição —
 * o client renderiza as posições que o servidor broadcasta.
 */
export function levelPowerUp(tx: number, ty: number, id: string, kind: string): NetPowerUp {
  return {
    id,
    kind,
    x: tx * TILE + TILE / 2 - POWERUP_WIDTH / 2,
    y: ty * TILE - POWERUP_FLOAT_HEIGHT - POWERUP_HEIGHT / 2,
    w: POWERUP_WIDTH,
    h: POWERUP_HEIGHT,
  };
}

// ===== Camada kaplay =====

/** Callbacks da camada de power-ups. */
export interface PowerUpLayerOpts {
  /**
   * Efeito de coleta (som + partículas). Disparado quando um power-up é
   * removido via broadcast `removed` do servidor — o client reage ao evento
   * mesmo sem ter coletado localmente (power-ups são autoritativos do
   * servidor). O tipo vem no evento (p/ efeitos diferenciados se desejado).
   */
  onCollect?: (r: NetPowerUpRemoved) => void;
}

/** Contrato da camada de power-ups — testável isoladamente. */
export interface PowerUpLayer {
  /**
   * Substitui o estado completo (broadcast `powerUps` / WorldMsg): cria os
   * ausentes, reposiciona os existentes e destrói os que sumiram do estado
   * (coletados cujo broadcast `removed` se perdeu — reconciliação).
   */
  applyFull(powerUps: NetPowerUp[]): void;
  /**
   * Remove imediatamente os power-ups coletados (broadcast `removed`) e
   * dispara onCollect para cada um que existia localmente (efeito de coleta).
   */
  applyRemoved(removed: NetPowerUpRemoved[]): void;
  /** Destrói todos os power-ups (reconstrução de mundo / troca de fase). */
  clear(): void;
  /** Quantidade de power-ups ativos. */
  size(): number;
  /** true quando existe power-up com o id dado. */
  has(id: string): boolean;
}

export function createPowerUpLayer(k: KAPLAYCtx, opts: PowerUpLayerOpts = {}): PowerUpLayer {
  const { add, pos, rect, color, outline, rgb, z, destroy } = k;
  const objects = new Map<string, GameObj>();

  function spawn(p: NetPowerUp): GameObj {
    const [r, g, b] = POWERUP_COLORS[p.kind] ?? POWERUP_COLORS.vida;
    const obj = add([
      "powerup",
      pos(p.x, p.y),
      rect(p.w || POWERUP_WIDTH, p.h || POWERUP_HEIGHT, { radius: 6 }),
      color(r, g, b),
      outline(2, rgb(255, 255, 255)),
      z(4),
      { powerUpId: p.id, powerUpKind: p.kind },
    ]);
    objects.set(p.id, obj);
    return obj;
  }

  function applyFull(powerUps: NetPowerUp[]): void {
    const seen = new Set<string>();
    for (const p of powerUps) {
      seen.add(p.id);
      const existing = objects.get(p.id);
      if (existing) {
        // Power-ups são estáticos; a atualização cobre apenas o caso de o
        // servidor reposicionar (robustez — sem custo perceptível).
        existing.pos.x = p.x;
        existing.pos.y = p.y;
      } else {
        spawn(p);
      }
    }
    // Reconciliar: o que sumiu do estado completo (coletado no servidor e o
    // broadcast `removed` não chegou/foi perdido) é destruído aqui também.
    for (const [id, obj] of [...objects]) {
      if (!seen.has(id)) {
        if (obj.exists()) destroy(obj);
        objects.delete(id);
      }
    }
  }

  function applyRemoved(removed: NetPowerUpRemoved[]): void {
    for (const r of removed) {
      const obj = objects.get(r.id);
      if (!obj) continue;
      if (obj.exists()) destroy(obj);
      objects.delete(r.id);
      opts.onCollect?.(r);
    }
  }

  function clear(): void {
    for (const obj of [...objects.values()]) {
      if (obj.exists()) destroy(obj);
    }
    objects.clear();
  }

  return {
    applyFull,
    applyRemoved,
    clear,
    size: () => objects.size,
    has: (id) => objects.has(id),
  };
}
