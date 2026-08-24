import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToServer, createRemoteInterpolator, type NetOpts } from "./net";

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
  vi.useRealTimers();
});

// ===== Status da conexão =====

describe("connectToServer — status da conexão", () => {
  it("emite connecting no início e open quando o socket abre", () => {
    const statuses: string[] = [];
    connectToServer(makeK() as any, {
      ...makeOpts("/api/ws"),
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses).toEqual(["connecting"]);
    FakeWebSocket.instances[0].onopen?.();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("emite reconnecting quando a conexão cai após já ter aberto", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    connectToServer(makeK() as any, {
      ...makeOpts("/api/ws"),
      onStatus: (s) => statuses.push(s),
    });
    const ws0 = FakeWebSocket.instances[0];
    ws0.onopen?.();
    ws0.onclose?.();
    expect(statuses).toEqual(["connecting", "open", "reconnecting"]);
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBe(2); // reconectou
  });

  it("disconnect emite closed e interrompe o loop de reconexão", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const net = connectToServer(makeK() as any, {
      ...makeOpts("/api/ws"),
      onStatus: (s) => statuses.push(s),
    });
    FakeWebSocket.instances[0].onopen?.();
    net.disconnect();
    expect(statuses).toEqual(["connecting", "open", "closed"]);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances.length).toBe(1); // não reconectou
  });
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

// ===== Interpolação de posições remotas (createRemoteInterpolator) =====

function makeRemoteObj(x: number, y: number, alive = true) {
  return { pos: { x, y }, exists: () => alive };
}

interface InterpOpts {
  bufferMs?: number;
  snapThreshold?: number;
  now?: () => number;
}

/** Cria o interpolador + captura o handler do update loop do kaplay. */
function makeInterpolator(opts: InterpOpts = {}) {
  const k = makeK();
  const clock = { t: 0 };
  const interp = createRemoteInterpolator(k as any, { now: () => clock.t, ...opts });
  const step = (k.onUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => void;
  return { k, clock, interp, step };
}

describe("createRemoteInterpolator — interpolação de posições remotas", () => {
  it("registra exatamente um handler no update loop do kaplay", () => {
    const k = makeK();
    createRemoteInterpolator(k as any);
    expect(k.onUpdate).toHaveBeenCalledTimes(1);
  });

  it("primeiro alvo após register faz snap (nunca interpola de posição arbitrária)", () => {
    const { clock, interp, step } = makeInterpolator();
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    clock.t = 100;
    interp.apply([{ id: "alice", x: 10, y: 5, hp: 100 }]); // delta pequeno — ainda assim snap
    expect(obj.pos).toEqual({ x: 10, y: 5 });
    clock.t = 130; // dentro da janela
    step();
    expect(obj.pos).toEqual({ x: 10, y: 5 });
  });

  it("interpola dentro da janela e trava no alvo depois dela", () => {
    const { clock, interp, step } = makeInterpolator({ bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]); // snap inicial
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 100, y: 0, hp: 100 }]); // alvo (100,0), janela 1000..1100
    clock.t = 1050; // t = 0.5
    step();
    expect(obj.pos.x).toBeCloseTo(50, 5); // smoothstep(0.5) = 0.5 → meio do caminho
    clock.t = 1090; // t = 0.9
    step();
    expect(obj.pos.x).toBeGreaterThan(50);
    expect(obj.pos.x).toBeLessThan(100);
    clock.t = 1200; // depois da janela
    step();
    expect(obj.pos).toEqual({ x: 100, y: 0 });
  });

  it("smoothstep suaviza as bordas: menos de 10% do caminho no primeiro 10% do tempo", () => {
    const { clock, interp, step } = makeInterpolator({ bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 100, y: 0, hp: 100 }]); // dentro do threshold → interpola
    clock.t = 1010; // t = 0.1 → smoothstep(0.1) = 0.028 → 2.8px de 100
    step();
    expect(obj.pos.x).toBeCloseTo(2.8, 5);
  });

  it("salto maior que o threshold faz snap imediato (anti rubber-banding)", () => {
    const { clock, interp, step } = makeInterpolator({ snapThreshold: 200 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]); // snap inicial
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 0, y: 300, hp: 100 }]); // 300 > 200 → snap
    expect(obj.pos).toEqual({ x: 0, y: 300 });
    clock.t = 1010;
    step();
    expect(obj.pos).toEqual({ x: 0, y: 300 }); // permanece no alvo, sem animação
  });

  it("deslocamento dentro do threshold interpola (não faz snap)", () => {
    const { clock, interp, step } = makeInterpolator({ snapThreshold: 200, bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 100, y: 0, hp: 100 }]); // 100 <= 200 → interpola
    clock.t = 1050;
    step();
    expect(obj.pos.x).toBeCloseTo(50, 5);
  });

  it("entidade não registrada guarda o último estado e dá snap no register", () => {
    const { clock, interp, step } = makeInterpolator();
    clock.t = 100;
    interp.apply([{ id: "bob", x: 777, y: 42, hp: 90 }]); // obj ainda não existe
    const obj = makeRemoteObj(0, 0);
    interp.register("bob", obj as any);
    expect(obj.pos).toEqual({ x: 777, y: 42 }); // snap direto para o estado pendente
    clock.t = 130;
    step();
    expect(obj.pos).toEqual({ x: 777, y: 42 });
  });

  it("unregister remove o tracking (objeto congela onde estava)", () => {
    const { clock, interp, step } = makeInterpolator({ bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 100, y: 0, hp: 100 }]);
    interp.unregister("alice");
    clock.t = 1050;
    step();
    expect(obj.pos).toEqual({ x: 0, y: 0 });
  });

  it("retarget contínuo: novo apply no meio da janela parte da posição interpolada atual", () => {
    const { clock, interp, step } = makeInterpolator({ bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 100, y: 0, hp: 100 }]);
    clock.t = 1050;
    step();
    expect(obj.pos.x).toBeCloseTo(50, 5);
    // novo alvo chega: prev = posição interpolada atual (50), target = 200
    interp.apply([{ id: "alice", x: 200, y: 0, hp: 100 }]);
    clock.t = 1100; // t = 0.5 da nova janela (50 → 200)
    step();
    expect(obj.pos.x).toBeCloseTo(125, 5);
  });

  it("snap(id) salta imediatamente para o alvo mesmo com delta pequeno", () => {
    const { clock, interp, step } = makeInterpolator({ bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 80, y: 0, hp: 100 }]); // < threshold → interpola
    clock.t = 1010;
    step();
    expect(obj.pos.x).toBeGreaterThan(0);
    interp.snap("alice");
    expect(obj.pos.x).toBe(80);
    clock.t = 1030;
    step();
    expect(obj.pos.x).toBe(80); // permanece no alvo
  });

  it("objeto destruído é removido do tracking sem quebrar o loop", () => {
    const { clock, interp, step } = makeInterpolator();
    const obj = makeRemoteObj(0, 0, false); // exists() = false (destruído)
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 100, y: 0, hp: 100 }]);
    clock.t = 50;
    step();
    expect(interp.get("alice")).toBeUndefined();
  });

  it("applyPlayer aplica um único jogador (player_join)", () => {
    const { clock, interp } = makeInterpolator();
    const obj = makeRemoteObj(0, 0);
    interp.register("carol", obj as any);
    clock.t = 10;
    interp.applyPlayer({ id: "carol", x: 33, y: 44, hp: 100 });
    expect(obj.pos).toEqual({ x: 33, y: 44 });
  });

  it("posições não-finitas (NaN) são ignoradas sem quebrar o tracking", () => {
    const { clock, interp, step } = makeInterpolator({ bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: Number.NaN, y: 0, hp: 100 }]);
    clock.t = 1050;
    step();
    expect(obj.pos).toEqual({ x: 0, y: 0 });
  });

  it("get devolve o GameObj registrado e undefined para id desconhecido", () => {
    const { interp } = makeInterpolator();
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    expect(interp.get("alice")).toBe(obj);
    expect(interp.get("nope")).toBeUndefined();
  });

  it("distância exatamente no threshold interpola (snap só acima dele)", () => {
    const { clock, interp, step } = makeInterpolator({ snapThreshold: 200, bufferMs: 100 });
    const obj = makeRemoteObj(0, 0);
    interp.register("alice", obj as any);
    interp.apply([{ id: "alice", x: 0, y: 0, hp: 100 }]);
    clock.t = 1000;
    interp.apply([{ id: "alice", x: 200, y: 0, hp: 100 }]); // dist == 200 → interpola
    clock.t = 1050;
    step();
    expect(obj.pos.x).toBeCloseTo(100, 5); // meio do caminho, não snapou
  });

  it("unregister limpa o estado pendente (re-register não consome snap velho)", () => {
    const { clock, interp } = makeInterpolator();
    clock.t = 100;
    interp.apply([{ id: "bob", x: 777, y: 42, hp: 90 }]); // pendente
    interp.unregister("bob"); // jogador saiu antes de spawnar
    const obj = makeRemoteObj(0, 0);
    interp.register("bob", obj as any);
    expect(obj.pos).toEqual({ x: 0, y: 0 }); // pendente descartado — sem snap velho
  });

  it("pendentes órfãos (sem register nem unregister) são podados após o TTL", () => {
    const { clock, interp, step } = makeInterpolator();
    clock.t = 1000;
    interp.apply([{ id: "ghost", x: 50, y: 60, hp: 100 }]); // nunca registrado
    const obj = makeRemoteObj(0, 0);
    clock.t = 1000 + 10_000 + 1; // passou do TTL (10s)
    step();
    interp.register("ghost", obj as any);
    expect(obj.pos).toEqual({ x: 0, y: 0 }); // pendente podado — sem snap
  });

  it("posição do objeto corrompida (NaN) recupera com snap no próximo alvo", () => {
    const { clock, interp } = makeInterpolator();
    const obj = makeRemoteObj(Number.NaN, Number.NaN);
    interp.register("alice", obj as any);
    clock.t = 100;
    interp.apply([{ id: "alice", x: 33, y: 44, hp: 100 }]);
    expect(obj.pos).toEqual({ x: 33, y: 44 }); // snap, sem propagar NaN
  });
});
