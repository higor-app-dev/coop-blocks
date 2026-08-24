import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoom,
  getLobbyState,
  getPlayerId,
  joinRoom,
  leaveRoom,
  listPublicRooms,
  setReady,
  startGame,
  type LobbyState,
  type RoomSummary,
} from "./lobby";

// ===== Helpers de mock do fetch =====

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

const ROOM: RoomSummary = {
  name: "sala 1",
  playerCount: 1,
  maxPlayers: 4,
  hasPassword: false,
  phase: "waiting",
};

const STATE: LobbyState = {
  room: ROOM,
  players: [
    { id: "p1", name: "alice", ready: false, role: "owner" },
    { id: "p2", name: "bob", ready: true, role: "player" },
  ],
  me: { id: "p1", name: "alice", ready: false, role: "owner" },
  ownerId: "p1",
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===== listPublicRooms =====

describe("listPublicRooms", () => {
  it("faz GET /api/lobby/rooms e resolve com as salas parseadas", async () => {
    fetchMock.mockResolvedValue(jsonResponse([ROOM]));

    const rooms = await listPublicRooms();

    expect(rooms).toEqual([ROOM]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lobby/rooms");
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("X-Player-Id")).toBe(getPlayerId());
  });

  it("resolve com lista vazia quando não há salas", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await expect(listPublicRooms()).resolves.toEqual([]);
  });
});

// ===== createRoom =====

describe("createRoom", () => {
  it("sala pública envia password vazio", async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATE, 201));

    const state = await createRoom({ name: "sala 1", isPublic: true });

    expect(state).toEqual(STATE);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "sala 1", password: "" });
  });

  it("sala privada envia a senha", async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATE, 201));

    await createRoom({ name: "sala secreta", isPublic: false, password: "1234" });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ name: "sala secreta", password: "1234" });
  });

  it("rejeita com a mensagem do backend quando a sala já existe", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "sala já existe" }, 409));

    await expect(
      createRoom({ name: "sala 1", isPublic: true })
    ).rejects.toThrow("sala já existe");
  });
});

// ===== joinRoom =====

describe("joinRoom", () => {
  it("faz POST /join com a senha e resolve com o estado do lobby", async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATE));

    const state = await joinRoom({ roomId: "sala 1", password: "1234" });

    expect(state).toEqual(STATE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lobby/rooms/sala%201/join");
    expect(JSON.parse(String(init?.body))).toEqual({ password: "1234" });
  });

  it("lança erro claro com senha incorreta", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "senha incorreta" }, 403));

    await expect(joinRoom({ roomId: "sala 1", password: "errada" })).rejects.toThrow(
      "senha incorreta"
    );
  });

  it("lança erro claro quando a sala está cheia", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "sala cheia" }, 409));

    await expect(joinRoom({ roomId: "sala 1", password: "" })).rejects.toThrow("sala cheia");
  });

  it("usa fallback amigável quando o corpo do erro não é JSON", async () => {
    fetchMock.mockResolvedValue(new Response("sala cheia", { status: 500 }));

    await expect(joinRoom({ roomId: "x", password: "" })).rejects.toThrow(
      "Erro interno do servidor"
    );
  });
});

// ===== setReady / leaveRoom / startGame / getLobbyState =====

describe("setReady", () => {
  it("faz POST /ready com o estado e resolve com o lobby atualizado", async () => {
    const updated: LobbyState = {
      ...STATE,
      me: { ...STATE.me, ready: true },
      players: STATE.players.map((p) => (p.id === "p1" ? { ...p, ready: true } : p)),
    };
    fetchMock.mockResolvedValue(jsonResponse(updated));

    const state = await setReady({ roomId: "sala 1", ready: true });

    expect(state.me.ready).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lobby/rooms/sala%201/ready");
    expect(JSON.parse(String(init?.body))).toEqual({ ready: true });
  });
});

describe("leaveRoom", () => {
  it("faz POST /leave e resolve em 204", async () => {
    fetchMock.mockResolvedValue(noContent());

    await expect(leaveRoom("sala 1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lobby/rooms/sala%201/leave");
    expect(init?.method).toBe("POST");
  });
});

describe("startGame", () => {
  it("faz POST /start e resolve em 204", async () => {
    fetchMock.mockResolvedValue(noContent());

    await expect(startGame("sala 1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lobby/rooms/sala%201/start");
    expect(init?.method).toBe("POST");
  });

  it("rejeita se não for o dono", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "apenas o dono pode iniciar" }, 403));

    await expect(startGame("sala 1")).rejects.toThrow("apenas o dono pode iniciar");
  });
});

describe("getLobbyState", () => {
  it("faz GET da sala e resolve com o estado atual (polling)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATE));

    const state = await getLobbyState("sala 1");

    expect(state.players).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lobby/rooms/sala%201");
    expect(init?.method ?? "GET").toBe("GET");
  });
});

// ===== Transporte / erros gerais =====

describe("transporte", () => {
  it("lança erro de conexão quando o fetch falha", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(listPublicRooms()).rejects.toThrow("Não foi possível conectar ao servidor");
  });

  it("envia o header X-Player-Id em todas as chamadas", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listPublicRooms();
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("X-Player-Id")).toMatch(/^[a-f0-9-]{8,}$/i);
  });
});
