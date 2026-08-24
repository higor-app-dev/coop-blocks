import kaplay from "kaplay";
import { createPlayer } from "./player";
import { spawnEnemy } from "./enemies";
import { generateLevel } from "./levelgen";
import { connectToServer, type NetPlayer } from "./net";
import { ACTION_KEYS, keyToAction } from "./input";
import {
  createHud,
  formatDeathMessage,
  type HudPlayer,
  type HudState,
} from "./hud";

// ===== Configuração do jogo =====
// Canvas dentro do container #app (100% da viewport). letterbox mantém a
// proporção 960x540 com barras pretas em qualquer viewport; pixelDensity
// limita a resolução do buffer em telas retina (nítido sem matar a GPU).
const k = kaplay({
  width: 960,
  height: 540,
  letterbox: true,
  background: [18, 18, 30],
  global: false,
  root: document.getElementById("app")!,
  pixelDensity: Math.min(window.devicePixelRatio || 1, 2),
});

// ===== Gravidade =====
// kaplay 3001 inicializa game.gravity = null por padrão (o config `gravity`
// NÃO é lido do objeto de opções). Sem gravidade o componente `body` nunca
// aterra (isGrounded() sempre false) → pulo nunca dispara e o jogador não cai
// em buracos. setGravity(980) = ~1g para o mundo de 960x540.
k.setGravity(980);

// ===== Canvas responsivo: reconfigura em resize/orientação =====
// O Kaplay 3001 já re-letterboxa sozinho (ResizeObserver interno no canvas +
// recompute do viewport). Aqui só reforçamos o buffer na resolução atual do
// container e re-medimos após mudança de orientação (iOS atrasa o resize do
// layout, então um rAF + timeout cobre o intervalo). Idempotente com o
// handler interno — os valores convergem para os mesmos.
function refitCanvas() {
  const c = k.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(c.offsetWidth * dpr);
  const h = Math.round(c.offsetHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
}
let refitRaf = 0;
function scheduleRefit() {
  cancelAnimationFrame(refitRaf);
  refitRaf = requestAnimationFrame(refitCanvas);
}
window.addEventListener("resize", scheduleRefit);
window.addEventListener("orientationchange", () => setTimeout(scheduleRefit, 150));

const {
  add,
  onKeyDown,
  onKeyPress,
  onUpdate,
  onCollide,
  vec2,
  rect,
  color,
  text,
  area,
  body,
  scale,
  z,
  destroy,
  wait,
  rand,
} = k;

const MAX_HP = 100;

// ===== HUD =====
// Overlay criado uma única vez; o estado completo do jogo é passado a cada
// frame no onUpdate (seção "Câmera + HUD" abaixo).
const hud = createHud();
let localDead = false;

// ===== Fase gerada automaticamente =====
const level = generateLevel(k, { width: 120, height: 12, seed: Date.now() });
level.render();

// ===== Jogador local =====
const player = createPlayer(k, {
  pos: level.playerSpawn,
  maxHp: MAX_HP,
});
player.onDestroy(() => {
  localDead = true;
});

// ===== Inimigos (base) =====
const enemySpawners: Array<() => void> = [];
for (const p of level.enemySpawns) {
  enemySpawners.push(() => {
    const e = spawnEnemy(k, { pos: p, damage: 10, maxHp: MAX_HP });
    onCollide("player", "enemy", (pl, en) => {
      if (pl.hp > 0) {
        pl.hp -= en.damage;
        if (pl.hp <= 0) {
          pl.trigger("death");
          destroy(pl);
        }
      }
    });
  });
}
for (const spawn of enemySpawners) spawn();

// ===== Multiplayer (WebSocket) =====
const netPlayers: NetPlayer[] = [];
const server = connectToServer(k, {
  // VITE_API_URL (build-time, Vercel) aponta para o backend real quando o
  // front não é servido pelo nginx same-origin (ex.: mirror Vercel). Sem a
  // env, mantém a URL relativa → reverse proxy same-origin da produção.
  url: import.meta.env.VITE_API_URL ?? "/api/ws",
  player,
  onPlayers: (list) => {
    netPlayers.length = 0;
    for (const np of list) {
      if (np.id === server.myId()) continue;
      netPlayers.push(np);
    }
  },
  onPlayerJoin: (np) => {
    if (np.id !== server.myId() && !netPlayers.find((p) => p.id === np.id)) {
      netPlayers.push(np);
    }
  },
  onPlayerLeave: (id) => {
    const i = netPlayers.findIndex((p) => p.id === id);
    if (i >= 0) {
      netPlayers.splice(i, 1);
    }
  },
});

// ===== Controles =====
// Teclas de "segurar" (movimento) via onKeyDown; ações pontuais via onKeyPress.
const HOLD_KEYS = new Set(["left", "right"]);
for (const key of ACTION_KEYS) {
  const bind = HOLD_KEYS.has(key) ? onKeyDown : onKeyPress;
  bind(key, () => {
    const action = keyToAction(key);
    if (action?.type === "move") player.movePlayer(action.dir);
    else if (action?.type === "jump") player.jumpPlayer();
    else if (action?.type === "shoot") player.shoot();
  });
}

// ===== Câmera segue o jogador + HUD a cada frame =====
// O estado do HUD é montado do estado real do jogo e passado para o módulo
// hud.ts, que renderiza o overlay. O servidor ainda não envia nome/cor/moedas/
// fase — os campos opcionais ficam ocultos até esses dados existirem.
function buildHudState(): HudState {
  const players: HudPlayer[] = [];
  const cam = k.getCamPos();

  if (player.exists()) {
    players.push({
      id: server.myId() || "local",
      name: "Você",
      color: "rgb(66, 200, 245)",
      hp: player.hp,
      maxHp: MAX_HP,
      x: player.pos.x,
      y: player.pos.y,
    });
  }
  for (const np of netPlayers) {
    players.push({
      id: np.id,
      name: "Jogador",
      color: "rgb(200, 200, 200)",
      hp: np.hp,
      maxHp: MAX_HP,
      x: np.x,
      y: np.y,
    });
  }

  return {
    players,
    localPlayerId: server.myId() || "local",
    camera: { x: cam.x, y: cam.y, width: k.width(), height: k.height() },
    status: localDead ? formatDeathMessage() : undefined,
  };
}

onUpdate(() => {
  if (player.exists()) k.setCamPos(vec2(player.pos.x, 360));
  hud.update(buildHudState());
});
