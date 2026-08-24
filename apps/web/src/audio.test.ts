import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMuted,
  playBoss,
  playCoin,
  playDamage,
  playDeath,
  playJump,
  playPowerUp,
  playShoot,
  playShop,
  playUI,
  setAudioContextFactory,
  setMuted,
  startMusic,
  stopMusic,
} from "./audio";

// ===== Mock mínimo do Web Audio API =====
// O vitest roda em Node (sem AudioContext), então injetamos um mock via
// setAudioContextFactory. O mock rastreia nós criados, conexões e agendamentos
// para verificar que os play* realmente produzem/sinalizam áudio.

class MockParam {
  value = 0;
  events: Array<[string, number, number]> = [];
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.events.push(["set", v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.events.push(["lin", v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.events.push(["exp", v, t]);
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class MockOsc {
  type = "sine";
  frequency = new MockParam();
  detune = new MockParam();
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class MockGain {
  gain = new MockParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockFilter {
  type = "lowpass";
  frequency = new MockParam();
  Q = new MockParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockCtx {
  /** currentTime acompanha Date.now(), que o vi.useFakeTimers mocka. */
  private epoch = Date.now() / 1000;
  get currentTime(): number {
    return Date.now() / 1000 - this.epoch;
  }
  state: AudioContextState = "running";
  destination = { mock: "destination" };
  created: unknown[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createOscillator() {
    const o = new MockOsc();
    this.created.push(o);
    return o as unknown as OscillatorNode;
  }
  createGain() {
    const g = new MockGain();
    this.created.push(g);
    return g as unknown as GainNode;
  }
  createBiquadFilter() {
    const f = new MockFilter();
    this.created.push(f);
    return f as unknown as BiquadFilterNode;
  }
}

let mockCtx: MockCtx;

beforeEach(() => {
  mockCtx = new MockCtx();
  setAudioContextFactory(() => mockCtx as unknown as AudioContext);
  setMuted(false);
});

afterEach(() => {
  stopMusic();
  setAudioContextFactory(null);
});

function oscillators(): MockOsc[] {
  return mockCtx.created.filter((n) => n instanceof MockOsc) as MockOsc[];
}

function gains(): MockGain[] {
  return mockCtx.created.filter((n) => n instanceof MockGain) as MockGain[];
}

describe("SFX (play*)", () => {
  it.each([
    ["playJump", playJump],
    ["playShoot", playShoot],
    ["playCoin", playCoin],
    ["playPowerUp", playPowerUp],
    ["playDamage", playDamage],
    ["playDeath", playDeath],
    ["playBoss", playBoss],
    ["playUI", playUI],
    ["playShop", playShop],
  ] as const)("%s cria osciladores agendados no contexto", (_name, fn) => {
    fn();
    const oscs = oscillators();
    expect(oscs.length).toBeGreaterThan(0);
    for (const o of oscs) {
      expect(o.start).toHaveBeenCalled();
      expect(o.stop).toHaveBeenCalled();
    }
  });

  it("playCoin dispara dois tons (sequência B5→E6)", () => {
    playCoin();
    const oscs = oscillators();
    expect(oscs.length).toBe(2);
    expect(oscs[0].frequency.events[0][1]).toBeCloseTo(987.77, 0);
    expect(oscs[1].frequency.events[0][1]).toBeCloseTo(1318.51, 0);
  });

  it("todos os sons passam pelo master (gain conectado ao destination)", () => {
    playJump();
    playShoot();
    const master = gains().find((g) =>
      g.connect.mock.calls.some(([dest]) => dest === mockCtx.destination)
    );
    expect(master).toBeDefined();
  });

  it("não cria contexto quando nenhuma factory está disponível (no-op silencioso)", () => {
    setAudioContextFactory(null);
    // Remove o mock: em Node não há AudioContext global, então os play* não
    // devem lançar exceção — apenas não produzir nada.
    expect(() => playJump()).not.toThrow();
    expect(() => startMusic()).not.toThrow();
  });
});

describe("mute", () => {
  it("setMuted(true) zera o master e isMuted reflete o estado", () => {
    playJump(); // garante contexto + master criados
    setMuted(true);
    expect(isMuted()).toBe(true);
    const master = gains().find((g) =>
      g.connect.mock.calls.some(([dest]) => dest === mockCtx.destination)
    )!;
    expect(master.gain.value).toBe(0);
  });

  it("setMuted(false) restaura o volume do master", () => {
    setMuted(true);
    playJump();
    setMuted(false);
    expect(isMuted()).toBe(false);
    const master = gains().find((g) =>
      g.connect.mock.calls.some(([dest]) => dest === mockCtx.destination)
    )!;
    expect(master.gain.value).toBe(1);
  });

  it("mute aplicado antes do primeiro som vale para o master criado depois", () => {
    setMuted(true);
    playJump(); // cria o contexto agora, já mudo
    const master = gains().find((g) =>
      g.connect.mock.calls.some(([dest]) => dest === mockCtx.destination)
    )!;
    expect(master.gain.value).toBe(0);
  });
});

describe("música", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("startMusic agenda acordes futuros e stopMusic interrompe o timer", () => {
    startMusic();
    expect(mockCtx.created.length).toBeGreaterThan(0);
    expect(oscillators().length).toBeGreaterThan(0);

    const oscsBefore = oscillators().length;
    vi.advanceTimersByTime(2000); // scheduler lookahead dispara mais acordes
    expect(oscillators().length).toBeGreaterThan(oscsBefore);

    stopMusic();
    const oscsAfterStop = oscillators().length;
    vi.advanceTimersByTime(5000);
    // Sem novo timer, nenhum acorde novo é agendado.
    expect(oscillators().length).toBe(oscsAfterStop);
  });

  it("startMusic é idempotente (não duplica o loop)", () => {
    startMusic();
    const oscsFirst = oscillators().length;
    startMusic();
    expect(oscillators().length).toBe(oscsFirst);
  });

  it("música toca através do master (mute silencia o loop também)", () => {
    startMusic();
    setMuted(true);
    const master = gains().find((g) =>
      g.connect.mock.calls.some(([dest]) => dest === mockCtx.destination)
    )!;
    expect(master.gain.value).toBe(0);
  });
});
