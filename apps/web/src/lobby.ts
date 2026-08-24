/**
 * Cliente HTTP tipado da API de lobby (P0).
 *
 * Contrato REST (implementado pelo backend Go em /api):
 *
 *   GET  /api/lobby/rooms                    → RoomSummary[]            (salas públicas)
 *   POST /api/lobby/rooms                    → LobbyState               criar sala
 *   GET  /api/lobby/rooms/{room}             → LobbyState               estado da sala
 *   POST /api/lobby/rooms/{room}/join        → LobbyState               entrar (com senha)
 *   POST /api/lobby/rooms/{room}/leave       → 204                      sair da sala
 *   POST /api/lobby/rooms/{room}/ready       → LobbyState               marcar pronto
 *   POST /api/lobby/rooms/{room}/start       → 204                      iniciar partida (dono)
 *
 * Regras do contrato:
 * - `{room}` é o nome da sala (chave única no backend), sempre URL-encoded.
 * - `playerId` é enviado no header `X-Player-Id` em toda requisição; o servidor
 *   usa esse id para atribuir dono (primeiro jogador) e os estados ready.
 * - Erros: respostas não-2xx retornam JSON `{"error": "<mensagem>"}` com a
 *   mensagem em PT-BR ("senha incorreta", "sala cheia", "sala não encontrada",
 *   "sala já existe"). Este cliente lança `Error` com essa mensagem.
 * - Sala pública = sem senha (`password` vazio).
 */
// ===== Tipos compartilhados =====

/** Papel de um jogador dentro da sala: dono (criou a sala) ou comum. */
export type PlayerRole = "owner" | "player";

/** Fase atual da partida exibida na lista de salas. */
export type GamePhase = "waiting" | "playing" | "finished";

/** Resumo de uma sala pública, como listado no lobby. */
export interface RoomSummary {
  /** Nome da sala — chave única usada como roomId nas demais chamadas. */
  name: string;
  playerCount: number;
  maxPlayers: number;
  hasPassword: boolean;
  phase: GamePhase;
}

/** Um jogador conectado à sala, no estado do lobby. */
export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  role: PlayerRole;
}

/** Estado completo de uma sala (tela de espera do lobby). */
export interface LobbyState {
  room: RoomSummary;
  players: LobbyPlayer[];
  /** Jogador da sessão atual (atalho para o elemento de `players` com o meu id). */
  me: Pick<LobbyPlayer, "id" | "name" | "ready" | "role">;
  ownerId: string;
}

/** Parâmetros de criação de sala. */
export interface CreateRoomParams {
  name: string;
  isPublic: boolean;
  password?: string;
}

/** Parâmetros para entrar em uma sala (senha opcional). */
export interface JoinRoomParams {
  roomId: string;
  password?: string;
}

/** Parâmetros para alternar o estado "pronto". */
export interface SetReadyParams {
  roomId: string;
  ready: boolean;
}

// ===== Identidade da sessão =====

let cachedPlayerId: string | null = null;

/**
 * Id estável do jogador nesta sessão/navegador. Persistido em localStorage
 * (best-effort; em ambientes sem localStorage gera um novo por sessão).
 */
export function getPlayerId(): string {
  if (cachedPlayerId) return cachedPlayerId;
  try {
    const stored = window.localStorage.getItem("coop-blocks.playerId");
    if (stored) {
      cachedPlayerId = stored;
      return stored;
    }
  } catch {
    /* sem localStorage (node/privado) — segue com id em memória */
  }
  const fresh =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  cachedPlayerId = fresh;
  try {
    window.localStorage.setItem("coop-blocks.playerId", fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

// ===== Transporte =====

function roomPath(roomId: string): string {
  return `/api/lobby/rooms/${encodeURIComponent(roomId)}`;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Player-Id", getPlayerId());
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch {
    throw new Error(
      "Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente."
    );
  }

  if (res.ok) {
    // 204 No Content — operações sem corpo de resposta
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("Resposta inválida do servidor.");
    }
  }

  // Erro — tenta extrair mensagem amigável do corpo JSON
  let message = "";
  try {
    const body = (await res.json()) as { error?: string };
    message = body.error ?? "";
  } catch {
    /* corpo não-JSON */
  }
  if (!message) {
    message = FALLBACK_STATUS_MESSAGES[res.status] ?? `Erro inesperado (HTTP ${res.status}).`;
  }
  throw new Error(message);
}

/** Mensagens amigáveis para códigos de status conhecidos, quando o corpo não traz `error`. */
const FALLBACK_STATUS_MESSAGES: Record<number, string> = {
  400: "Requisição inválida.",
  401: "Sessão não reconhecida. Recarregue a página e tente novamente.",
  403: "Acesso negado.",
  404: "Sala não encontrada.",
  409: "Não foi possível concluir a operação na sala.",
  429: "Muitas tentativas. Aguarde um instante e tente novamente.",
  500: "Erro interno do servidor. Tente novamente em instantes.",
};

// ===== Funções públicas do lobby =====

/** Lista as salas públicas disponíveis (nome, jogadores 1–4, fase). */
export async function listPublicRooms(): Promise<RoomSummary[]> {
  return request<RoomSummary[]>(`/api/lobby/rooms`);
}

/** Cria uma sala e já entra nela como dona/dono. */
export async function createRoom({
  name,
  isPublic,
  password,
}: CreateRoomParams): Promise<LobbyState> {
  return request<LobbyState>(`/api/lobby/rooms`, {
    method: "POST",
    body: JSON.stringify({
      name: name.trim(),
      // Sala pública = sem senha no backend (RoomConfig.Password == "")
      password: isPublic ? "" : (password ?? ""),
    }),
  });
}

/** Entra em uma sala existente (com senha, se houver). */
export async function joinRoom({ roomId, password }: JoinRoomParams): Promise<LobbyState> {
  return request<LobbyState>(`${roomPath(roomId)}/join`, {
    method: "POST",
    body: JSON.stringify({ password: password ?? "" }),
  });
}

/** Sai da sala atual. Resolve quando o servidor confirmar (204). */
export async function leaveRoom(roomId: string): Promise<void> {
  await request<void>(`${roomPath(roomId)}/leave`, { method: "POST" });
}

/** Alterna o estado "pronto" do jogador atual e devolve o estado atualizado. */
export async function setReady({ roomId, ready }: SetReadyParams): Promise<LobbyState> {
  return request<LobbyState>(`${roomPath(roomId)}/ready`, {
    method: "POST",
    body: JSON.stringify({ ready }),
  });
}

/** Inicia a partida (apenas o dono). Resolve com 204 em caso de sucesso. */
export async function startGame(roomId: string): Promise<void> {
  await request<void>(`${roomPath(roomId)}/start`, { method: "POST" });
}

/**
 * Busca o estado atual de uma sala (polling da tela de espera).
 * Mantém players/ready sincronizados sem depender de WebSocket.
 */
export async function getLobbyState(roomId: string): Promise<LobbyState> {
  return request<LobbyState>(roomPath(roomId));
}
