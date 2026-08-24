import { describe, expect, it } from "vitest";
import { formatDeathMessage, formatHud } from "./hud";

describe("formatHud", () => {
  it("formata o caso normal", () => {
    expect(formatHud(100, 100, 3)).toBe(
      "🧱 coop-blocks — HP 100/100 — jogadores online: 3"
    );
  });

  it("formata HP intermediário e zero jogadores", () => {
    expect(formatHud(42, 100, 0)).toBe(
      "🧱 coop-blocks — HP 42/100 — jogadores online: 0"
    );
  });

  it("formata com maxHp arbitrário", () => {
    expect(formatHud(7, 20, 1)).toBe(
      "🧱 coop-blocks — HP 7/20 — jogadores online: 1"
    );
  });

  it("clampa HP em 0 (alinhado ao servidor, que nunca deixa HP negativo)", () => {
    expect(formatHud(0, 100, 1)).toContain("HP 0/100");
    expect(formatHud(-5, 100, 1)).toContain("HP 0/100");
    expect(formatHud(-100, 100, 1)).toContain("HP 0/100");
  });

  it("clampa HP no maxHp", () => {
    expect(formatHud(150, 100, 1)).toContain("HP 100/100");
    expect(formatHud(100, 100, 1)).toContain("HP 100/100");
  });

  it("preserva valores fracionários no meio da faixa", () => {
    expect(formatHud(42.5, 100, 1)).toContain("HP 42.5/100");
  });
});

describe("formatDeathMessage", () => {
  it("retorna a mensagem de morte", () => {
    expect(formatDeathMessage()).toBe(
      "💀 Você morreu! Recarregue a página para reiniciar."
    );
  });
});
