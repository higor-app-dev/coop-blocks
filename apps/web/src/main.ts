import kaplay from "kaplay";
import { createPlayer } from "./player";
import { spawnEnemy } from "./enemies";
import { generateLevel, TILE } from "./levelgen";
import { connectToServer, type NetPlayer } from "./net";
import { ACTION_KEYS, keyToAction } from "./input";
import {
  createHud,
  formatDeathMessage,
  loadMutedSession,
  saveMutedSession,
  type HudPlayer,
  type HudState,
} from "./hud";
import { createParticles } from "./particles";
import {
  playCoin,
  playDamage,
  playDeath,
  playJump,
  playPowerUp,
  playShoot,
  playUI,
  resumeAudio,
  setMuted,
  startMusic,
} from "./audio";

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
  pos,
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

// ===== Áudio + partículas =====
// Mute aplicado IMEDIATAMENTE (master gain nasce no estado correto mesmo
// antes do primeiro som) e persistido na sessão (sessionStorage).
setMuted(loadMutedSession());
// O módulo de partículas espera um engine estrutural mínimo (`randInt` — o
// kaplay expõe `randi`) e `add` retornando ParticleObj (o GameObj do kaplay é
// compatível em runtime). Cast na borda: o módulo só toca pos/opacity/vel.
const particles = createParticles(
  { ...k, randInt: k.randi } as unknown as Parameters<typeof createParticles>[0]
);

// ===== HUD =====
// Overlay criado uma única vez; o estado completo do jogo é passado a cada
// frame no onUpdate (seção "Câmera + HUD" abaixo). O botão de mute alterna
// o estado global de áudio e persiste na sessão.
const hud = createHud({
  muted: loadMutedSession(),
  onMuteToggle: (m) => {
    setMuted(m);
    saveMutedSession(m);
    if (!m) playUI(); // feedback audível ao desmutar
  },
});
let localDead = false;

// ===== Inicialização do áudio no primeiro gesto =====
// A política de autoplay dos browsers deixa o AudioContext suspenso até um
// gesto do usuário. Amarramos a criação/retomada ao primeiro pointerdown ou
// keydown (cobre mouse, toque e teclado) e então ligamos a música procedural.
let audioInitialized = false;
const initAudio = () => {
  if (audioInitialized) return;
  audioInitialized = true;
  resumeAudio();
  startMusic();
};
window.addEventListener("pointerdown", initAudio, { once: true });
window.addEventListener("keydown", initAudio, { once: true });

// ===== Fase gerada automaticamente =====
const level = generateLevel(k, { width: 120, height: 12, seed: Date.now() });
level.render();

// ===== Moedas (coleta) =====
// Fileira de moedas sobre o chão (toda 4ª coluna sólida, acima do tile de
// solo). Coleta: som de moeda + partículas douradas + contador no HUD.
let teamCoins = 0;
// Topo do chão: o tile mais baixo do grid (o chão tem 2 fileiras, a superior
// é maxY-1). Moedas ficam uma fileira acima do solo.
const GROUND_ROW = Math.max(...level.tiles.map((t) => t.y)) - 1;
for (const t of level.tiles) {
  if (t.y === GROUND_ROW && t.x >= 6 && t.x % 4 === 0) {
    add([
      "coin",
      pos(t.x * TILE + TILE / 2, t.y * TILE - 30),
      rect(14, 14),
      color(255, 215, 60),
      area(),
      z(3),
    ]);
  }
}

// ===== Jogador local =====
const player = createPlayer(k, {
  pos: level.playerSpawn,
  maxHp: MAX_HP,
});
player.onDestroy(() => {
  localDead = true;
});

// ===== Inimigos (base) =====
for (const p of level.enemySpawns) {
  spawnEnemy(k, { pos: p, damage: 10, maxHp: MAX_HP });
}

// ===== Colisões =====

// player × coin — coleta com som + partículas.
onCollide("player", "coin", (pl, c) => {
  playCoin();
  particles.spawnCoinCollect(c.pos.x, c.pos.y);
  destroy(c);
  teamCoins += 1;
});

// player × enemy — dano, feedback de hit; morte → som/partículas + respawn.
onCollide("player", "enemy", (pl, en) => {
  if (pl.hp > 0) {
    pl.hp -= en.damage;
    playDamage();
    particles.spawnDust(pl.pos.x, pl.pos.y + 20, 90);
    if (pl.hp <= 0) {
      pl.hp = 0;
      pl.trigger("death");
      playDeath();
      particles.spawnEnemyDeath(pl.pos.x, pl.pos.y);
      // Não destrói o objeto: esconde + pausa (o net.ts e os handlers ainda
      // referenciam o mesmo player) e respawna no spawn após 3s — mesmo
      // DefaultRespawnTicks do servidor.
      localDead = true;
      pl.hidden = true;
      pl.paused = true;
      wait(3, () => {
        pl.hidden = false;
        pl.paused = false;
        pl.hp = MAX_HP;
        pl.pos = vec2(level.playerSpawn.x, level.playerSpawn.y);
        localDead = false;
        playPowerUp();
        particles.spawnRespawn(pl.pos.x, pl.pos.y);
      });
    }
  }
});

// bullet × solid — impacto de tiro + destrói a bala.
onCollide("bullet", "solid", (b) => {
  particles.spawnShootImpact(b.pos.x, b.pos.y);
  destroy(b);
});

// bullet × enemy — dano no inimigo; morte → explosão + som.
onCollide("bullet", "enemy", (b, en) => {
  particles.spawnShootImpact(b.pos.x, b.pos.y);
  en.hp -= b.damage;
  if (en.hp <= 0) {
    playDeath();
    particles.spawnEnemyDeath(en.pos.x, en.pos.y);
    destroy(en);
  } else {
    playDamage();
  }
  destroy(b);
});

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
// Pulo/tiro disparam som + partículas no momento do gesto; o pulo só toca
// quando o jogador está no chão (o som acompanha o salto real).
const HOLD_KEYS = new Set(["left", "right"]);
for (const key of ACTION_KEYS) {
  const bind = HOLD_KEYS.has(key) ? onKeyDown : onKeyPress;
  bind(key, () => {
    const action = keyToAction(key);
    if (action?.type === "move") player.movePlayer(action.dir);
    else if (action?.type === "jump") {
      if (player.isGrounded()) {
        playJump();
        particles.spawnDust(player.pos.x, player.pos.y + 20, 90);
      }
      player.jumpPlayer();
    } else if (action?.type === "shoot") {
      playShoot();
      particles.spawnShootImpact(
        player.pos.x + player.facing * 24,
        player.pos.y - 10
      );
      player.shoot();
    }
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
    teamCoins,
    status: localDead ? formatDeathMessage() : undefined,
  };
}

// Poeira ao aterrissar: detecta a transição no-ar → chão e solta partículas
// nos pés do jogador (sem som dedicado — o pulo já tem o seu).
let wasGrounded = true;
onUpdate(() => {
  const grounded = player.exists() && player.isGrounded();
  if (grounded && !wasGrounded) {
    particles.spawnDust(player.pos.x, player.pos.y + 20);
  }
  wasGrounded = grounded;

  if (player.exists()) k.setCamPos(vec2(player.pos.x, 360));
  hud.update(buildHudState());
});
