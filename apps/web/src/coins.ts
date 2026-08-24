import type { GameObj, KAPLAYCtx } from "kaplay";
import { TILE } from "./levelgen";
import type { NetCoin, NetCoinRemoved } from "./net";

/**
 * Moedas coletáveis do client web.
 *
 * A camada tem duas fontes, decididas pelo main.ts:
 *   - multiplayer (servidor autoritativo): o servidor broadcasta o estado
 *     completo das moedas (WorldMsg/CoinsMsg — posições top-left em px) e as
 *     remoções por coleta; a camada apenas espelha — renderiza, esconde na
 *     hora do broadcast `removed` e delega o efeito de coleta ao onCollect;
 *   - singleplayer local (offline): o main.ts gera as moedas da fase com as
 *     MESMAS regras do servidor (Level.CoinSpawns) e as alimenta via
 *     applyFull/addCoins; a coleta é local (remove + contador do time).
 *
 * A camada kaplay é um wrapper fino: cria o objeto visual (tag "coin",
 * hitbox 14x14 no top-left do servidor, amarela, z 3), guarda o id no objeto
 * (coinId) e destrói sob demanda. Toda a sincronização (adicionar/remover/
 * reconciliar) vive aqui — o main.ts não cria moedas fora da camada.
 */

// ===== Constantes (espelho do servidor — apps/api/internal/game/coins.go) =====

/** Largura da hitbox da moeda em px (CoinDefaultWidth). */
export const COIN_WIDTH = 14;
/** Altura da hitbox da moeda em px (CoinDefaultHeight). */
export const COIN_HEIGHT = 14;
/** Distância do CENTRO da moeda ao topo do tile de solo (CoinFloatHeight). */
export const COIN_FLOAT_HEIGHT = 30;

/**
 * Moeda da fase para um tile (chão/plataforma), espelhando a conversão
 * tile→pixels do servidor: centro da coluna, flutuando COIN_FLOAT_HEIGHT px
 * acima do topo, com o top-left da hitbox 14x14 deslocado em metade do
 * tamanho. Usada na geração offline (singleplayer local) para que a posição
 * renderizada seja IDÊNTICA à que o servidor broadcasta no multiplayer.
 */
export function levelCoin(tx: number, ty: number, id: string): NetCoin {
  return {
    id,
    x: tx * TILE + TILE / 2 - COIN_WIDTH / 2,
    y: ty * TILE - COIN_FLOAT_HEIGHT - COIN_HEIGHT / 2,
    w: COIN_WIDTH,
    h: COIN_HEIGHT,
  };
}

// ===== Camada kaplay =====

/** Callbacks da camada de moedas. */
export interface CoinLayerOpts {
  /**
   * Efeito de coleta (som + partículas). Disparado quando uma moeda é
   * removida via broadcast `removed` do servidor — o client reage ao evento
   * mesmo sem ter coletado localmente (moedas são autoritativas do servidor).
   */
  onCollect?: (c: NetCoinRemoved) => void;
}

/** Contrato da camada de moedas — testável isoladamente. */
export interface CoinLayer {
  /**
   * Substitui o estado completo (broadcast `coins` / WorldMsg, ou a geração
   * offline da fase): cria as ausentes, reposiciona as existentes e destrói
   * as que sumiram do estado.
   */
  applyFull(coins: NetCoin[]): void;
  /** Acrescenta moedas sem tocar nas existentes (drops locais offline). */
  addCoins(coins: NetCoin[]): void;
  /**
   * Remove imediatamente as moedas coletadas (broadcast `removed`) e dispara
   * onCollect para cada uma que existia localmente (efeito de coleta).
   */
  applyRemoved(removed: NetCoinRemoved[]): void;
  /** Remove uma moeda pelo id (coleta local no singleplayer offline). */
  remove(id: string): void;
  /** Destrói todas as moedas (reconstrução de mundo / troca de autoridade). */
  clear(): void;
  /** Quantidade de moedas ativas. */
  size(): number;
  /** true quando existe moeda com o id dado. */
  has(id: string): boolean;
}

export function createCoinLayer(k: KAPLAYCtx, opts: CoinLayerOpts = {}): CoinLayer {
  const { add, pos, rect, color, area, z, destroy } = k;
  const objects = new Map<string, GameObj>();

  function spawn(c: NetCoin): GameObj {
    const obj = add([
      "coin",
      pos(c.x, c.y),
      rect(c.w || COIN_WIDTH, c.h || COIN_HEIGHT),
      color(255, 215, 60),
      area(),
      z(3),
      { coinId: c.id },
    ]);
    objects.set(c.id, obj);
    return obj;
  }

  function applyFull(coins: NetCoin[]): void {
    const seen = new Set<string>();
    for (const c of coins) {
      seen.add(c.id);
      const existing = objects.get(c.id);
      if (existing) {
        // Moedas são estáticas; a atualização cobre apenas o caso de o
        // servidor reposicionar (robustez — sem custo perceptível).
        existing.pos.x = c.x;
        existing.pos.y = c.y;
      } else {
        spawn(c);
      }
    }
    // Reconciliar: o que sumiu do estado completo (coletada no servidor e o
    // broadcast `removed` não chegou/foi perdido) é destruído aqui também.
    for (const [id, obj] of [...objects]) {
      if (!seen.has(id)) {
        if (obj.exists()) destroy(obj);
        objects.delete(id);
      }
    }
  }

  function addCoins(coins: NetCoin[]): void {
    for (const c of coins) {
      if (!objects.has(c.id)) spawn(c);
    }
  }

  function applyRemoved(removed: NetCoinRemoved[]): void {
    for (const r of removed) {
      const obj = objects.get(r.id);
      if (!obj) continue;
      if (obj.exists()) destroy(obj);
      objects.delete(r.id);
      opts.onCollect?.(r);
    }
  }

  function remove(id: string): void {
    const obj = objects.get(id);
    if (!obj) return;
    if (obj.exists()) destroy(obj);
    objects.delete(id);
  }

  function clear(): void {
    for (const obj of [...objects.values()]) {
      if (obj.exists()) destroy(obj);
    }
    objects.clear();
  }

  return {
    applyFull,
    addCoins,
    applyRemoved,
    remove,
    clear,
    size: () => objects.size,
    has: (id) => objects.has(id),
  };
}
