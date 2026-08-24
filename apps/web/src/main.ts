import kaplay from "kaplay";
import { createPlayer } from "./player";
import { generateLevel } from "./levelgen";
import { connectToServer, type NetPhaseState, type NetPlayer, type NetStatus } from "./net";
import { createCoinLayer } from "./coins";
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
import { createShop } from "./shop";
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
import { startSolo, type SoloSession } from "./solo";
import { createMenu, type MenuChoice } from "./menu";

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

// ===== Power-ups =====
// A powerUpLayer é a ÚNICA criadora/destruidora de power-ups renderizados
// (tag "powerup"): no multiplayer ela espelha o estado autoritativo do
// servidor (WorldMsg `powerUps` / PowerUpsMsg `removed`); no singleplayer o
// motor solo (solo.ts) a alimenta com os power-ups determinísticos da fase e
// o onCollect dispara o feedback de coleta (som + partículas).
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

// ===== Boss =====
// Camada única de renderização do boss. No multiplayer ela espelha o estado
// autoritativo do servidor (WorldMsg `boss`); no singleplayer o motor solo a
// alimenta com o boss simulado local (fases múltiplas de 5). Expõe
// hp()/maxHp()/state() para a barra do HUD.
const bossLayer = createBossLayer(k);
// DEBUG — expõe a camada para o smoke test e2e (mesmo padrão das moedas).
(window as unknown as Record<string, unknown>).__dbgBoss = bossLayer;

// ===== Indicador de status da conexão (net lifecycle) =====
// Overlay DOM discreto que reflete o estado do WebSocket: connecting / open /
// reconnecting / closed. Criado uma vez e atualizado pelo onStatus do
// connectToServer. Não bloqueia o canvas nem o input (pointer-events: none).
const netStatusEl = document.createElement("div");
netStatusEl.className = "net-status";
netStatusEl.style.cssText =
  "position:fixed;top:10px;left:10px;z-index:40;font:600 11px/1.2 monospace;" +
  "padding:3px 8px;border-radius:4px;color:#fff;background:rgba(18,18,30,0.72);" +
  "border:1px solid rgba(255,255,255,0.25);pointer-events:none;user-select:none;";
netStatusEl.hidden = true;
document.body.appendChild(netStatusEl);
const NET_STATUS_LABEL: Record<NetStatus, string> = {
  connecting: "🟡 conectando…",
  open: "🟢 online",
  reconnecting: "🟠 reconectando…",
  closed: "⚪ offline",
};
const NET_STATUS_BORDER: Record<NetStatus, string> = {
  connecting: "rgba(245,197,66,0.7)",
  open: "rgba(90,208,106,0.7)",
  reconnecting: "rgba(245,167,66,0.7)",
  closed: "rgba(160,170,180,0.5)",
};
function setNetStatus(status: NetStatus): void {
  netStatusEl.textContent = NET_STATUS_LABEL[status];
  netStatusEl.style.borderColor = NET_STATUS_BORDER[status];
  netStatusEl.hidden = false;
}

// ===== Player =====
// Nascido com o spawn da fase 1 (o mundo é construído logo abaixo); entre
// fases o buildWorld (do motor solo ou do servidor) apenas o reposiciona — a
// referência nunca muda. O motor solo (solo.ts) é dono do player OFFLINE; no
// multiplayer o servidor é quem decide posição/vida e o client espelha.
let player = createPlayer(k, {
  pos: generateLevel(k, { width: 120, height: 12, seed: 1 }).playerSpawn,
  maxHp: MAX_HP,
});
player.onDestroy(() => {
  // O player nunca é destruído em runtime (buildWorld o reposiciona); se for,
  // o motor solo/loop de HUD tratam a ausência com guards.
});

// ===== Fase da run (multiplayer) =====
// O servidor é autoritativo: broadcasta phase="shop" ao fim de cada mapa e
// phase="playing" (número novo) quando TODOS confirmaram 'pronto'. Aqui
// guardamos o último estado recebido para renderizar a loja e reconstruir o
// mundo no avanço de fase. Offline o número vive no solo.run.phase.
let phaseState: NetPhaseState | null = null;
let currentLevelNumber = 1;
// Teto de vida efetivo do jogador local (100 base + upgrades de max_hp).
let playerMaxHp = MAX_HP;

// ===== Input adaptativo (teclado + touch) =====
// O input.ts é a camada única de entrada e NÃO desenha nada: no desktop,
// setas/A/D movem, espaço pula e J atira; no touch, zonas virtuais nos cantos
// inferiores (◀ ▶ à esquerda, PULO/TIRO à direita) são hit-testadas nos
// eventos de toque. O startSolo consome o estado por frame (poll); aqui
// instanciamos e usamos para os botões touch (visuais) e modo inicial.
const input = createInput(k, {
  onModeChange: (mode) => setTouchButtonsVisible(mode === "touch"),
});

// ===== Loja entre fases (overlay) =====
// Aparece quando a loja abre — no multiplayer quando o servidor broadcasta
// phase="shop"; no singleplayer local (offline) quando o motor solo cruza o
// fim do mapa. Comprar dispara shop_buy (servidor) ou a compra local (solo);
// confirmar dispara shop_ready (servidor) ou avança a fase local (solo).
const shop = createShop({
  onBuy: (upgrade) => {
    if (phaseState && server) {
      // Multiplayer: o servidor valida, debita e responde shop_buy_result.
      server.sendShopBuy(upgrade);
      return;
    }
    // Singleplayer local (offline): o motor solo valida/debita/aplica.
    solo.buy(upgrade);
  },
  onReady: () => {
    if (phaseState && server) {
      server.sendShopReady();
      return;
    }
    solo.confirmReady();
  },
});

// ===== Motor solo (singleplayer local — offline) =====
// O startSolo registra TODO o ciclo de vida offline: construção do mundo
// (tiles/inimigos/moedas/power-ups/boss), loop de update (input → player,
// boss, efeitos, fim de fase → loja), colisões locais, pausa e loja local.
// Quando o servidor conecta, main.ts chama solo.setServerDriven(true) no
// primeiro broadcast e o motor fica inerte (guards internos).
const solo: SoloSession = startSolo({
  k,
  player,
  coinLayer,
  powerUpLayer,
  bossLayer,
  shop,
  input,
  particles,
  audio: {
    playCoin,
    playDamage,
    playDeath,
    playJump,
    playPowerUp,
    playShoot,
    playUI,
  },
});

// ===== Multiplayer (WebSocket) — iniciado sob demanda pelo menu =====
// No modo Solo NENHUM WebSocket é aberto (o jogo roda 100% no client). Só
// quando o jogador escolhe "Multijogador" no menu o connectToServer é
// instanciado e o loop de conexão/reconexão começa.
const netPlayers: NetPlayer[] = [];
type NetClient = ReturnType<typeof connectToServer>;
let server: NetClient | null = null;

function startMultiplayer(): void {
  if (server) return; // já conectado (idempotente)
  const net = connectToServer(k, {
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
        if (!np.id || np.id === net.myId()) continue;
        netPlayers.push(np);
      }
    },
    onPlayerJoin: (np) => {
      if (np.id !== net.myId() && !netPlayers.find((p) => p.id === np.id)) {
        netPlayers.push(np);
      }
    },
    onPlayerLeave: (id) => {
      const i = netPlayers.findIndex((p) => p.id === id);
      if (i >= 0) {
        netPlayers.splice(i, 1);
      }
    },
    // Estado da conexão → indicador visual (net lifecycle).
    onStatus: setNetStatus,
    // Fase da run: abre/fecha a loja e reconstrói o mundo quando o servidor
    // broadcasta o próximo mapa (todos prontos). O primeiro broadcast de fase
    // também desliga o motor solo (setServerDriven(true)) — o servidor assume.
    onPhase: (state) => {
      phaseState = state;
      solo.setServerDriven(true);
      if (state.phase === "shop") {
        // Loja aberta: overlay visível com saldo/catálogo/prontos.
        shop.update(state, net.myId());
        return;
      }
      // phase=playing: esconde a loja; mapa novo → reconstrói o mundo com o
      // teto de vida efetivo (upgrades de max_hp comprados na loja).
      shop.update(state, net.myId());
      if (state.number !== currentLevelNumber) {
        const mine = state.players.find((p) => p.id === net.myId());
        currentLevelNumber = state.number;
        playerMaxHp = mine?.stats.maxHp ?? playerMaxHp;
        solo.buildWorld(state.number, playerMaxHp);
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
        solo.setServerDriven(true);
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
    onBoss: (state) => {
      solo.setServerDriven(true);
      bossLayer.apply(state);
    },
    // Power-ups do servidor (estado completo + remoções + efeitos por jogador):
    // o primeiro broadcast assume a autoridade (camada local/antiga descartada)
    // e a renderização passa a espelhar exatamente o que o servidor manda.
    // Remoções são aplicadas ANTES do estado completo para o efeito de coleta
    // não se perder quando o power-up coletado já saiu do estado restante no
    // mesmo broadcast. Os efeitos alimentam o HUD, o tiro triplo e a bolha de
    // escudo — o client só REFLETE o que o servidor decidiu.
    onPowerUps: ({ powerUps, removed, effects }) => {
      solo.setServerDriven(true);
      if (removed.length > 0) powerUpLayer.applyRemoved(removed);
      powerUpLayer.applyFull(powerUps);
      powerUpEffects = effects;
      // Efeito VIDA no jogador local: o servidor elevou o HP acima do teto
      // (BoostHPAboveMax — 100 → 125). O client espelha o estado autoritativo
      // (max() evita "curar" — só sobe quando o servidor diz que o bônus existe).
      const mine = effects[net.myId()];
      if (mine && mine.vida > 0) {
        player.hp = Math.max(player.hp, playerMaxHp + mine.vida);
      }
    },
  });
  server = net;

  // Desconecta o WebSocket ao sair/recarregar a página (net lifecycle): fecha
  // o socket e interrompe o loop de reconexão — sem vazamento nem tentativas
  // infinitas em segundo plano. pagehide cobre mobile (browser pode não
  // disparar beforeunload de forma confiável).
  const disconnect = () => net.disconnect();
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("beforeunload", disconnect);
}

// ===== Menu inicial (roteamento Solo / Multijogador) =====
// O jogo abre com o menu na frente (mundo solo pausado atrás). Escolher
// "Solo" destrava o motor solo (sem WebSocket, sem API — 100% offline);
// escolher "Multijogador" instancia o client WebSocket (startMultiplayer) e o
// servidor assume via setServerDriven.
solo.pause(); // mundo congela atrás do overlay do menu
const menu = createMenu({
  onSelect: (choice) => {
    menu.hide();
    solo.resume();
    if (choice === "multiplayer") {
      startMultiplayer();
    }
  },
});

// Guarda de HUD: o id do jogador local (multiplayer) ou "local" (solo).
function localPlayerId(): string {
  return server?.myId() || "local";
}

// ===== Loop de input MULTIPLAYER (servidor autoritativo) =====
// Offline quem consome o input é o motor solo (startSolo — o loop dele
// retorna cedo quando serverDriven). Aqui o loop só assume quando o servidor
// já tomou conta do mundo (primeiro broadcast de moedas — serverCoins): os
// guards são mutuamente exclusivos, então input.poll() nunca é consumido
// duas vezes no mesmo frame. Movimento e pulo são client-side (o net.ts
// envia a posição ~10x/s via sendState); o tiro é INTENÇÃO — o servidor
// valida o cooldown (fire_rate da loja) e cria o projétil autoritativo
// (sendShoot). O visual do tiro local espelha o tiro triplo do broadcast de
// efeitos (powerUpEffects) — mesmo padrão do main.ts pré-solo.
let mpWasGrounded = true;
onUpdate(() => {
  if (!serverCoins || !server) return;

  const frame = input.poll();
  if (!shopOpen() && player.exists()) {
    player.movePlayer(frame.direction);
    if (frame.jumpPressed) {
      if (player.isGrounded()) {
        playJump();
        particles.spawnDust(player.pos.x, player.pos.y + 20, 90);
      }
      player.jumpPlayer();
    }
    if (frame.shootPressed) {
      playShoot();
      particles.spawnShootImpact(player.pos.x + player.facing * 24, player.pos.y - 10);
      if ((powerUpEffects[server.myId()]?.tripleShot ?? 0) > 0) {
        player.shootTriple();
      } else {
        player.shoot();
      }
      // Servidor autoritativo: valida o cooldown (fire_rate) e cria o projétil
      // que causa dano a inimigos/boss — o client só envia a intenção.
      server.sendShoot();
    }
  }

  const grounded = player.exists() && player.isGrounded();
  if (grounded && !mpWasGrounded) {
    particles.spawnDust(player.pos.x, player.pos.y + 20);
  }
  mpWasGrounded = grounded;
});

// Loja aberta (overlay DOM .shop-root)? Durante ela o mundo está pausado no
// servidor — o input local é ignorado para o jogador não se mover atrás do
// overlay (mesma guarda do main.ts antigo).
function shopOpen(): boolean {
  const el = document.querySelector<HTMLElement>(".shop-root");
  return !!el && el.style.display !== "none";
}

// ===== Botões touch: visibilidade =====
// O input adaptativo (teclado + touch) é criado acima e passado ao startSolo;
// aqui apenas instanciamos os botões touch (visuais) e refletimos o modo.
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
// (no startSolo) ajusta a visibilidade quando o primeiro input real travar.
setTouchButtonsVisible(input.isTouchMode());
refreshTouchButtons();

// ===== DEBUG hooks (smoke test e2e) =====
// Estado ao vivo para o smoke test — mesmo padrão do __dbgBoss/__dbgCoins.
// Offline lê do motor solo; online do espelho do servidor.
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
    return {
      teamCoins: solo.run.teamCoins,
      serverCoins,
      active: coinLayer.size(),
      phase: currentLevelNumber,
    };
  },
  get enemies() {
    return k.get("enemy").map((e) => ({ x: e.pos.x, y: e.pos.y, hp: e.hp }));
  },
  // DEBUG (temporário — smoke test e2e): power-ups da fase (posições/tipos).
  get powerUps() {
    return solo.getPowerUps().map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y }));
  },
  get bullets() {
    return k.get("bullet").map((b) => ({ x: b.pos.x, y: b.pos.y, vel: b.vel }));
  },
  // DEBUG — stats da run e caixa individual (loja offline) para o smoke test.
  get runStats() {
    return solo.run.stats;
  },
  get wallet() {
    return solo.run.wallet;
  },
  get phase() {
    return solo.run.phase;
  },
  hurt: (n: number) => solo.damagePlayer(n),
  dropAt: (x: number, y: number, count?: number) => solo.dropAt(x, y, count),
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

// ===== Câmera segue o jogador + HUD a cada frame =====
// O estado do HUD é montado do estado real do jogo e passado para o módulo
// hud.ts, que renderiza o overlay. Offline lê do motor solo; online do
// broadcast do servidor.
function buildHudState(): HudState {
  const players: HudPlayer[] = [];
  const cam = k.getCamPos();

  if (player.exists()) {
    // Respawn local: o servidor revive após 3s (DefaultRespawnTicks) — o
    // painel do HUD mostra a contagem regressiva enquanto morto. Offline o
    // motor solo agenda o rebuild da fase (mesma contagem).
    const now = performance.now();
    const dead = solo.run.dead;
    if (dead) {
      if (localDeadSince === 0) localDeadSince = now;
    } else {
      localDeadSince = 0;
    }
    players.push({
      id: localPlayerId(),
      name: "Você",
      color: "rgb(66, 200, 245)",
      hp: player.hp,
      // Teto efetivo: no multiplayer vem do broadcast (upgrades max_hp da
      // loja aplicados pelo servidor); offline do motor solo (run.stats).
      maxHp: serverCoins ? playerMaxHp : solo.run.stats.maxHp,
      x: player.pos.x,
      y: player.pos.y,
      respawning: dead,
      respawnIn: dead ? Math.max(0, 3 - (now - localDeadSince) / 1000) : undefined,
      // Badge de moedas do jogador local (multiplayer): contador DA FASE
      // vindo do broadcast do servidor. Offline o contador é o do motor solo
      // (solo.run.teamCoins, canto superior direito) — sem badge aqui.
      coins: serverCoins ? (coinCounts[localPlayerId()] ?? 0) : undefined,
      // Efeitos ativos de power-up: badges do HUD (❤️+25 / 🔱10s / 🛡️) + HP
      // acima do teto. Online é espelho do broadcast; offline o motor solo
      // decide (power-ups determinísticos da fase).
      effects: serverCoins ? powerUpEffects[localPlayerId()] : solo.getEffects(),
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

  // Boss da fase: barra do HUD quando há boss ativo. Online vem do broadcast
  // (bossLayer.hp()); offline do motor solo (solo.getBoss()).
  let boss: HudState["boss"];
  if (serverCoins) {
    const bossHp = bossLayer.hp();
    const bossMaxHp = bossLayer.maxHp();
    boss = bossHp !== null && bossMaxHp !== null
      ? {
          hp: bossHp,
          maxHp: bossMaxHp,
          phase: bossLayer.phase() ?? undefined,
          state: bossLayer.state() ?? undefined,
        }
      : undefined;
  } else {
    const b = solo.getBoss();
    boss = b
      ? { hp: b.hp, maxHp: b.maxHp, phase: b.phase ?? undefined, state: b.state ?? undefined }
      : undefined;
  }

  return {
    players,
    localPlayerId: localPlayerId(),
    camera: { x: cam.x, y: cam.y, width: k.width(), height: k.height() },
    // Multiplayer: total exibido = contador DA FASE do jogador local
    // (servidor é autoritativo; não existe carteira de time). Offline: o
    // contador local do singleplayer (solo.run.teamCoins).
    teamCoins: serverCoins ? (coinCounts[localPlayerId()] ?? 0) : solo.run.teamCoins,
    // Sem servidor (singleplayer local offline), a fase exibida é a local
    // (solo.run.phase) — o broadcast da run é quem manda no multiplayer.
    phase: phaseState ? `Fase ${phaseState.number}` : `Fase ${solo.run.phase}`,
    status: solo.run.dead ? formatDeathMessage() : undefined,
    boss,
  };
}

let localDeadSince = 0;

// ===== Loop principal: bolha de escudo + câmera + HUD =====
// O input offline é consumido pelo loop interno do motor solo (startSolo);
// aqui o main.ts cuida apenas do que é global: bolha de escudo (efeito ativo
// online ou offline), câmera seguindo o player e HUD a cada frame.
onUpdate(() => {
  // Bolha de escudo: online segue o player enquanto o ESCUDO (power-up)
  // estiver ativo no broadcast de efeitos — some sozinha quando o servidor
  // consome a carga. Offline a bolha espelha a carga do efeito do motor solo
  // (solo.getEffects().shield) e some quando damagePlayer a consome.
  const effects = serverCoins ? powerUpEffects[localPlayerId()] : solo.getEffects();
  const shieldActive = (effects?.shield ?? 0) > 0;
  shieldBubble.hidden = !shieldActive;
  if (shieldActive && player.exists()) {
    shieldBubble.pos = vec2(player.pos.x - 3, player.pos.y - 3);
  }

  if (player.exists()) k.setCamPos(vec2(player.pos.x, 360));
  hud.update(buildHudState());
});

// ===== Bolha de escudo do jogador local (poder visual) =====
// Anel azul ao redor do player enquanto o ESCUDO (power-up/loja) estiver
// ativo. Nasce oculto; o onUpdate mostra/esconde conforme o efeito ativo
// (online: broadcast do servidor; offline: motor solo).
const shieldBubble = add([
  "shield-bubble",
  pos(0, 0),
  rect(34, 46, { fill: false, radius: 8 }),
  outline(2, rgb(120, 200, 255)),
  z(9),
]);
shieldBubble.hidden = true;
