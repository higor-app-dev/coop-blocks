import type { GameObj, KAPLAYCtx } from "kaplay";
import type { NetBoss } from "./net";

/**
 * Boss do client web — espelho do BossSystem do servidor
 * (apps/api/internal/game/boss.go).
 *
 * O boss é 100% autoritativo do servidor: não há simulação local nem IA — a
 * camada apenas renderiza o bloco gigante (96×96) na posição broadcastada
 * (WorldMsg `boss`) e expõe HP/estado/fase para o HUD (a barra de HP do boss
 * no topo é o card filho t_b08df194; a camada entrega hp()/maxHp()/state()
 * para ele). O main.ts aplica os estados via onBoss e limpa na reconstrução
 * de mundo (bossLayer.clear()).
 *
 * Colisão PERMISSIVA: o bloco é apenas visual (sem solid/body/area) — os
 * players passam por cima (salto) e por baixo (durante o salto do boss); o
 * risco de dano vem dos ataques simulados no servidor (investida por contato
 * e salto com dano em área), nunca de colisão de terreno. A derrota não
 * bloqueia o avanço: o servidor remove o boss e o próximo broadcast manda
 * null (a camada esconde).
 */

// ===== Constantes (espelho do servidor — boss.go) =====

/** Largura da hitbox do boss em px (BossWidth). */
export const BOSS_WIDTH = 96;
/** Altura da hitbox do boss em px (BossHeight). */
export const BOSS_HEIGHT = 96;

/**
 * Cor do bloco por estado da máquina (BossStateType.String): idle parado,
 * investida em vermelho vivo (perigo por contato) e salto em laranja (dano em
 * área ao aterrissar). Estados desconhecidos caem no idle (guarda defensiva).
 */
export const BOSS_COLORS: Record<string, [number, number, number]> = {
  idle: [176, 52, 52],
  investida: [238, 70, 70],
  salto: [210, 130, 48],
};

// ===== Camada kaplay =====

/** Callbacks da camada do boss. */
export interface BossLayerOpts {
  /**
   * Boss sumiu via broadcast (apply(null) — derrota ou fim de fase). Usado
   * para efeitos (som/partículas) — o clear() de reconstrução de mundo NÃO
   * dispara (a ausência anunciada pelo servidor é o evento semântico).
   */
  onClear?: () => void;
}

/** Contrato da camada do boss — testável isoladamente. */
export interface BossLayer {
  /**
   * Aplica o estado broadcastado pelo servidor: cria o bloco quando o boss
   * aparece, atualiza posição/HP/estado no lugar quando muda e destrói quando
   * null (fase sem boss). No máximo UM boss existe por vez (id fixo "boss").
   */
  apply(state: NetBoss | null): void;
  /** Destrói o bloco e zera o estado (reconstrução de mundo / troca de fase). */
  clear(): void;
  /** true quando há boss vivo renderizado. */
  active(): boolean;
  /** HP atual do boss (null sem boss) — alimenta a barra do HUD. */
  hp(): number | null;
  /** HP máximo do boss (null sem boss). */
  maxHp(): number | null;
  /** Estado atual ("idle" | "investida" | "salto") ou null sem boss. */
  state(): string | null;
  /** Fase em que o boss foi spawnado (null sem boss). */
  phase(): number | null;
}

/** Campos custom carregados no objeto kaplay do boss (colisão/efeitos/HUD). */
export interface BossObject extends GameObj {
  bossId: string;
  bossState: string;
  bossHp: number;
  bossMaxHp: number;
  bossPhase: number;
}

export function createBossLayer(k: KAPLAYCtx, opts: BossLayerOpts = {}): BossLayer {
  const { add, pos, rect, color, z, destroy } = k;

  let obj: BossObject | null = null;
  let current: NetBoss | null = null;

  function spawn(b: NetBoss): void {
    const [r, g, bl] = BOSS_COLORS[b.state] ?? BOSS_COLORS.idle;
    const o = add([
      "boss",
      pos(b.x, b.y),
      rect(BOSS_WIDTH, BOSS_HEIGHT, { radius: 8 }),
      color(r, g, bl),
      z(4),
      {
        bossId: b.id,
        bossState: b.state,
        bossHp: b.hp,
        bossMaxHp: b.maxHp,
        bossPhase: b.phase,
      },
    ]) as unknown as BossObject;
    obj = o;
    current = b;
  }

  function apply(state: NetBoss | null): void {
    if (!state) {
      if (obj) {
        if (obj.exists()) destroy(obj);
        obj = null;
        current = null;
        opts.onClear?.();
      }
      return;
    }
    if (!obj) {
      spawn(state);
      return;
    }
    // Atualiza no lugar (posição/HP/estado da máquina) — sem recriar o objeto.
    obj.pos.x = state.x;
    obj.pos.y = state.y;
    const [r, g, bl] = BOSS_COLORS[state.state] ?? BOSS_COLORS.idle;
    obj.color.r = r;
    obj.color.g = g;
    obj.color.b = bl;
    obj.bossState = state.state;
    obj.bossHp = state.hp;
    obj.bossMaxHp = state.maxHp;
    obj.bossPhase = state.phase;
    current = state;
  }

  function clear(): void {
    if (obj) {
      if (obj.exists()) destroy(obj);
      obj = null;
      current = null;
    }
  }

  return {
    apply,
    clear,
    active: () => obj !== null,
    hp: () => current?.hp ?? null,
    maxHp: () => current?.maxHp ?? null,
    state: () => current?.state ?? null,
    phase: () => current?.phase ?? null,
  };
}
