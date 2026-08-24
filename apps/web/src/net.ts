import type { KAPLAYCtx, GameObj } from "kaplay";

/**
 * Cliente multiplayer via WebSocket.
 * Envia posição/estado do jogador local e recebe a lista de jogadores remotos.
 */
export interface NetPlayer {
  id: string;
  x: number;
  y: number;
  hp: number;
}

export interface NetOpts {
  url: string;
  player: GameObj<any>;
  onPlayers: (list: NetPlayer[]) => void;
  onPlayerJoin: (np: NetPlayer) => void;
  onPlayerLeave: (id: string) => void;
}

export function connectToServer(k: KAPLAYCtx, opts: NetOpts) {
  const { add, pos, rect, color, z, onUpdate, destroy } = k;

  let ws: WebSocket | null = null;
  let myId = "";
  let connected = false;

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // URL absoluta (http/https/ws/wss — ex.: VITE_API_URL apontando para o
    // backend real em outro host) é usada direto, convertendo http(s) → ws(s)
    // para o construtor WebSocket. URL relativa mantém o comportamento
    // same-origin (reverse proxy nginx da produção primária).
    const absolute = /^(wss?|https?):\/\//i.test(opts.url);
    const target = absolute
      ? opts.url.replace(/^http/i, "ws")
      : `${proto}://${location.host}${opts.url}`;
    ws = new WebSocket(target);

    ws.onopen = () => {
      connected = true;
      sendState();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "welcome") {
          myId = msg.id;
          opts.onPlayers(msg.players ?? []);
        } else if (msg.type === "player_join") {
          opts.onPlayerJoin(msg.player);
        } else if (msg.type === "player_leave") {
          opts.onPlayerLeave(msg.id);
        } else if (msg.type === "players") {
          opts.onPlayers(msg.players ?? []);
        }
      } catch {
        /* ignora mensagem inválida */
      }
    };

    ws.onclose = () => {
      connected = false;
      setTimeout(connect, 2000);
    };
  }

  function sendState() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "state",
        x: Math.round(opts.player.pos.x),
        y: Math.round(opts.player.pos.y),
        hp: opts.player.hp,
      })
    );
  }

  // Envia estado ~10x/s enquanto conectado
  onUpdate(() => {
    if (connected) sendState();
  });

  connect();

  return { myId: () => myId, sendState };
}
