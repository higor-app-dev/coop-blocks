/**
 * Botões touch — apps/web/src/touch-buttons.ts
 *
 * Converte as zonas virtuais de toque (input.ts) em specs de desenho para o
 * main.ts: rótulo (◀ ▶ PULO TIRO), centro e tamanho do botão. O módulo NÃO
 * desenha nada — o render com elementos Kaplay (rects + texto) fica no
 * main.ts, que também faz o show/hide conforme o modo de entrada.
 *
 * Funções puras, testáveis sem DOM/Kaplay.
 */

import type { TouchZone, TouchZoneId } from "./input";

/** Rótulo exibido em cada botão touch (texto sobre o retângulo). */
export const ZONE_LABELS: Record<TouchZoneId, string> = {
  left: "◀",
  right: "▶",
  jump: "PULO",
  shoot: "TIRO",
};

/** Spec de desenho de um botão: centro (x,y), lado (size) e rótulo. */
export interface TouchButtonSpec {
  id: TouchZoneId;
  label: string;
  x: number;
  y: number;
  size: number;
}

/**
 * Deriva as specs de desenho a partir das zonas virtuais (mesma ordem).
 * O centro do botão coincide com o centro da zona — o visual casa com a área
 * de hit-test do polegar.
 */
export function computeButtonSpecs(zones: TouchZone[]): TouchButtonSpec[] {
  return zones.map((z) => ({
    id: z.id,
    label: ZONE_LABELS[z.id],
    x: z.rect.x + z.rect.w / 2,
    y: z.rect.y + z.rect.h / 2,
    size: Math.min(z.rect.w, z.rect.h),
  }));
}
