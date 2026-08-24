/**
 * Parsing/tratamento de input do teclado — módulo puro (sem kaplay).
 *
 * Mapeia nomes de tecla para ações do jogador. O bind real (onKeyDown /
 * onKeyPress) acontece no main.ts; aqui fica só a lógica de tradução,
 * testável isoladamente.
 */

export type PlayerAction =
  | { type: "move"; dir: -1 | 1 }
  | { type: "jump" }
  | { type: "shoot" };

/** Teclas reconhecidas, na ordem em que o main.ts faz o bind. */
export const ACTION_KEYS = ["left", "right", "space", "x"] as const;

const KEY_TO_ACTION: Readonly<Record<string, PlayerAction>> = {
  left: { type: "move", dir: -1 },
  right: { type: "move", dir: 1 },
  space: { type: "jump" },
  x: { type: "shoot" },
};

/**
 * Traduz o nome de uma tecla na ação correspondente.
 * Normaliza para minúsculas; teclas desconhecidas retornam null (não lança).
 */
export function keyToAction(key: string): PlayerAction | null {
  if (typeof key !== "string") return null;
  return KEY_TO_ACTION[key.toLowerCase()] ?? null;
}
