import kaplay from "kaplay";
import { createPlayer } from "./player";
import { spawnEnemy } from "./enemies";
import { generateLevel } from "./levelgen";
import { connectToServer, type NetPlayer } from "./net";

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
  hudEl.textContent = `🧱 coop-blocks — HP ${hp}/${MAX_HP} — jogadores online: ${netCount}`;
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
  hudEl.textContent = `💀 Você morreu! Recarregue a página para reiniciar.`;
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
onKeyDown("left", () => player.move(-1));
onKeyDown("right", () => player.move(1));
onKeyPress("space", () => player.jump());
onKeyPress("x", () => player.shoot());

// ===== Câmera segue o jogador =====
onUpdate(() => {
  if (player.exists()) k.camPos(vec2(player.pos.x, 360));
});
