import { describe, expect, it } from "vitest";
import {
  ACTION_KEYS,
  InputController,
  computeTouchZones,
  isPointInZone,
  keyToAction,
  type TouchZone,
} from "./input";

// ===== keyToAction (mapeamento legado de teclas) =====

describe("keyToAction — teclas conhecidas", () => {
  it.each([
    ["left", { type: "move", dir: -1 }],
    ["right", { type: "move", dir: 1 }],
    ["a", { type: "move", dir: -1 }],
    ["d", { type: "move", dir: 1 }],
    ["space", { type: "jump" }],
    ["j", { type: "shoot" }],
    ["x", { type: "shoot" }], // legado
  ] as const)("mapeia %s → %j", (key, action) => {
    expect(keyToAction(key)).toEqual(action);
  });

  it("todas as ACTION_KEYS resolvem para uma ação", () => {
    for (const key of ACTION_KEYS) {
      expect(keyToAction(key)).not.toBeNull();
    }
  });
});

describe("keyToAction — case-insensitive", () => {
  it.each([["LEFT", { type: "move", dir: -1 }], ["Space", { type: "jump" }], ["J", { type: "shoot" }]])(
    "normaliza %s → %j",
    (key, action) => {
      expect(keyToAction(key)).toEqual(action);
    }
  );
});

describe("keyToAction — teclas desconhecidas e borda", () => {
  it.each(["w", "s", "up", "down", "enter", "shift", "ctrl", "arrowleft", ""])(
    "retorna null para %j",
    (key) => {
      expect(keyToAction(key)).toBeNull();
    }
  );

  it("não lança para não-string", () => {
    // @ts-expect-error — contrato é string; runtime tolera e devolve null
    expect(keyToAction(null)).toBeNull();
    // @ts-expect-error
    expect(keyToAction(undefined)).toBeNull();
    // @ts-expect-error
    expect(keyToAction(42)).toBeNull();
  });
});

// ===== computeTouchZones (geometria pura) =====

const ZONES = computeTouchZones({ width: 960, height: 540 });

describe("computeTouchZones — layout", () => {
  it("gera as 4 zonas na ordem left, right, jump, shoot", () => {
    expect(ZONES.map((z) => z.id)).toEqual(["left", "right", "jump", "shoot"]);
  });

  it("raio mínimo generoso para polegar (≥ 48px)", () => {
    for (const z of ZONES) expect(z.radius).toBeGreaterThanOrEqual(48);
  });

  it("◀ ▶ ficam no canto inferior esquerdo", () => {
    const left = ZONES[0];
    const right = ZONES[1];
    // centro no quadrante inferior esquerdo
    expect(left.center.x).toBeLessThan(960 / 2);
    expect(left.center.y).toBeGreaterThan(540 / 2);
    expect(right.center.x).toBeLessThan(960 / 2);
    expect(right.center.y).toBeGreaterThan(540 / 2);
    // esquerda antes da direita
    expect(left.center.x).toBeLessThan(right.center.x);
    // na mesma linha de base
    expect(left.center.y).toBe(right.center.y);
  });

  it("PULO e TIRO ficam no canto inferior direito", () => {
    const jump = ZONES[2];
    const shoot = ZONES[3];
    expect(jump.center.x).toBeGreaterThan(960 / 2);
    expect(shoot.center.x).toBeGreaterThan(960 / 2);
    // TIRO acima do PULO, alinhados na horizontal
    expect(shoot.center.y).toBeLessThan(jump.center.y);
    expect(shoot.center.x).toBe(jump.center.x);
  });

  it("retângulos ficam dentro do canvas e centrados no centro da zona", () => {
    for (const z of ZONES) {
      expect(z.rect.x).toBeGreaterThanOrEqual(0);
      expect(z.rect.y).toBeGreaterThanOrEqual(0);
      expect(z.rect.x + z.rect.w).toBeLessThanOrEqual(960);
      expect(z.rect.y + z.rect.h).toBeLessThanOrEqual(540);
      expect(z.rect.x + z.rect.w / 2).toBe(z.center.x);
      expect(z.rect.y + z.rect.h / 2).toBe(z.center.y);
    }
  });
});

describe("computeTouchZones — safe-area e parâmetros", () => {
  it("desloca as zonas para dentro quando há safe-area", () => {
    const safe = computeTouchZones({
      width: 960,
      height: 540,
      safe: { top: 0, bottom: 40, left: 20, right: 30 },
    });
    const left = safe[0];
    const jump = safe[2];
    // base do botão esquerdo sobe 40px (safe inferior) e anda 20px (safe esquerdo)
    expect(left.rect.y).toBeLessThan(ZONES[0].rect.y);
    expect(left.rect.x).toBeGreaterThan(ZONES[0].rect.x);
    // PULO anda 30px para dentro da direita
    expect(jump.rect.x + jump.rect.w).toBeLessThan(ZONES[2].rect.x + ZONES[2].rect.w);
  });

  it("nunca reduz o raio abaixo de 48px", () => {
    const small = computeTouchZones({ width: 960, height: 540, radius: 10 });
    for (const z of small) expect(z.radius).toBe(48);
  });
});

// ===== isPointInZone (hit-test) =====

describe("isPointInZone", () => {
  it("centro da zona → true", () => {
    for (const z of ZONES) expect(isPointInZone(z, z.center)).toBe(true);
  });

  it("ponto bem distante → false", () => {
    for (const z of ZONES) {
      expect(isPointInZone(z, { x: 0, y: 0 })).toBe(false);
    }
  });

  it("borda do círculo (raio exato) → true", () => {
    const z = ZONES[0];
    expect(isPointInZone(z, { x: z.center.x + z.radius, y: z.center.y })).toBe(true);
  });

  it("um ponto dentro de uma zona não cai nas outras", () => {
    const left = ZONES[0];
    const right = ZONES[1];
    const p = { x: left.center.x, y: left.center.y };
    expect(isPointInZone(left, p)).toBe(true);
    expect(isPointInZone(right, p)).toBe(false);
  });
});

// ===== InputController (máquina de estado) =====

describe("InputController — teclado", () => {
  it("modo inicial é keyboard por default", () => {
    const c = new InputController();
    expect(c.getMode()).toBe("keyboard");
    expect(c.isTouchMode()).toBe(false);
  });

  it("direção: esquerda → -1, direita → 1, solto → 0", () => {
    const c = new InputController();
    c.pressKey("left");
    expect(c.poll().direction).toBe(-1);
    c.pressKey("right");
    expect(c.poll().direction).toBe(0); // ambos → neutro
    c.releaseKey("left");
    expect(c.poll().direction).toBe(1);
    c.releaseKey("right");
    expect(c.poll().direction).toBe(0);
  });

  it("jump/shoot: borda dispara 1x e não repete enquanto segurado", () => {
    const c = new InputController();
    c.pressKey("jump");
    let f = c.poll();
    expect(f.jumpPressed).toBe(true);
    // segurando: próximos polls não re-disparam
    expect(c.poll().jumpPressed).toBe(false);
    expect(c.poll().jumpPressed).toBe(false);
    c.pressKey("jump"); // auto-repeat do teclado → ignorado
    expect(c.poll().jumpPressed).toBe(false);
    // soltar e pressionar de novo → nova borda
    c.releaseKey("jump");
    c.pressKey("jump");
    expect(c.poll().jumpPressed).toBe(true);

    c.pressKey("shoot");
    expect(c.poll().shootPressed).toBe(true);
    expect(c.poll().shootPressed).toBe(false);
  });

  it("pressKey com ação não mapeada não afeta o estado", () => {
    const c = new InputController();
    // @ts-expect-error — ação inválida em runtime é ignorada
    c.pressKey("nonexistent");
    expect(c.poll()).toEqual({ direction: 0, jumpPressed: false, shootPressed: false });
  });

  it("reset zera tudo", () => {
    const c = new InputController();
    c.pressKey("left");
    c.pressKey("jump");
    c.reset();
    expect(c.poll()).toEqual({ direction: 0, jumpPressed: false, shootPressed: false });
  });
});

describe("InputController — touch", () => {
  it("toque nas zonas preenche direção e bordas", () => {
    const c = new InputController();
    c.touchStart("left");
    expect(c.poll().direction).toBe(-1);
    c.touchStart("right");
    expect(c.poll().direction).toBe(0);
    c.touchEnd("left");
    expect(c.poll().direction).toBe(1);
    c.touchEnd("right");
    expect(c.poll().direction).toBe(0);

    c.touchStart("jump");
    expect(c.poll().jumpPressed).toBe(true);
    expect(c.poll().jumpPressed).toBe(false); // dedo continua na zona, sem repetir
    c.touchEnd("jump");
    c.touchStart("jump"); // novo toque → nova borda
    expect(c.poll().jumpPressed).toBe(true);

    c.touchStart("shoot");
    expect(c.poll().shootPressed).toBe(true);
    c.touchEnd("shoot");
  });

  it("toque fora de qualquer zona marca o modo touch mas não mexe no estado", () => {
    const c = new InputController();
    c.touchStart(null);
    expect(c.isTouchMode()).toBe(true);
    expect(c.poll()).toEqual({ direction: 0, jumpPressed: false, shootPressed: false });
  });

  it("touchEnd sem zona ativa é inócuo", () => {
    const c = new InputController();
    c.touchEnd("jump");
    c.touchEnd(null);
    expect(c.poll()).toEqual({ direction: 0, jumpPressed: false, shootPressed: false });
  });
});

describe("InputController — detecção de modo", () => {
  it("tocar antes de keydown marca touch (e trava o modo)", () => {
    const c = new InputController({ initialMode: "keyboard" });
    c.touchStart("jump");
    expect(c.isTouchMode()).toBe(true);
    // keydown posterior não muda o modo travado
    c.pressKey("right");
    expect(c.isTouchMode()).toBe(true);
    expect(c.poll().direction).toBe(1); // estado continua funcional
  });

  it("keydown antes de tocar marca keyboard", () => {
    const c = new InputController({ initialMode: "touch" });
    c.pressKey("left");
    expect(c.getMode()).toBe("keyboard");
    c.touchStart("shoot");
    expect(c.getMode()).toBe("keyboard");
  });

  it("initialMode touch é respeitado até o primeiro input", () => {
    const c = new InputController({ initialMode: "touch" });
    expect(c.isTouchMode()).toBe(true);
  });

  it("onModeChange dispara uma única vez na virada de modo", () => {
    const changes: string[] = [];
    const c = new InputController({ initialMode: "keyboard", onModeChange: (m) => changes.push(m) });
    c.touchStart("jump");
    c.pressKey("left"); // travado — não deve disparar de novo
    c.touchStart("shoot");
    expect(changes).toEqual(["touch"]);
  });
});

// ===== Integração de referência: zonas reais usadas pelo hit-test =====

describe("zonas × estado (cenário mobile)", () => {
  it("tocar no centro da zona left preenche direção -1", () => {
    const c = new InputController({ initialMode: "touch" });
    const left: TouchZone | undefined = ZONES.find((z) => z.id === "left");
    expect(left).toBeDefined();
    if (!left) return;
    c.touchStart(left.id);
    expect(c.poll().direction).toBe(-1);
  });

  it("tocar no centro da zona shoot preenche shootPressed", () => {
    const c = new InputController({ initialMode: "touch" });
    const shoot: TouchZone | undefined = ZONES.find((z) => z.id === "shoot");
    expect(shoot).toBeDefined();
    if (!shoot) return;
    c.touchStart(shoot.id);
    expect(c.poll().shootPressed).toBe(true);
    expect(c.poll().shootPressed).toBe(false);
  });
});
