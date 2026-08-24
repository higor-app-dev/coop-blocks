import kaplay from "kaplay";
import { createPlayer } from "./player";
import { spawnEnemy } from "./enemies";
import { generateLevel } from "./levelgen";
import { connectToServer, type NetPlayer } from "./net";
import { ACTION_KEYS, keyToAction } from "./input";
import { formatDeathMessage, formatHud } from "./hud";

// ===== Configuração do jogo =====
const k = kaplay({
  width: 960,
  height: 540,
  letterbox: true,
  background: [18, 18, 30],
  global: false,
});

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
const hudEl = document.getElementById("hud")!;
function updateHud(hp: number, netCount: number) {
  hudEl.textContent = formatHud(hp, MAX_HP, netCount);
}

// ===== Fase gerada automaticamente =====
const level = generateLevel(k, { width: 120, height: 12, seed: Date.now() });
level.render();

// ===== Jogador local =====
const player = createPlayer(k, {
  pos: level.playerSpawn,
  maxHp: MAX_HP,
  onHpChange: (hp) => updateHud(hp, netPlayers.length),
});
player.onDestroy(() => {
  hudEl.textContent = formatDeathMessage();
});

// ===== Inimigos (base) =====
const enemySpawners: Array<() => void> = [];
for (const p of level.enemySpawns) {
  enemySpawners.push(() => {
    const e = spawnEnemy(k, { pos: p, damage: 10, maxHp: MAX_HP });
    onCollide("player", "enemy", (pl, en) => {
      if (pl.hp > 0) {
        pl.hp -= en.damage;
        updateHud(pl.hp, netPlayers.length);
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
  url: (import.meta.env.DEV ? "" : "") + "/api/ws",
  player,
  onPlayers: (list) => {
    netPlayers.length = 0;
    for (const np of list) {
      if (np.id === server.myId()) continue;
      netPlayers.push(np);
    }
    updateHud(player.hp, netPlayers.length);
  },
  onPlayerJoin: (np) => {
    if (np.id !== server.myId() && !netPlayers.find((p) => p.id === np.id)) {
      netPlayers.push(np);
      updateHud(player.hp, netPlayers.length);
    }
  },
  onPlayerLeave: (id) => {
    const i = netPlayers.findIndex((p) => p.id === id);
    if (i >= 0) {
      netPlayers.splice(i, 1);
      updateHud(player.hp, netPlayers.length);
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
    if (action?.type === "move") player.moveBy(action.dir);
    else if (action?.type === "jump") player.doJump();
    else if (action?.type === "shoot") player.shoot();
  });
}

// ===== Câmera segue o jogador =====
onUpdate(() => {
  if (player.exists()) k.camPos(vec2(player.pos.x, 360));
});
