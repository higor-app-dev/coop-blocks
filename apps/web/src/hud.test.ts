import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MUTE_STORAGE_KEY,
  clampHp,
  formatDeathMessage,
  formatHud,
  loadMutedSession,
  saveMutedSession,
} from "./hud";

describe("clampHp", () => {
  it("mantém valores dentro da faixa", () => {
    expect(clampHp(100, 100)).toBe(100);
    expect(clampHp(42, 100)).toBe(42);
    expect(clampHp(0, 100)).toBe(0);
  });

  it("clampa abaixo de 0", () => {
    expect(clampHp(-5, 100)).toBe(0);
    expect(clampHp(-100, 100)).toBe(0);
  });

  it("clampa acima do maxHp", () => {
    expect(clampHp(150, 100)).toBe(100);
    expect(clampHp(101, 100)).toBe(100);
  });
});

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
      "💀 Você morreu! Voltando em instantes..."
    );
  });
});

describe("persistência do mute (sessão)", () => {
  // Stub de sessionStorage em memória (node não tem sessionStorage).
  const storage = new Map<string, string>();
  const original = globalThis.sessionStorage;

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: original,
    });
  });

  it("usa a chave documentada", () => {
    expect(MUTE_STORAGE_KEY).toBe("coop-blocks:muted");
  });

  it("retorna fallback quando nada foi persistido", () => {
    expect(loadMutedSession()).toBe(false);
    expect(loadMutedSession(true)).toBe(true);
  });

  it("persiste e lê de volta o estado de mute", () => {
    saveMutedSession(true);
    expect(loadMutedSession()).toBe(true);
    saveMutedSession(false);
    expect(loadMutedSession()).toBe(false);
  });

  it("lê valores crus persistidos manualmente", () => {
    storage.set(MUTE_STORAGE_KEY, "1");
    expect(loadMutedSession()).toBe(true);
    storage.set(MUTE_STORAGE_KEY, "0");
    expect(loadMutedSession()).toBe(false);
  });
});
