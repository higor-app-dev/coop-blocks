import kaplay from "kaplay";
import { createPlayer } from "./player";
import {
  ENEMY_MAX_COIN_DROP,
  ENEMY_MIN_COIN_DROP,
  pickEnemyType,
  spawnEnemy,
  type EnemyShot,
} from "./enemies";
import { generateLevel, isLevelFinished, TILE, mulberry32, type LevelData } from "./levelgen";
import { connectToServer, type NetCoin, type NetPhaseState, type NetPlayer } from "./net";
import { createCoinLayer, levelCoin } from "./coins";
import { createPowerUpLayer } from "./powerups";
import { createInput } from "./input";
import { computeButtonSpecs } from "./touch-buttons";
import {
  createHud,
  formatDeathMessage,
  loadMutedSession,
  saveMutedSession,
  type HudPlayer,
  type HudState,
} from "./hud";
import { createParticles } from "./particles";
import { buyLocal, createShop, fireCooldownMs, type ShopStats } from "./shop";
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
import { createBossLayer } from "./boss";

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
window.addEventListener("resize", () => {
  scheduleRefit();
  refreshTouchButtons();
});
window.addEventListener("orientationchange", () => {
  // iOS atrasa o resize do layout — o timeout cobre o intervalo; o refresh
  // dos botões usa o mesmo ritmo (safe-area só muda na rotação).
  setTimeout(scheduleRefit, 150);
  setTimeout(refreshTouchButtons, 150);
});

const {
  add,
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
  fixed,
  anchor,
  outline,
  rgb,
  destroy,
  destroyAll,
  wait,
  rand,
} = k;

const MAX_HP = 100;
// Tags dos objetos que pertencem ao MUNDO (mapa atual) e são destruídos na
// transição de fase — o player é reutilizado entre mapas, não entra aqui.
// "hostile" são os projéteis do atirador (IA local), limpos junto do mundo.
// Moedas NÃO estão na lista: o ciclo de vida delas pertence à coinLayer
// (única criadora/destruidora), que o buildWorld limpa via clear().
const WORLD_TAGS = ["solid", "enemy", "hostile"];

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

// ===== Moedas =====
// A coinLayer é a ÚNICA criadora/destruidora de moedas renderizadas (tag
// "coin"): no multiplayer ela espelha o estado autoritativo do servidor
// (broadcast coins/removed/counts); no singleplayer local ela recebe a
// geração da fase e os drops de inimigos via applyFull/addCoins. O efeito de
// coleta (som + partículas) é disparado quando o servidor broadcasta uma
// remoção — o client reage ao evento mesmo sem ter coletado localmente.
const coinLayer = createCoinLayer(k, {
  onCollect: (c) => {
    playCoin();
    particles.spawnCoinCollect(c.x, c.y);
  },
});
// true = moedas autoritativas do servidor (primeiro broadcast recebido).
// Enquanto false (offline/sem servidor ainda), a fase gera moedas locais.
let serverCoins = false;
// Contadores da fase por jogador (broadcast do servidor) — alimentam os
// badges de moedas do HUD no multiplayer.
let coinCounts: Record<string, number> = {};

// ===== Power-ups (multiplayer — servidor autoritativo) =====
// A powerUpLayer é a ÚNICA criadora/destruidora de power-ups renderizados
// (tag "powerup"): ela espelha o estado autoritativo do servidor (WorldMsg
// `powerUps` / PowerUpsMsg `removed`) e o onCollect dispara o feedback de
// coleta (som + partículas) quando o servidor anuncia a remoção — o client
// NUNCA decide efeitos nem gera power-ups (singleplayer offline = camada
// vazia, sem power-ups: sem servidor, sem efeito).
const powerUpLayer = createPowerUpLayer(k, {
  onCollect: (r) => {
    playPowerUp();
    particles.spawnPowerUpCollect(r.x, r.y);
  },
});
// Efeitos ativos por jogador (broadcast do servidor — powerUpEffects):
// alimentam os badges do HUD, o tiro triplo do jogador local e a bolha de
// escudo. Presença/ausência é 100% espelho do servidor.
let powerUpEffects: Record<string, { vida: number; tripleShot: number; shield: number }> = {};

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
// Marco (performance.now) de quando o jogador local morreu — alimenta a
// contagem regressiva do respawn no painel do HUD. Zerado ao voltar à vida.
let localDeadSince = 0;

// ===== Boss (multiplayer — servidor autoritativo) =====
// O boss só existe em fases múltiplas de 5 e é 100% do servidor: a camada
// renderiza o bloco gigante na posição/estado/HP broadcastados (WorldMsg
// `boss` — null sem boss, o client esconde) e expõe hp()/maxHp()/state()
// para a barra do HUD (card filho t_b08df194). Sem simulação local e sem
// colisão (bloco permissivo: players passam por cima/por baixo — o risco
// vem dos ataques do servidor). O buildWorld limpa a camada na troca de fase.
const bossLayer = createBossLayer(k);
// DEBUG — expõe a camada para o smoke test e2e (mesmo padrão das moedas).
(window as unknown as Record<string, unknown>).__dbgBoss = bossLayer;
// DEBUG — estado ao vivo para o smoke test e2e (mesmo padrão das moedas/boss).
(window as unknown as Record<string, unknown>).__dbgGame = {
  get player() {
    return player
      ? { x: player.pos.x, y: player.pos.y, hp: player.hp, hidden: player.hidden, paused: player.paused }
      : null;
  },
  get playerObj() {
    return player;
  },
  get coinLayer() {
    return coinLayer;
  },
  get coins() {
    return { teamCoins, serverCoins, active: coinLayer.size(), phase: currentLevelNumber };
  },
  get enemies() {
    return k.get("enemy").map((e) => ({ x: e.pos.x, y: e.pos.y, hp: e.hp }));
  },
  get bullets() {
    return k.get("bullet").map((b) => ({ x: b.pos.x, y: b.pos.y, vel: b.vel }));
  },
  // DEBUG — stats da run e caixa individual (loja offline) para o smoke test.
  get runStats() {
    return localStats;
  },
  get wallet() {
    return coinWallet;
  },
  get phase() {
    return currentLevelNumber;
  },
  hurt: (n: number) => hurtLocalPlayer(n),
  dropAt: (x: number, y: number) => dropCoins(x, y),
  shoot: () => player.shoot(),
};

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

// ===== Fase da run (loja entre mapas) =====
// O servidor é autoritativo: broadcasta phase="shop" ao fim de cada mapa e
// phase="playing" (número novo) quando TODOS confirmaram 'pronto'. Aqui
// guardamos o último estado recebido para renderizar a loja e reconstruir o
// mundo no avanço de fase.
let phaseState: NetPhaseState | null = null;
let currentLevelNumber = 1;
// Teto de vida efetivo do jogador local (100 base + upgrades de max_hp).
let playerMaxHp = MAX_HP;

// ===== Mundo (mapa atual) =====
// O mapa N é gerado com seed = N — espelho do servidor (baseSeed=1 +
// (número-1) em cmd/server/main.go): a mesma fase é sempre o mesmo mapa para
// todos os jogadores. O player é criado UMA vez (net.ts e os handlers de
// colisão seguram a referência) e reposicionado entre fases.
let level: LevelData;

function buildWorld(number: number, maxHp: number): void {
  // Destrói o mundo anterior (tiles/inimigos/moedas); o player sobrevive.
  for (const tag of WORLD_TAGS) {
    destroyAll(tag);
  }
  coinLayer.clear();
  teamCoins = 0;

  level = generateLevel(k, {
    width: 120,
    height: 12,
    seed: number,
    difficulty: number,
  });
  level.render();

  // Moedas da fase — singleplayer local (offline): o gerador de fase
  // (levelgen.ts, generateLevelData → coinSpawns) decide ONDE ficam as
  // moedas com as MESMAS regras do servidor (Level.CoinSpawns: chão com
  // x>=6/x%4==0 + topos de plataforma com scatter seed-dependente), e aqui
  // só convertemos tile→px (levelCoin: centro da coluna, flutuando 30px,
  // top-left da hitbox 14x14) com IDs sequenciais c1..cN na ordem canônica
  // — os MESMOS IDs/posições que o servidor atribuiria à fase. No
  // multiplayer o primeiro broadcast de moedas assume a autoridade
  // (serverCoins=true) e estas locais são descartadas pela coinLayer.clear().
  if (!serverCoins) {
    const localCoins: NetCoin[] = level.coinSpawns.map((t, i) =>
      levelCoin(t.x, t.y, `c${i + 1}`)
    );
    coinLayer.applyFull(localCoins);
  }

  // Inimigos (IA 100% local, singleplayer offline): um por spawn do levelgen,
  // com tipo sorteado do pool da fase (andador 1+, voador 3+, atirador 5+) via
  // mulberry32 da seed do mapa — mesmo elenco determinístico a cada
  // reconstrução da fase (reset/spawn). O núcleo puro de enemies.ts consome o
  // grid (tiles sólidos) e o player local como alvo do atirador.
  const solidTiles = new Set(level.tiles.map((t) => `${t.x},${t.y}`));
  const enemyWorld = {
    width: 120 * TILE,
    height: 12 * TILE,
    solid: (tx: number, ty: number) => solidTiles.has(`${tx},${ty}`),
  };
  const localPlayerForAi = () => [
    {
      id: "local",
      x: player.pos.x,
      y: player.pos.y,
      w: 28,
      h: 40,
      hp: player.hp,
    },
  ];
  const enemyRng = mulberry32(number);
  let enemySeq = 0;
  for (const p of level.enemySpawns) {
    enemySeq += 1;
    spawnEnemy(k, {
      pos: p,
      type: pickEnemyType(number, enemyRng),
      phase: number,
      id: `e${enemySeq}`,
      world: enemyWorld,
      players: localPlayerForAi,
      onShot: spawnHostileShot,
    });
  }

  // Player local: reposiciona no spawn do novo mapa com o teto efetivo.
  player.hp = maxHp;
  player.pos = vec2(level.playerSpawn.x, level.playerSpawn.y);
  player.hidden = false;
  player.paused = false;
  playerMaxHp = maxHp;
  localDead = false;
  // O mundo novo não tem boss até o servidor broadcastar (SpawnForLevel nas
  // fases múltiplas de 5) — a camada nasce vazia a cada reconstrução.
  bossLayer.clear();
  // Power-ups: camada vazia a cada reconstrução (o servidor broadcasta os da
  // fase nova) e efeitos da fase anterior zerados — efeitos não vazam entre
  // fases (PowerUpManager.Reset + ReviveAll no servidor; o client espelha).
  powerUpLayer.clear();
  powerUpEffects = {};
}

// ===== Jogador local =====
// Nascido com o spawn da fase 1 (o mundo é construído logo abaixo); entre
// fases buildWorld apenas o reposiciona — a referência nunca muda.
let player = createPlayer(k, {
  pos: generateLevel(k, { width: 120, height: 12, seed: 1 }).playerSpawn,
  maxHp: MAX_HP,
});
player.onDestroy(() => {
  localDead = true;
});

let teamCoins = 0;
// Caixa individual de moedas (persiste entre fases — é o saldo que a loja
// local usa). teamCoins é só o contador da fase atual e zera a cada
// buildWorld; na transição de fase o caixa recebe o total da fase ANTES do
// rebuild. Morte/reset da fase NÃO mexe no caixa (só no contador da fase).
let coinWallet = 0;
// Stats da run no singleplayer local (offline): upgrades comprados na loja
// local. São a fonte autoritativa OFFLINE — espelho do que o servidor
// manteria (NetRunPlayer.stats no multiplayer). maxHp vira o teto de vida do
// buildWorld, fireRate acelera o cooldown de tiro local e shield absorve 1
// hit (hurtLocalPlayer consome a carga).
let localStats: ShopStats = { maxHp: MAX_HP, fireRate: 1, shield: 0 };
// Transição de fase em andamento — impede disparo duplicado do fim de mapa.
let transitioning = false;
buildWorld(1, MAX_HP);

// ===== Bolha de escudo do jogador local (poder visual — espelho do servidor) =====
// Anel azul ao redor do player enquanto o ESCUDO (power-up) estiver ativo.
// Nasce oculto; o onUpdate mostra/esconde conforme o broadcast de efeitos
// (shield > 0). Quando o servidor consome a carga (absorveu 1 hit e o escudo
// some), o próximo broadcast traz shield = 0 e a bolha desaparece — o client
// apenas reflete, nunca decide.
const shieldBubble = add([
  "shield-bubble",
  pos(0, 0),
  rect(34, 46, { fill: false, radius: 8 }),
  outline(2, rgb(120, 200, 255)),
  z(9),
]);
shieldBubble.hidden = true;

// ===== Loja entre fases (overlay) =====
// Aparece quando a loja abre — no multiplayer quando o servidor broadcasta
// phase="shop"; no singleplayer local (offline) quando o jogador cruza o fim
// do mapa. Comprar dispara shop_buy (servidor) ou a compra local (offline);
// confirmar dispara shop_ready (servidor) ou avança a fase local. O overlay
// some quando a fase volta para "playing" — aí o buildWorld reconstrói o
// próximo mapa.
const shop = createShop({
  onBuy: (upgrade) => {
    if (phaseState) {
      // Multiplayer: o servidor valida, debita e responde shop_buy_result.
      server.sendShopBuy(upgrade);
      return;
    }
    // Singleplayer local (offline): a loja é local — valida, debita o caixa
    // individual e aplica o upgrade na run; o comprovante atualiza a tela.
    const res = buyLocal(coinWallet, localStats, upgrade);
    if (res.ok) {
      coinWallet = res.wallet;
      localStats = res.stats;
      shop.applyBuyResult(res.receipt);
      playUI();
    } else {
      shop.showError(res.error);
    }
  },
  onReady: () => {
    if (phaseState) {
      server.sendShopReady();
      return;
    }
    advanceOfflinePhase();
  },
});

// Pausa/retoma o mundo no singleplayer local (offline): o servidor pausa o
// mundo durante a loja (sem dano/tiro/coleta no tick) — aqui a loja local
// congela o player, inimigos e projéteis para o jogador não morrer/mover
// atrás do overlay. Objetos novos (próximo buildWorld) nascem não-pausados.
function setWorldPaused(paused: boolean): void {
  for (const obj of k.get("enemy")) obj.paused = paused;
  for (const obj of k.get("hostile")) obj.paused = paused;
  for (const obj of k.get("bullet")) obj.paused = paused;
  if (player.exists()) player.paused = paused;
}

// Abre a loja local (offline): alimenta o overlay com um estado sintético de
// fase (caixa individual + stats da run) — o mesmo wire do multiplayer, com
// o jogador local como único participante.
function openLocalShop(): void {
  shop.update(
    {
      phase: "shop",
      number: currentLevelNumber,
      ready: { local: false },
      players: [{ id: "local", coins: coinWallet, stats: localStats }],
    },
    "local"
  );
}

// Confirmação de 'pronto' na loja local (offline): fecha o overlay, avança a
// fase (nova seed/dificuldade) e reconstrói o mundo com o teto de vida
// efetivo (upgrades de max_hp comprados na run).
function advanceOfflinePhase(): void {
  shop.update(
    { phase: "playing", number: currentLevelNumber + 1, ready: {}, players: [] },
    "local"
  );
  currentLevelNumber += 1;
  buildWorld(currentLevelNumber, localStats.maxHp);
  transitioning = false;
}

// ===== Colisões =====

// player × coin — coleta. No multiplayer o servidor é autoritativo: detecta
// a sobreposição (AABB) e broadcasta `removed` + counts — a coinLayer remove
// na hora e o onCollect toca som/partículas; nada é feito localmente. No
// singleplayer local a coleta é imediata: som + partículas + contador do time.
onCollide("player", "coin", (pl, c) => {
  if (serverCoins) return;
  playCoin();
  particles.spawnCoinCollect(c.pos.x, c.pos.y);
  const id = (c as unknown as { coinId?: string }).coinId;
  if (id) coinLayer.remove(id);
  teamCoins += 1;
});

// Dano no jogador local (contato de inimigo ou projétil hostil): HP cai,
// feedback de áudio/partículas e, na morte, squad wipe com 1 player = RESET
// da fase atual com a MESMA seed após 3 s (DefaultRespawnTicks do servidor).
function hurtLocalPlayer(n: number): void {
  if (player.hp <= 0) return;
  // Escudo da loja (singleplayer local, offline): consome 1 carga e zera o
  // dano — espelho do AbsorbShield do servidor (main.go applyDamage: consome
  // a carga e não aplica dano). Online o servidor é quem decide (o client
  // apenas reflete o broadcast); aqui não há servidor, então o client decide.
  if (!phaseState && localStats.shield > 0) {
    localStats.shield -= 1;
    playPowerUp();
    particles.spawnShootImpact(player.pos.x, player.pos.y);
    return;
  }
  player.hp -= n;
  playDamage();
  particles.spawnDust(player.pos.x, player.pos.y + 20, 90);
  if (player.hp <= 0) {
    player.hp = 0;
    player.trigger("death");
    playDeath();
    particles.spawnEnemyDeath(player.pos.x, player.pos.y);
    // Squad wipe com 1 player (singleplayer local): a morte do único
    // jogador = time inteiro morto → RESET da fase atual com a MESMA seed
    // (moedas e inimigos renascem; o mundo é reconstruído idêntico).
    // Delay de 3s = DefaultRespawnTicks do servidor. Não destrói o objeto:
    // esconde + pausa (os handlers ainda referenciam o mesmo player) e o
    // buildWorld reposiciona no spawn com HP cheio.
    localDead = true;
    player.hidden = true;
    player.paused = true;
    wait(3, () => {
      buildWorld(currentLevelNumber, playerMaxHp);
      playPowerUp();
      particles.spawnRespawn(player.pos.x, player.pos.y);
    });
  }
}

// player × enemy — dano de contato (mesmo para os 3 tipos; o valor vive no
// objeto: ENEMY_CONTACT_DAMAGE, 10).
onCollide("player", "enemy", (pl, en) => {
  hurtLocalPlayer(en.damage);
});

// bullet × solid — impacto de tiro + destrói a bala.
onCollide("bullet", "solid", (b) => {
  particles.spawnShootImpact(b.pos.x, b.pos.y);
  destroy(b);
});

// bullet × enemy — dano no inimigo (HP por tipo: andador 25, voador/atirador
// 50); morte → explosão + som + drop de moedas.
onCollide("bullet", "enemy", (b, en) => {
  particles.spawnShootImpact(b.pos.x, b.pos.y);
  en.hp -= b.damage;
  if (en.hp <= 0) {
    playDeath();
    particles.spawnEnemyDeath(en.pos.x, en.pos.y);
    dropCoins(en.pos.x, en.pos.y);
    destroy(en);
  } else {
    playDamage();
  }
  destroy(b);
});

// Drop de moedas na destruição do inimigo (1–3, faixa do servidor): moedas
// estáticas espalhadas ao redor do ponto de morte. Apenas no singleplayer
// local — no multiplayer as moedas são autoritativas do servidor (ele mesmo
// droparia as moedas na destruição dos inimigos da simulação dele; um drop
// local seria uma moeda fantasma que o próximo broadcast removeria).
let dropSeq = 0;
function dropCoins(x: number, y: number): void {
  if (serverCoins) return;
  const count = Math.floor(rand(ENEMY_MIN_COIN_DROP, ENEMY_MAX_COIN_DROP + 1));
  const drops: NetCoin[] = [];
  for (let i = 0; i < count; i++) {
    dropSeq += 1;
    drops.push({
      id: `d${dropSeq}`,
      x: x + (i - (count - 1) / 2) * 16,
      y: y - 6,
      w: 14,
      h: 14,
    });
  }
  coinLayer.addCoins(drops);
}

// ===== Projéteis hostis (atirador, IA local) =====
// O atirador dispara na direção do player; o projétil viaja em linha reta com
// velocidade constante, some ao sair do mundo ou após o lifetime (260 px/s e
// 4 s, mesmos do servidor) e acerta o player (25 de dano, ProjectileDamage).
function spawnHostileShot(shot: EnemyShot): void {
  const dx = shot.targetX - shot.x;
  const dy = shot.targetY - shot.y;
  const dist = Math.hypot(dx, dy) || 1;
  const vx = (dx / dist) * shot.speed;
  const vy = (dy / dist) * shot.speed;

  const hb = add([
    "hostile",
    pos(shot.x - 5, shot.y - 5),
    rect(10, 10),
    color(255, 140, 200),
    area(),
    z(8),
    { damage: 25 },
  ]);
  const WORLD_W = 120 * TILE;
  const WORLD_H = 12 * TILE;
  hb.onUpdate(() => {
    hb.move(vx, vy); // move() é por segundo no kaplay
    if (
      hb.pos.x < -40 ||
      hb.pos.x > WORLD_W + 40 ||
      hb.pos.y < -40 ||
      hb.pos.y > WORLD_H + 40
    ) {
      destroy(hb);
    }
  });
  wait(shot.lifetime, () => {
    if (hb.exists()) destroy(hb);
  });
}

// hostile × player — projétil do atirador: mesmo dano e morte do contato.
onCollide("hostile", "player", (hb) => {
  hurtLocalPlayer(hb.damage);
  destroy(hb);
});

// hostile × solid — impacto de tiro + destrói o projétil.
onCollide("hostile", "solid", (hb) => {
  particles.spawnShootImpact(hb.pos.x, hb.pos.y);
  destroy(hb);
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
      // PlayerState não carrega id no wire — o welcome inclui o PRÓPRIO
      // jogador sem id; pular entradas sem id evita linha fantasma
      // ("Jogador" com id undefined) no painel do HUD.
      if (!np.id || np.id === server.myId()) continue;
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
  // Fase da run: abre/fecha a loja e reconstrói o mundo quando o servidor
  // broadcasta o próximo mapa (todos prontos).
  onPhase: (state) => {
    phaseState = state;
    if (state.phase === "shop") {
      // Loja aberta: overlay visível com saldo/catálogo/prontos.
      shop.update(state, server.myId());
      return;
    }
    // phase=playing: esconde a loja; mapa novo → reconstrói o mundo com o
    // teto de vida efetivo (upgrades de max_hp comprados na loja).
    shop.update(state, server.myId());
    if (state.number !== currentLevelNumber) {
      const mine = state.players.find((p) => p.id === server.myId());
      currentLevelNumber = state.number;
      buildWorld(state.number, mine?.stats.maxHp ?? playerMaxHp);
    }
  },
  // Moedas do servidor (estado completo + remoções + contadores por jogador):
  // o primeiro broadcast assume a autoridade — as moedas locais da fase
  // inicial (geradas antes da conexão) são descartadas e a renderização passa
  // a espelhar exatamente o que o servidor manda. Remoções são aplicadas
  // ANTES do estado completo para o efeito de coleta não se perder quando a
  // moeda coletada já saiu do estado restante no mesmo broadcast.
  onCoins: ({ coins, removed, counts }) => {
    if (!serverCoins) {
      serverCoins = true;
      coinLayer.clear();
    }
    if (removed.length > 0) coinLayer.applyRemoved(removed);
    coinLayer.applyFull(coins);
    coinCounts = counts;
  },
  // Resposta individual de compra: comprovante atualiza a tela na hora;
  // erro (moedas insuficientes, nível máximo) aparece na loja.
  onShopBuyResult: (rc) => {
    if ("ok" in rc) {
      shop.showError(rc.error);
      return;
    }
    shop.applyBuyResult(rc);
  },
  // Erro de pronto (ex.: fora da loja) — mostra na tela e deixa tentar de novo.
  onShopReadyError: (err) => shop.showError(err),
  // Boss da fase (fases múltiplas de 5): espelha posição/estado/HP do
  // servidor — o bloco aparece/some conforme o broadcast (null esconde).
  onBoss: (state) => bossLayer.apply(state),
  // Power-ups do servidor (estado completo + remoções + efeitos por jogador):
  // o primeiro broadcast assume a autoridade (camada local/antiga descartada)
  // e a renderização passa a espelhar exatamente o que o servidor manda.
  // Remoções são aplicadas ANTES do estado completo para o efeito de coleta
  // não se perder quando o power-up coletado já saiu do estado restante no
  // mesmo broadcast. Os efeitos alimentam o HUD, o tiro triplo e a bolha de
  // escudo — o client só REFLETE o que o servidor decidiu.
  onPowerUps: ({ powerUps, removed, effects }) => {
    if (removed.length > 0) powerUpLayer.applyRemoved(removed);
    powerUpLayer.applyFull(powerUps);
    powerUpEffects = effects;
    // Efeito VIDA no jogador local: o servidor elevou o HP acima do teto
    // (BoostHPAboveMax — 100 → 125). O client espelha o estado autoritativo
    // (max() evita "curar" — só sobe quando o servidor diz que o bônus existe).
    const mine = effects[server.myId()];
    if (mine && mine.vida > 0) {
      player.hp = Math.max(player.hp, playerMaxHp + mine.vida);
    }
  },
});

// ===== Controles (input adaptativo: teclado + touch) =====
// O input.ts é a camada única de entrada e NÃO desenha nada: no desktop,
// setas/A/D movem, espaço pula e J atira; no touch, zonas virtuais nos cantos
// inferiores (◀ ▶ à esquerda, PULO/TIRO à direita) são hit-testadas nos
// eventos de toque. Aqui instanciamos os botões touch como elementos Kaplay
// fixos na tela e consumimos o estado digital por frame (poll) — pulo/tiro
// disparam uma única vez por gesto (borda limpa pelo poll), sem repetição
// contínua enquanto tecla/zona é segurada.
// Na loja (phase="shop") o mundo está pausado no servidor: ignora input.
const input = createInput(k, {
  onModeChange: (mode) => setTouchButtonsVisible(mode === "touch"),
});

// Botões touch: elementos decorativos (fixed + z alto) — o hit-test é feito
// pelo input.ts sobre as zonas, independente dos visuais. Ficam atrás do
// overlay DOM do HUD (z-index 20, cobre o canvas inteiro), então nunca
// escondem vidas/placar/energia; a posição casa com o centro das zonas.
// Fundo sólido (sem alpha: no kaplay 3001 cor não tem canal a, e opacity do
// pai seria multiplicada nos filhos — o texto ficaria transparente junto).
const TOUCH_BTN_Z = 50;
const touchButtons = computeButtonSpecs(input.getZones()).map((spec) => {
  const btn = add([
    "touch-btn",
    fixed(),
    pos(spec.x - spec.size / 2, spec.y - spec.size / 2),
    rect(spec.size, spec.size, { radius: spec.size * 0.22 }),
    color(36, 40, 64),
    outline(2, rgb(200, 208, 224)),
    z(TOUCH_BTN_Z),
  ]);
  btn.add([
    text(spec.label, { size: Math.max(14, Math.round(spec.size * 0.38)) }),
    pos(spec.size / 2, spec.size / 2),
    anchor("center"),
    color(255, 255, 255),
  ]);
  btn.hidden = true; // só aparecem no modo touch
  return btn;
});

function setTouchButtonsVisible(visible: boolean): void {
  for (const btn of touchButtons) btn.hidden = !visible;
}

// Re-posiciona os botões conforme as zonas atuais (safe-area muda na rotação;
// as zonas vivem em coordenadas de jogo, constantes sob resize).
function refreshTouchButtons(): void {
  const specs = computeButtonSpecs(input.getZones());
  // Guarda de robustez: specs e botões vêm da mesma fonte (4 zonas fixas),
  // mas nunca indexar fora do array se o layout mudar.
  if (specs.length !== touchButtons.length) return;
  for (let i = 0; i < touchButtons.length; i++) {
    const s = specs[i];
    touchButtons[i].pos = vec2(s.x - s.size / 2, s.y - s.size / 2);
  }
}

// Modo inicial já decidido pelo input (k.isTouchscreen()); o onModeChange
// acima ajusta a visibilidade quando o primeiro input real travar um modo.
setTouchButtonsVisible(input.isTouchMode());
refreshTouchButtons();

// ===== Câmera segue o jogador + HUD a cada frame =====
// O estado do HUD é montado do estado real do jogo e passado para o módulo
// hud.ts, que renderiza o overlay. A fase exibida vem do broadcast da run.
function buildHudState(): HudState {
  const players: HudPlayer[] = [];
  const cam = k.getCamPos();

  if (player.exists()) {
    // Respawn local: o servidor revive após 3s (DefaultRespawnTicks) — o
    // painel do HUD mostra a contagem regressiva enquanto morto.
    const now = performance.now();
    if (localDead) {
      if (localDeadSince === 0) localDeadSince = now;
    } else {
      localDeadSince = 0;
    }
    players.push({
      id: server.myId() || "local",
      name: "Você",
      color: "rgb(66, 200, 245)",
      hp: player.hp,
      maxHp: playerMaxHp,
      x: player.pos.x,
      y: player.pos.y,
      respawning: localDead,
      respawnIn: localDead ? Math.max(0, 3 - (now - localDeadSince) / 1000) : undefined,
      // Badge de moedas do jogador local (multiplayer): contador DA FASE
      // vindo do broadcast do servidor. Offline o contador é o teamCoins
      // (canto superior direito) — sem badge aqui.
      coins: serverCoins ? (coinCounts[server.myId()] ?? 0) : undefined,
      // Efeitos ativos de power-up (multiplayer): badges do HUD (❤️+25 /
      // 🔱10s / 🛡️) + HP acima do teto — espelho do broadcast do servidor.
      // Offline não há efeitos (o client nunca se concede power-ups).
      effects: powerUpEffects[server.myId()],
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
      coins: serverCoins ? (coinCounts[np.id] ?? 0) : undefined,
      // Efeitos ativos do jogador remoto (broadcast powerUpEffects) — os
      // badges de poder do companheiro aparecem no painel dele.
      effects: powerUpEffects[np.id],
    });
  }

  // Boss da fase (fases múltiplas de 5): a barra do HUD aparece quando o
    // servidor broadcasta um boss ativo e some quando ele é derrotado
    // (broadcast null → hp()/maxHp() voltam a null → boss undefined). O
    // estado/phase alimentam o rótulo e a cor da barra. hp/maxHp são lidos
    // uma vez (a cada frame) — a guarda usa os MESMOS valores do objeto.
    const bossHp = bossLayer.hp();
    const bossMaxHp = bossLayer.maxHp();
    const boss = bossHp !== null && bossMaxHp !== null
      ? {
          hp: bossHp,
          maxHp: bossMaxHp,
          phase: bossLayer.phase() ?? undefined,
          state: bossLayer.state() ?? undefined,
        }
      : undefined;
    return {
      players,
      localPlayerId: server.myId() || "local",
      camera: { x: cam.x, y: cam.y, width: k.width(), height: k.height() },
      // Multiplayer: total exibido = contador DA FASE do jogador local
      // (servidor é autoritativo; não existe carteira de time). Offline: o
      // contador local do singleplayer.
      teamCoins: serverCoins ? (coinCounts[server.myId()] ?? 0) : teamCoins,
      // Sem servidor (singleplayer local offline), a fase exibida é a local
      // (currentLevelNumber) — o broadcast da run é quem manda no multiplayer.
      phase: phaseState ? `Fase ${phaseState.number}` : `Fase ${currentLevelNumber}`,
      status: localDead ? formatDeathMessage() : undefined,
      boss,
    };
  }

// ===== Loop: input por frame + poeira de aterrissagem + câmera + HUD =====
// O input é consumido via poll() UMA vez por frame: o snapshot traz a
// direção (segurar = mover contínuo) e bordas de pulo/tiro (disparam 1x por
// gesto; o próprio poll limpa as bordas, então segurar não re-dispara).
//
// A loja (overlay DOM .shop-root criado por shop.ts) pausa o mundo no
// servidor; durante ela o input local é ignorado para o jogador não se mover
// "sozinho" atrás do overlay. Antes da loja existir no DOM (.shop-root
// ausente) a consulta retorna false — o jogo roda só na fase 1.
function shopOpen(): boolean {
  const el = document.querySelector<HTMLElement>(".shop-root");
  return !!el && el.style.display !== "none";
}

let wasGrounded = true;
// Marco do último tiro (performance.now) — o cooldown local de tiro offline
// (fire_rate da loja) é validado contra ele; online o servidor é quem valida.
let lastShotAt = 0;
onUpdate(() => {
  const frame = input.poll();

  // Consome o estado apenas fora da loja (mundo pausado no servidor; na loja
  // local offline o mundo também está pausado e o overlay bloqueia o input).
  if (!shopOpen() && player.exists()) {
    player.movePlayer(frame.direction);
    if (frame.jumpPressed) {
      if (player.isGrounded()) {
        playJump();
        particles.spawnDust(player.pos.x, player.pos.y + 20, 90);
      }
      player.jumpPlayer();
    }
    // Cooldown de tiro: online o servidor valida (150ms / fire_rate) e cria o
    // projétil autoritativo — o client envia a intenção sem throttle. Offline
    // o client aplica o MESMO cooldown do servidor (fireCooldownMs) para o
    // upgrade de cadência da loja ter efeito real na cadência local.
    const cooldownOk = phaseState
      ? true
      : performance.now() - lastShotAt >= fireCooldownMs(localStats.fireRate);
    if (frame.shootPressed && cooldownOk) {
      if (!phaseState) lastShotAt = performance.now();
      playShoot();
      particles.spawnShootImpact(
        player.pos.x + player.facing * 24,
        player.pos.y - 10
      );
      // Tiro triplo (power-up): o servidor decide (TripleShotActive no OnShoot
      // — 3 projéteis com lanes -6/0/+6) e o client espelha o MESMO padrão
      // visual quando o efeito está ativo no broadcast. Sem o efeito (ou
      // offline), tiro simples.
      if ((powerUpEffects[server.myId()]?.tripleShot ?? 0) > 0) {
        player.shootTriple();
      } else {
        player.shoot();
      }
      // Servidor autoritativo: ele valida o cooldown (fire_rate) e cria o
      // projétil que causa dano a inimigos e ao boss (HitBoss) — o client
      // só envia a intenção e renderiza o estado broadcastado.
      server.sendShoot();
    }
  }

  // Fim do mapa → loja entre fases (singleplayer local, offline): a borda
  // direita do player cruzou a primeira coluna do fim (isLevelFinished
  // espelha o Level.Finished do servidor Go). Preserva as moedas da fase no
  // caixa individual ANTES de abrir a loja, pausa o mundo e mostra o overlay
  // — o jogador gasta o caixa em upgrades (max_hp/fire_rate/shield) e
  // confirma 'pronto' para avançar (advanceOfflinePhase reconstrói o mapa
  // seguinte com as stats novas). Só dispara com o player vivo, fora de
  // transição e sem broadcast de fase do servidor — em multiplayer o
  // servidor é dono da máquina de fases (onPhase).
  if (
    !transitioning &&
    !localDead &&
    player.exists() &&
    player.hp > 0 &&
    !phaseState &&
    isLevelFinished(120, player.pos.x)
  ) {
    transitioning = true;
    playPowerUp();
    particles.spawnCoinCollect(player.pos.x, player.pos.y);
    coinWallet += teamCoins;
    setWorldPaused(true);
    openLocalShop();
  }

  const grounded = player.exists() && player.isGrounded();
  if (grounded && !wasGrounded) {
    particles.spawnDust(player.pos.x, player.pos.y + 20);
  }
  wasGrounded = grounded;

  // Bolha de escudo: online segue o player enquanto o ESCUDO (power-up)
  // estiver ativo no broadcast de efeitos — some sozinha quando o servidor
  // consome a carga. Offline (singleplayer local) a bolha espelha a carga do
  // upgrade da loja (localStats.shield) e some quando hurtLocalPlayer a
  // consome. O client apenas reflete, nunca decide.
  const shieldActive = phaseState
    ? (powerUpEffects[server.myId()]?.shield ?? 0) > 0
    : localStats.shield > 0;
  shieldBubble.hidden = !shieldActive;
  if (shieldActive) {
    shieldBubble.pos = vec2(player.pos.x - 3, player.pos.y - 3);
  }

  if (player.exists()) k.setCamPos(vec2(player.pos.x, 360));
  hud.update(buildHudState());
});
