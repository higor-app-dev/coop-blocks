import { describe, expect, it } from "vitest";
import { ACTION_KEYS, keyToAction } from "./input";

describe("keyToAction — teclas conhecidas", () => {
  it.each([
    ["left", { type: "move", dir: -1 }],
    ["right", { type: "move", dir: 1 }],
    ["space", { type: "jump" }],
    ["x", { type: "shoot" }],
  ] as const)("mapeia %s → %j", (key, action) => {
    expect(keyToAction(key)).toEqual(action);
  });

  it("todas as ACTION_KEYS resolvem para uma ação", () => {
    expect(ACTION_KEYS).toHaveLength(4);
    for (const key of ACTION_KEYS) {
      expect(keyToAction(key)).not.toBeNull();
    }
  });
});

describe("keyToAction — case-insensitive", () => {
  it.each([
    ["LEFT", { type: "move", dir: -1 }],
    ["Right", { type: "move", dir: 1 }],
    ["SPACE", { type: "jump" }],
    ["X", { type: "shoot" }],
  ] as const)("normaliza %s → %j", (key, action) => {
    expect(keyToAction(key)).toEqual(action);
  });
});

describe("keyToAction — teclas desconhecidas e borda", () => {
  it.each(["a", "w", "up", "down", "enter", "shift", "ctrl", "arrowleft", ""])(
    "retorna null para %j",
    (key) => {
      expect(keyToAction(key)).toBeNull();
    }
  );

  it("não faz trim (contrato de match exato)", () => {
    expect(keyToAction(" left")).toBeNull();
    expect(keyToAction("left ")).toBeNull();
    expect(keyToAction(" ")).toBeNull();
  });

  it("não lança para não-string", () => {
    // @ts-expect-error — contrato é string; runtime tolera e devolve null
    expect(keyToAction(null)).toBeNull();
    // @ts-expect-error
    expect(keyToAction(undefined)).toBeNull();
    // @ts-expect-error
    expect(keyToAction(42)).toBeNull();
  });
});
