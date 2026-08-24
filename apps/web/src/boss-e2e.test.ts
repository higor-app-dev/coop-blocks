import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBossLayer } from "./boss";
import { connectToServer } from "./net";
import { createHud, type HudPlayer, type HudState } from "./hud";

/**
 * Integração cliente (kanban t_da3717c8): o caminho COMPLETO do broadcast do
 * servidor até a barra de HP no DOM, usando as peças reais:
 *
 *   WebSocket → net.ts (onBoss) → bossLayer.apply → buildHudState-like →
 *   createHud().update → [data-hud=boss] no DOM
 *
 * O main.ts monta exatamente este encadeamento (onBoss: (state) =>
 * bossLayer.apply(state); buildHudState lê hp()/maxHp()/phase()/state()).
 * Cobre o acceptance do client: a barra aparece no spawn, atualiza com o
 * dano (e a cor do estado da máquina) e some na derrota (broadcast null).
 */

// ===== Fakes (mesma estratégia de boss.test.ts / hud.test.ts / net.test.ts) ====

interface FakeBossObj {
  tags: string[];
  pos: { x: number; y: number };
  color: { r: number; g: number; b: number };
  bossId?: string;
  bossState?: string;
  bossHp?: number;
  bossMaxHp?: number;
  bossPhase?: number;
  exists(): boolean;
}

function makeFakeKaplay() {
  const created: FakeBossObj[] = [];
  const destroyed: FakeBossObj[] = [];
  const k = {
    add: vi.fn((comps: unknown[]) => {
      const obj: FakeBossObj = {
        tags: comps.filter((c): c is string => typeof c === "string"),
        pos: { x: 0, y: 0 },
        color: { r: 0, g: 0, b: 0 },
        exists: () => true,
      };
      const posComp = comps.find(
        (c): c is { x: number; y: number } =>
          typeof c === "object" && c !== null && typeof (c as { x?: unknown }).x === "number"
      );
      if (posComp) obj.pos = { x: posComp.x, y: posComp.y };
      const colorComp = comps.find(
        (c): c is { r: number; g: number; b: number } =>
          typeof c === "object" && c !== null && typeof (c as { r?: unknown }).r === "number"
      );
      if (colorComp) obj.color = { r: colorComp.r, g: colorComp.g, b: colorComp.b };
      const custom = comps.find(
        (c): c is Record<string, unknown> =>
          typeof c === "object" && c !== null && "bossId" in (c as Record<string, unknown>)
      );
      if (custom) {
        obj.bossId = custom.bossId as string;
        obj.bossState = custom.bossState as string;
        obj.bossHp = custom.bossHp as number;
        obj.bossMaxHp = custom.bossMaxHp as number;
        obj.bossPhase = custom.bossPhase as number;
      }
      created.push(obj);
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ x, y })),
    rect: vi.fn((w: number, h: number) => ({ kind: "rect", w, h })),
    color: vi.fn((r: number, g: number, b: number) => ({ r, g, b })),
    z: vi.fn((v: number) => ({ kind: "z", v })),
    destroy: vi.fn((obj: FakeBossObj) => {
      destroyed.push(obj);
    }),
    onUpdate: vi.fn(() => {}),
  };
  return { k, created, destroyed };
}

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};

  constructor(tag: string) {
    this.tagName = tag;
  }

  classList = {
    add: (cls: string) => {
      const parts = this.className.split(/\s+/).filter(Boolean);
      if (!parts.includes(cls)) parts.push(cls);
      this.className = parts.join(" ");
    },
  };

  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  appendChild(node: FakeElement) {
    this.children.push(node);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes;
  }
  remove() {}
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(_type: string, _fn: () => void) {
    // no-op no fake — o teste não exercita o mute
  }
}

function fakeDoc() {
  return {
    createElement: (tag: string) => new FakeElement(tag),
    body: new FakeElement("body"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function byAttr(root: FakeElement, name: string, value: string): FakeElement | undefined {
  if (root.attrs[name] === value) return root;
  for (const c of root.children) {
    const found = byAttr(c, name, value);
    if (found) return found;
  }
  return undefined;
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onmessage: ((ev: unknown) => void) | null = null;
  send(_data: string) {}
  close() {}
  constructor() {
    FakeWebSocket.instances.push(this);
  }
}

// Estado base do HUD (players/câmera) — o boss é injetado pelo teste.
const hudBase = (): HudState => ({
  players: [] as HudPlayer[],
  localPlayerId: "p1",
  camera: { x: 0, y: 0, width: 960, height: 540 },
});

let doc: ReturnType<typeof fakeDoc>;
let k: ReturnType<typeof makeFakeKaplay>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  doc = fakeDoc();
  (globalThis as any).document = doc;
  k = makeFakeKaplay();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "coop-blocks.vercel.app" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as any).document;
});

// ===== o teste =====

describe("integração cliente — broadcast do boss → barra de HP no HUD", () => {
  it("aparece no spawn, atualiza no dano/estado e some na derrota (null)", () => {
    const bossLayer = createBossLayer(k.k as never);
    const net = connectToServer(k.k as never, {
      url: "/api/ws",
      player: { pos: { x: 0, y: 0 }, hp: 100 } as never,
      onPlayers: () => {},
      onPlayerJoin: () => {},
      onPlayerLeave: () => {},
      onBoss: (state) => bossLayer.apply(state), // = main.ts
    });
    void net;
    const ws = FakeWebSocket.instances[0];
    const hud = createHud({ root: doc.body });

    // buildHudState-like (espelho do main.ts): boss presente → HUD recebe o estado.
    const stateComBoss = (): HudState => {
      const hp = bossLayer.hp();
      const maxHp = bossLayer.maxHp();
      return {
        ...hudBase(),
        boss:
          hp !== null && maxHp !== null
            ? { hp, maxHp, phase: bossLayer.phase() ?? undefined, state: bossLayer.state() ?? undefined }
            : undefined,
      };
    };

    // ===== 1) SPAWN: broadcast com o boss ativo (fase 5) =====
    ws.onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [],
        boss: { id: "boss", x: 2832, y: 384, hp: 400, maxHp: 400, state: "idle", phase: 5 },
      }),
    });
    hud.update(stateComBoss());

    // O bloco gigante foi renderizado pela bossLayer (espelho do servidor).
    expect(k.created).toHaveLength(1);
    expect(k.created[0].tags).toContain("boss");
    expect(k.created[0].pos).toEqual({ x: 2832, y: 384 });

    const bar = byAttr(doc.body, "data-hud", "boss");
    expect(bar).toBeDefined();
    expect(bar!.style.display).not.toBe("none"); // visível
    const label = bar!.children[0];
    const bossBar = bar!.children[1];
    const fill = bossBar!.children[0];
    const hpText = bar!.children[2];
    expect(label!.textContent).toBe("👹 BOSS — Fase 5");
    expect(fill!.style.width).toBe("100%");
    expect(hpText!.textContent).toBe("400/400");

    // ===== 2) DANO: broadcast com HP menor → barra e número atualizam =====
    ws.onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [],
        boss: { id: "boss", x: 2832, y: 384, hp: 200, maxHp: 400, state: "idle", phase: 5 },
      }),
    });
    hud.update(stateComBoss());
    expect(fill!.style.width).toBe("50%");
    expect(hpText!.textContent).toBe("200/400");
    expect(k.created).toHaveLength(1); // atualiza no lugar, sem recriar

    // ===== 3) ATAQUE: estado da máquina muda a cor da barra =====
    ws.onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [],
        boss: { id: "boss", x: 2832, y: 384, hp: 200, maxHp: 400, state: "investida", phase: 5 },
      }),
    });
    hud.update(stateComBoss());
    expect(fill!.className).toContain("is-investida");
    expect(k.created[0].bossState).toBe("investida");

    // ===== 4) DERROTA: broadcast null → a barra some =====
    ws.onmessage?.({
      data: JSON.stringify({ type: "players", players: [], boss: null }),
    });
    hud.update(stateComBoss());
    expect(bar!.style.display).toBe("none"); // oculta
    expect(k.destroyed).toHaveLength(1); // o bloco foi destruído (onClear)
  });
});
