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

/** Estatísticas efetivas de um jogador (upgrades aplicados) no broadcast de fase. */
export interface NetShopStats {
  maxHp: number;
  fireRate: number;
  shield: number;
}

/** Estado individual de um jogador no broadcast de fase (saldo + upgrades). */
export interface NetRunPlayer {
  id: string;
  coins: number;
  stats: NetShopStats;
}

/** Broadcast de fase da run (loja aberta / mapa em andamento). */
export interface NetPhaseState {
  phase: "shop" | "playing";
  number: number;
  ready: Record<string, boolean>;
  players: NetRunPlayer[];
}

/** Comprovante de compra (resposta individual de shop_buy). */
export interface NetBuyReceipt {
  upgrade: string;
  level: number;
  cost: number;
  coins: number;
  stats: NetShopStats;
}

export interface NetOpts {
  url: string;
  player: GameObj<any>;
  onPlayers: (list: NetPlayer[]) => void;
  onPlayerJoin: (np: NetPlayer) => void;
  onPlayerLeave: (id: string) => void;
  /** Broadcast de fase: abre a loja (shop), atualiza prontos ou inicia o próximo mapa (playing). */
  onPhase?: (state: NetPhaseState) => void;
  /** Resposta individual de shop_buy: comprovante (ok) ou erro. */
  onShopBuyResult?: (rc: NetBuyReceipt | { ok: false; error: string }) => void;
  /** Erro individual de shop_ready (fora da loja, jogador desconhecido). */
  onShopReadyError?: (error: string) => void;
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
        } else if (msg.type === "phase") {
          opts.onPhase?.({
            phase: msg.phase === "shop" ? "shop" : "playing",
            number: msg.number ?? 1,
            ready: msg.ready ?? {},
            players: msg.players ?? [],
          });
        } else if (msg.type === "shop_buy_result") {
          if (msg.ok) {
            opts.onShopBuyResult?.({
              upgrade: msg.upgrade,
              level: msg.level,
              cost: msg.cost,
              coins: msg.coins,
              stats: msg.stats ?? {},
            });
          } else {
            opts.onShopBuyResult?.({ ok: false, error: msg.error ?? "compra rejeitada" });
          }
        } else if (msg.type === "shop_ready_result") {
          opts.onShopReadyError?.(msg.error ?? "pronto rejeitado");
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

  // Envia uma mensagem JSON se a conexão estiver aberta (no-op silencioso caso contrário).
  function send(msg: unknown) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  function sendState() {
    send({
      type: "state",
      x: Math.round(opts.player.pos.x),
      y: Math.round(opts.player.pos.y),
      hp: opts.player.hp,
    });
  }

  // Envia estado ~10x/s enquanto conectado
  onUpdate(() => {
    if (connected) sendState();
  });

  connect();

  return {
    myId: () => myId,
    sendState,
    /** Intenção de compra na loja — o servidor valida e responde shop_buy_result. */
    sendShopBuy: (upgrade: string) => send({ type: "shop_buy", upgrade }),
    /** Confirmação de 'pronto' na loja — o servidor broadcasta o novo estado de fase. */
    sendShopReady: () => send({ type: "shop_ready" }),
  };
}
