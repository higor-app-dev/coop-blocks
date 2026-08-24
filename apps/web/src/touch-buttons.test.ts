import { describe, expect, it } from "vitest";
import { computeTouchZones } from "./input";
import { ZONE_LABELS, computeButtonSpecs } from "./touch-buttons";

// ===== ZONE_LABELS (rótulos dos botões touch) =====

describe("ZONE_LABELS", () => {
  it("mapeia cada zona ao rótulo esperado (◀ ▶, PULO, TIRO)", () => {
    expect(ZONE_LABELS).toEqual({
      left: "◀",
      right: "▶",
      jump: "PULO",
      shoot: "TIRO",
    });
  });
});

// ===== computeButtonSpecs (zonas → specs de desenho) =====

describe("computeButtonSpecs", () => {
  const zones = computeTouchZones({ width: 960, height: 540 });
  const specs = computeButtonSpecs(zones);

  it("gera uma spec por zona, na mesma ordem", () => {
    expect(specs.map((s) => s.id)).toEqual(["left", "right", "jump", "shoot"]);
  });

  it("centro do botão = centro do retângulo da zona", () => {
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const s = specs[i];
      expect(s.x).toBe(z.rect.x + z.rect.w / 2);
      expect(s.y).toBe(z.rect.y + z.rect.h / 2);
      expect(s.x).toBe(z.center.x);
      expect(s.y).toBe(z.center.y);
    }
  });

  it("tamanho do botão = lado do retângulo da zona", () => {
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const s = specs[i];
      expect(s.size).toBe(Math.min(z.rect.w, z.rect.h));
    }
  });

  it("rótulo do botão segue o mapa de zonas", () => {
    for (const s of specs) {
      expect(s.label).toBe(ZONE_LABELS[s.id]);
    }
  });

  it("zona desconhecida não quebra o mapa (contrato fechado)", () => {
    // O Record<TouchZoneId, string> cobre exatamente as 4 zonas; um acesso
    // fora do contrato é undefined em runtime — nunca um crash de render.
    const ids = Object.keys(ZONE_LABELS).sort();
    expect(ids).toEqual(["jump", "left", "right", "shoot"]);
  });
});
