/**
 * audio.ts — SFX e música 100% sintetizados via Web Audio API.
 *
 * Zero assets externos: todos os sons são gerados em tempo real com
 * osciladores (OscillatorNode) + envelopes de ganho/frequência (GainNode),
 * sem nenhum arquivo de áudio importado.
 *
 * API pública (funções de módulo):
 *   playJump / playShoot / playCoin / playPowerUp / playDamage / playDeath
 *   playBoss / playUI / playShop   — efeitos curtos de um disparo
 *   startMusic() / stopMusic()     — loop procedural leve (acordes/pad)
 *   setMuted(muted) / isMuted()    — mute global (master gain)
 *   resumeAudio()                  — reanima o AudioContext (gesto do usuário)
 *   setAudioContextFactory(fn)     — hook de teste/injeção (opcional)
 *
 * O AudioContext é criado de forma LAZY (no primeiro uso) e é retomado
 * automaticamente se estiver suspenso (política de autoplay do navegador).
 * Em ambientes sem Web Audio (SSR/Node sem mock), os play* são no-ops
 * silenciosos — o jogo nunca quebra por falta de áudio.
 */

// ===== Estado do módulo =====

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

/** Hook de teste/injeção: substitui o construtor do AudioContext. */
let ctxFactory: (() => AudioContext) | null = null;

// Estado da música (loop procedural).
let musicOn = false;
let musicTimer: number | null = null;
let musicChordIndex = 0;
let musicScheduledUntil = 0;
/** Nós vivos da música (para stopMusic conseguir cortar o que ainda não tocou). */
const musicNodes = new Set<OscillatorNode>();

// ===== Setup do contexto =====

function createCtx(): AudioContext | null {
  if (ctxFactory) return ctxFactory();
  const AC =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AC ? new AC() : null;
}

/**
 * Retorna o contexto, criando-o no primeiro uso e retomando-o se suspenso.
 * Retorna null quando a Web Audio API não está disponível (no-op silencioso).
 */
function getCtx(): AudioContext | null {
  if (ctx === null) {
    const c = createCtx();
    if (!c) return null;
    ctx = c;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/**
 * Reanima o AudioContext. Chamar no primeiro gesto do usuário (pointerdown/
 * keydown) para a política de autoplay não deixar o contexto suspenso.
 * É seguro chamar várias vezes e antes de qualquer play*.
 */
export function resumeAudio(): void {
  getCtx();
}

/** Define (ou limpa) uma factory de AudioContext — hook de teste/injeção. */
export function setAudioContextFactory(factory: (() => AudioContext) | null): void {
  ctxFactory = factory;
  // Se já havia contexto, derruba tudo para a próxima chamada recriar limpo
  // com a nova factory (importante para isolamento entre testes).
  if (ctx !== null) {
    stopMusic();
    ctx.close?.().catch?.(() => {});
    ctx = null;
    master = null;
  }
}

// ===== Mute global =====

/** Aplica mute em todos os nós: o master gain é a raiz de todo o áudio. */
export function setMuted(m: boolean): void {
  muted = m;
  if (master) {
    master.gain.cancelScheduledValues(0);
    master.gain.value = m ? 0 : 1;
  }
}

export function isMuted(): boolean {
  return muted;
}

// ===== Helpers de síntese =====

interface ToneOpts {
  type: OscillatorType;
  /** Frequência inicial (Hz). */
  freq: number;
  /** Frequência final (Hz) — slide exponencial quando presente. */
  endFreq?: number;
  /** Deslocamento do início em segundos a partir de now (default 0). */
  delay?: number;
  /** Duração do corpo do som em segundos (default 0.12). */
  duration?: number;
  /** Volume de pico (0..1, default 0.25). */
  volume?: number;
  /** Tempo de ataque em segundos (default 0.005 — percussivo). */
  attack?: number;
  /** Tempo de release em segundos (default 0.05). */
  release?: number;
  /** Detune em cents (para sons "gordos" com osciladores duplicados). */
  detune?: number;
}

/**
 * Toca um tom curto: oscilador + envelope de ganho (attack/release) com
 * slide de frequência opcional. Tudo roteado para o master gain.
 */
function tone(o: ToneOpts): void {
  const c = getCtx();
  if (!c || !master) return;

  const now = c.currentTime;
  const t0 = now + (o.delay ?? 0);
  const dur = o.duration ?? 0.12;
  const vol = o.volume ?? 0.25;
  const atk = o.attack ?? 0.005;
  const rel = o.release ?? 0.05;
  const end = t0 + dur;

  const osc = c.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(Math.max(1, o.freq), t0);
  if (o.endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), end);
  }
  if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, end + rel);

  osc.connect(g);
  g.connect(master);

  const stopAt = end + rel + 0.05;
  osc.start(t0);
  osc.stop(stopAt);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

// ===== SFX (efeitos curtos) =====

/** Pulo: chirp ascendente curto e leve. */
export function playJump(): void {
  tone({ type: "sine", freq: 320, endFreq: 660, duration: 0.15, volume: 0.3 });
}

/** Tiro: "laser" descendente agudo. */
export function playShoot(): void {
  tone({ type: "sawtooth", freq: 950, endFreq: 300, duration: 0.09, volume: 0.2 });
}

/** Moeda: ding de dois tons (B5 → E6), clássico de coleta. */
export function playCoin(): void {
  tone({ type: "sine", freq: 987.77, duration: 0.08, volume: 0.25 });
  tone({ type: "sine", freq: 1318.51, duration: 0.18, volume: 0.25, delay: 0.07 });
}

/** Power-up: arpejo ascendente de 3 notas (C5–E5–G5). */
export function playPowerUp(): void {
  tone({ type: "triangle", freq: 523.25, duration: 0.12, volume: 0.22 });
  tone({ type: "triangle", freq: 659.25, duration: 0.12, volume: 0.22, delay: 0.09 });
  tone({ type: "triangle", freq: 783.99, duration: 0.2, volume: 0.22, delay: 0.18 });
}

/** Dano: impacto grave descendente. */
export function playDamage(): void {
  tone({ type: "sawtooth", freq: 220, endFreq: 90, duration: 0.18, volume: 0.3 });
}

/** Morte: deslize longo descendente + sub grave. */
export function playDeath(): void {
  tone({ type: "sawtooth", freq: 300, endFreq: 50, duration: 0.55, volume: 0.28 });
  tone({ type: "sine", freq: 110, endFreq: 40, duration: 0.5, volume: 0.25 });
}

/** Boss: par de saws detunados graves (sombrio e ameaçador). */
export function playBoss(): void {
  tone({ type: "sawtooth", freq: 55, duration: 0.9, volume: 0.28, attack: 0.15, detune: -8 });
  tone({ type: "sawtooth", freq: 55.5, duration: 0.9, volume: 0.28, attack: 0.15, detune: 8 });
  tone({ type: "sine", freq: 82.41, duration: 0.9, volume: 0.2, attack: 0.15 });
}

/** UI: blip seco e curto (menus, botões). */
export function playUI(): void {
  tone({ type: "sine", freq: 660, duration: 0.06, volume: 0.15 });
}

/** Loja: blip um pouco mais encorpado, tom "compra". */
export function playShop(): void {
  tone({ type: "triangle", freq: 520, endFreq: 780, duration: 0.12, volume: 0.18 });
}

// ===== Música procedural (loop de acordes/pad) =====

/** Progressão leve em Am (Am → F → C → G), notas como frequências em Hz. */
const PROGRESSION: number[][] = [
  [220.0, 261.63, 329.63], // Am: A3 C4 E4
  [174.61, 220.0, 261.63], // F:  F3 A3 C4
  [130.81, 164.81, 196.0], // C:  C3 E3 G3
  [196.0, 246.94, 293.66], // G:  G3 B3 D4
];

/** Um acorde dura 2s (matching com o enunciado: acordes a cada 2s). */
const CHORD_SECONDS = 2;
/** Janela de lookahead do scheduler (agenda com antecedência). */
const LOOKAHEAD_SECONDS = 4;
/** Tick do scheduler em ms — agenda os próximos acordes. */
const SCHEDULER_MS = 400;

/**
 * Toca um acorde "pad": cada nota é um oscilador triangle com envelope lento
 * (attack 0.35s), passando por um lowpass compartilhado para suavizar.
 * O oscilador fica registrado em musicNodes até terminar, para o stopMusic
 * conseguir cortar acordes já agendados mas ainda não tocados.
 */
function playChord(freqs: number[], t0: number): void {
  const c = ctx;
  if (!c || !master) return;

  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(900, t0);
  filter.Q.setValueAtTime(0.5, t0);
  filter.connect(master);

  const chordGain = c.createGain();
  chordGain.gain.setValueAtTime(0, t0);
  chordGain.gain.linearRampToValueAtTime(1, t0 + 0.35);
  chordGain.gain.exponentialRampToValueAtTime(0.0001, t0 + CHORD_SECONDS + 1.2);
  chordGain.connect(filter);

  const stopAt = t0 + CHORD_SECONDS + 1.3;
  for (const freq of freqs) {
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    osc.connect(chordGain);
    osc.start(t0);
    osc.stop(stopAt);
    musicNodes.add(osc);
    osc.onended = () => {
      musicNodes.delete(osc);
      osc.disconnect();
    };
  }
  // Limpeza do envelope/filtro após o acorde (não fica preso no graph).
  const msUntilEnd = Math.max(0, (stopAt - c.currentTime) * 1000 + 150);
  globalThis.setTimeout(() => {
    chordGain.disconnect();
    filter.disconnect();
  }, msUntilEnd);
}

/** Agenda todos os acordes necessários até o horizonte de lookahead. */
function scheduleMusic(): void {
  const c = ctx;
  if (!c || !musicOn) return;
  while (musicScheduledUntil < c.currentTime + LOOKAHEAD_SECONDS) {
    const t0 = Math.max(musicScheduledUntil, c.currentTime + 0.05);
    playChord(PROGRESSION[musicChordIndex % PROGRESSION.length], t0);
    musicChordIndex += 1;
    musicScheduledUntil = t0 + CHORD_SECONDS;
  }
}

/** Inicia o loop de música. Idempotente: chamadas extras não duplicam o loop. */
export function startMusic(): void {
  if (musicOn) return;
  if (!getCtx()) return; // sem Web Audio → no-op silencioso
  musicOn = true;
  musicChordIndex = 0;
  musicScheduledUntil = 0;
  scheduleMusic();
  musicTimer = globalThis.setInterval(scheduleMusic, SCHEDULER_MS);
}

/** Para o loop de música e corta todos os acordes (tocados ou agendados). */
export function stopMusic(): void {
  if (musicTimer !== null) {
    globalThis.clearInterval(musicTimer);
    musicTimer = null;
  }
  const c = ctx;
  for (const osc of musicNodes) {
    try {
      osc.stop(c ? c.currentTime : 0);
    } catch {
      // já parado — ignora
    }
    osc.disconnect();
  }
  musicNodes.clear();
  musicOn = false;
  musicChordIndex = 0;
  musicScheduledUntil = 0;
}
