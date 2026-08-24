/**
 * Helpers de HUD — módulo puro (sem DOM, sem kaplay).
 *
 * Formatação das mensagens exibidas no elemento #hud. O acesso ao DOM fica
 * no main.ts; aqui só a composição de texto, testável isoladamente.
 */

/**
 * Formata a linha do HUD: HP (com clamp em [0, maxHp], alinhado ao servidor
 * que nunca deixa HP negativo) e contagem de jogadores online.
 */
export function formatHud(hp: number, maxHp: number, netCount: number): string {
  const shown = Math.max(0, Math.min(hp, maxHp));
  return `🧱 coop-blocks — HP ${shown}/${maxHp} — jogadores online: ${netCount}`;
}

/** Mensagem exibida quando o jogador local morre. */
export function formatDeathMessage(): string {
  return "💀 Você morreu! Recarregue a página para reiniciar.";
}
