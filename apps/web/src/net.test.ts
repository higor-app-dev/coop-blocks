import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToServer, type NetOpts } from "./net";

// ===== Fakes =====

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url = "";
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(_data: string) {}
  close() {}
}

function makeK() {
  return { onUpdate: vi.fn() };
}

function makeOpts(url: string): NetOpts {
  return {
    url,
    player: { pos: { x: 10, y: 20 }, hp: 100 } as any,
    onPlayers: vi.fn(),
    onPlayerJoin: vi.fn(),
    onPlayerLeave: vi.fn(),
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "coop-blocks.vercel.app" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===== Resolução de URL =====

describe("connectToServer — resolução de URL", () => {
  it("URL relativa monta wss://location.host + path (comportamento same-origin)", () => {
    connectToServer(makeK() as any, makeOpts("/api/ws"));
    expect(FakeWebSocket.instances[0].url).toBe("wss://coop-blocks.vercel.app/api/ws");
  });

  it("URL absoluta wss:// é usada direto, sem prefixar location.host", () => {
    connectToServer(makeK() as any, makeOpts("wss://play.sandbox-oci.omniplatform.run/api/ws"));
    expect(FakeWebSocket.instances[0].url).toBe("wss://play.sandbox-oci.omniplatform.run/api/ws");
  });

  it("URL absoluta https:// é convertida para wss://", () => {
    connectToServer(makeK() as any, makeOpts("https://play.sandbox-oci.omniplatform.run/api/ws"));
    expect(FakeWebSocket.instances[0].url).toBe("wss://play.sandbox-oci.omniplatform.run/api/ws");
  });

  it("URL absoluta http:// é convertida para ws://", () => {
    connectToServer(makeK() as any, makeOpts("http://localhost:8080/api/ws"));
    expect(FakeWebSocket.instances[0].url).toBe("ws://localhost:8080/api/ws");
  });
});

// ===== Wiring =====

describe("connectToServer — conexão", () => {
  it("no onopen envia o estado inicial do jogador local", () => {
    connectToServer(makeK() as any, makeOpts("/api/ws"));
    const ws = FakeWebSocket.instances[0];
    const sent: string[] = [];
    ws.send = (d: string) => sent.push(d);
    ws.onopen?.();
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]);
    expect(msg.type).toBe("state");
    expect(msg.x).toBe(10);
    expect(msg.y).toBe(20);
    expect(msg.hp).toBe(100);
  });
});

// ===== Mensagens de power-ups (PowerUpsMsg / WorldMsg) =====

describe("connectToServer — broadcast de power-ups", () => {
  it("msg type=powerups entrega estado restante, remoções e efeitos por jogador", () => {
    const onPowerUps = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPowerUps });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "powerups",
        powerUps: [{ id: "p2", kind: "escudo", x: 300, y: 400, w: 20, h: 20 }],
        removed: [{ id: "p1", kind: "vida", x: 100, y: 200 }],
        effects: { alice: { vida: 25, tripleShot: 0, shield: 0 } },
      }),
    });
    expect(onPowerUps).toHaveBeenCalledWith({
      powerUps: [{ id: "p2", kind: "escudo", x: 300, y: 400, w: 20, h: 20 }],
      removed: [{ id: "p1", kind: "vida", x: 100, y: 200 }],
      effects: { alice: { vida: 25, tripleShot: 0, shield: 0 } },
    });
  });

  it("msg type=powerups sem campos opcionais usa defaults seguros", () => {
    const onPowerUps = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPowerUps });
    captureWs([]).onmessage?.({ data: JSON.stringify({ type: "powerups" }) });
    expect(onPowerUps).toHaveBeenCalledWith({ powerUps: [], removed: [], effects: {} });
  });

  it("WorldMsg (type=players) com powerUps+powerUpEffects entrega estado e efeitos", () => {
    const onPowerUps = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPowerUps });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [{ id: "alice", x: 10, y: 20, hp: 125 }],
        powerUps: [{ id: "p1", kind: "tiro_triplo", x: 100, y: 200, w: 20, h: 20 }],
        powerUpEffects: { alice: { vida: 25, tripleShot: 180, shield: 0 } },
      }),
    });
    // WorldMsg não carrega remoções — o estado completo cobre a reconciliação.
    expect(onPowerUps).toHaveBeenCalledWith({
      powerUps: [{ id: "p1", kind: "tiro_triplo", x: 100, y: 200, w: 20, h: 20 }],
      removed: [],
      effects: { alice: { vida: 25, tripleShot: 180, shield: 0 } },
    });
  });

  it("WorldMsg sem powerUps não dispara onPowerUps (compatibilidade com versões antigas)", () => {
    const onPowerUps = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPowerUps });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "players", players: [{ id: "alice", x: 10, y: 20, hp: 100 }] }),
    });
    expect(onPowerUps).not.toHaveBeenCalled();
  });
});

// ===== Mensagens de fase da loja =====

function captureWs(sent: string[]) {
  const ws = FakeWebSocket.instances[0];
  ws.send = (d: string) => sent.push(d);
  return ws;
}

describe("connectToServer — broadcast de fase (loja)", () => {
  it("phase=shop dispara onPhase com o estado completo da loja", () => {
    const onPhase = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPhase });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "phase",
        phase: "shop",
        number: 2,
        ready: { alice: true, bob: false },
        players: [
          { id: "alice", coins: 120, stats: { maxHp: 125, fireRate: 1.2, shield: 1 } },
          { id: "bob", coins: 20, stats: { maxHp: 100, fireRate: 1, shield: 0 } },
        ],
      }),
    });
    expect(onPhase).toHaveBeenCalledWith({
      phase: "shop",
      number: 2,
      ready: { alice: true, bob: false },
      players: [
        { id: "alice", coins: 120, stats: { maxHp: 125, fireRate: 1.2, shield: 1 } },
        { id: "bob", coins: 20, stats: { maxHp: 100, fireRate: 1, shield: 0 } },
      ],
    });
  });

  it("phase=playing (próximo mapa) dispara onPhase com phase playing", () => {
    const onPhase = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPhase });
    captureWs([]).onmessage?.({ data: JSON.stringify({ type: "phase", phase: "playing", number: 3 }) });
    expect(onPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "playing", number: 3 })
    );
  });

  it("phase sem campos opcionais é tolerado (defaults seguros)", () => {
    const onPhase = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPhase });
    captureWs([]).onmessage?.({ data: JSON.stringify({ type: "phase", phase: "shop" }) });
    expect(onPhase).toHaveBeenCalledWith({ phase: "shop", number: 1, ready: {}, players: [] });
  });
});

// ===== Mensagens de moedas (CoinsMsg / WorldMsg) =====

describe("connectToServer — lista de jogadores (welcome/players)", () => {
  it("welcome entrega os jogadores com id (filtro do próprio jogador é do main.ts)", () => {
    const onPlayers = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPlayers });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "welcome",
        id: "self",
        players: [{ id: "alice", x: 10, y: 20, hp: 100 }],
      }),
    });
    expect(onPlayers).toHaveBeenCalledWith([{ id: "alice", x: 10, y: 20, hp: 100 }]);
  });

  it("WorldMsg players entrega a lista com id (coinCounts casa por id)", () => {
    const onPlayers = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onPlayers });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [
          { id: "alice", x: 10, y: 20, hp: 90 },
          { id: "bob", x: 30, y: 40, hp: 100 },
        ],
      }),
    });
    expect(onPlayers).toHaveBeenCalledWith([
      { id: "alice", x: 10, y: 20, hp: 90 },
      { id: "bob", x: 30, y: 40, hp: 100 },
    ]);
  });
});

describe("connectToServer — broadcast de moedas", () => {
  it("msg type=coins entrega estado restante, remoções e contadores", () => {
    const onCoins = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onCoins });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "coins",
        coins: [{ id: "c2", x: 300, y: 400, w: 14, h: 14 }],
        removed: [{ id: "c1", x: 100, y: 200 }],
        counts: { alice: 1 },
      }),
    });
    expect(onCoins).toHaveBeenCalledWith({
      coins: [{ id: "c2", x: 300, y: 400, w: 14, h: 14 }],
      removed: [{ id: "c1", x: 100, y: 200 }],
      counts: { alice: 1 },
    });
  });

  it("msg type=coins sem campos opcionais usa defaults seguros", () => {
    const onCoins = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onCoins });
    captureWs([]).onmessage?.({ data: JSON.stringify({ type: "coins" }) });
    expect(onCoins).toHaveBeenCalledWith({ coins: [], removed: [], counts: {} });
  });

  it("WorldMsg (type=players) com coins+coinCounts entrega estado completo e contadores", () => {
    const onCoins = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onCoins });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [{ id: "alice", x: 10, y: 20, hp: 100 }],
        coins: [{ id: "c1", x: 100, y: 200, w: 14, h: 14 }],
        coinCounts: { alice: 3 },
      }),
    });
    expect(onCoins).toHaveBeenCalledWith({
      coins: [{ id: "c1", x: 100, y: 200, w: 14, h: 14 }],
      removed: [],
      counts: { alice: 3 },
    });
  });

  it("WorldMsg com coins mas sem coinCounts usa contadores vazios", () => {
    const onCoins = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onCoins });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "players", players: [], coins: [] }),
    });
    expect(onCoins).toHaveBeenCalledWith({ coins: [], removed: [], counts: {} });
  });

  it("broadcast players SEM campos de moeda (servidor antigo) não dispara onCoins", () => {
    const onCoins = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onCoins });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "players", players: [{ id: "alice", x: 1, y: 2, hp: 100 }] }),
    });
    expect(onCoins).not.toHaveBeenCalled();
  });
});

describe("connectToServer — resposta de compra (shop_buy_result)", () => {
  it("ok=true entrega o comprovante com stats e saldo", () => {
    const onShopBuyResult = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onShopBuyResult });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "shop_buy_result",
        ok: true,
        upgrade: "shield",
        level: 1,
        cost: 30,
        coins: 90,
        stats: { maxHp: 100, fireRate: 1, shield: 1 },
      }),
    });
    expect(onShopBuyResult).toHaveBeenCalledWith({
      upgrade: "shield",
      level: 1,
      cost: 30,
      coins: 90,
      stats: { maxHp: 100, fireRate: 1, shield: 1 },
    });
  });

  it("ok=false entrega o erro (moedas insuficientes)", () => {
    const onShopBuyResult = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onShopBuyResult });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "shop_buy_result", ok: false, error: "moedas insuficientes" }),
    });
    expect(onShopBuyResult).toHaveBeenCalledWith({ ok: false, error: "moedas insuficientes" });
  });
});

describe("connectToServer — erro de pronto (shop_ready_result)", () => {
  it("entrega o erro do servidor", () => {
    const onShopReadyError = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onShopReadyError });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "shop_ready_result", ok: false, error: "fora da loja" }),
    });
    expect(onShopReadyError).toHaveBeenCalledWith("fora da loja");
  });
});

describe("connectToServer — envio de intenções da loja", () => {
  it("sendShopBuy envia {type:shop_buy, upgrade}", () => {
    const sent: string[] = [];
    const server = connectToServer(makeK() as any, makeOpts("/api/ws"));
    const ws = captureWs(sent);
    ws.onopen?.();
    sent.length = 0; // descarta o state do onopen
    server.sendShopBuy("shield");
    expect(JSON.parse(sent[0])).toEqual({ type: "shop_buy", upgrade: "shield" });
  });

  it("sendShopReady envia {type:shop_ready} sem payload", () => {
    const sent: string[] = [];
    const server = connectToServer(makeK() as any, makeOpts("/api/ws"));
    const ws = captureWs(sent);
    ws.onopen?.();
    sent.length = 0;
    server.sendShopReady();
    expect(JSON.parse(sent[0])).toEqual({ type: "shop_ready" });
  });

  it("não envia nada com a conexão fechada", () => {
    const sent: string[] = [];
    const server = connectToServer(makeK() as any, makeOpts("/api/ws"));
    const ws = captureWs(sent);
    ws.readyState = 0; // CONNECTING — send() deve ignorar
    server.sendShopBuy("max_hp");
    server.sendShopReady();
    expect(sent).toEqual([]);
  });
});

// ===== Boss (WorldMsg) =====

describe("connectToServer — boss (WorldMsg)", () => {
  it("WorldMsg com boss entrega o estado completo (posição/HP/estado/fase)", () => {
    const onBoss = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onBoss });
    captureWs([]).onmessage?.({
      data: JSON.stringify({
        type: "players",
        players: [],
        boss: { id: "boss", x: 5472, y: 288, hp: 380, maxHp: 400, state: "investida", phase: 5 },
      }),
    });
    expect(onBoss).toHaveBeenCalledWith({
      id: "boss",
      x: 5472,
      y: 288,
      hp: 380,
      maxHp: 400,
      state: "investida",
      phase: 5,
    });
  });

  it("WorldMsg com boss null (fase fora da régua de 5) entrega null — client esconde", () => {
    const onBoss = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onBoss });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "players", players: [], boss: null }),
    });
    expect(onBoss).toHaveBeenCalledWith(null);
  });

  it("WorldMsg sem o campo boss (servidor antigo) não dispara onBoss", () => {
    const onBoss = vi.fn();
    connectToServer(makeK() as any, { ...makeOpts("/api/ws"), onBoss });
    captureWs([]).onmessage?.({
      data: JSON.stringify({ type: "players", players: [{ id: "alice", x: 1, y: 2, hp: 100 }] }),
    });
    expect(onBoss).not.toHaveBeenCalled();
  });
});

// ===== Tiro do jogador (shoot) =====

describe("connectToServer — envio de tiro (shoot)", () => {
  it("sendShoot envia {type:shoot} sem payload", () => {
    const sent: string[] = [];
    const server = connectToServer(makeK() as any, makeOpts("/api/ws"));
    captureWs(sent).onopen?.();
    sent.length = 0; // descarta o state do onopen
    server.sendShoot();
    expect(JSON.parse(sent[0])).toEqual({ type: "shoot" });
  });

  it("não envia nada com a conexão fechada", () => {
    const sent: string[] = [];
    const server = connectToServer(makeK() as any, makeOpts("/api/ws"));
    const ws = captureWs(sent);
    ws.readyState = 0; // CONNECTING — send() deve ignorar
    server.sendShoot();
    expect(sent).toEqual([]);
  });
});
