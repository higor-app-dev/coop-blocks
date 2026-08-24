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
