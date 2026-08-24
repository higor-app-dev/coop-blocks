import { describe, expect, it, vi } from "vitest";
import { TILE, mulberry32 } from "./levelgen";
import {
  ENEMY_ATIRADOR_COOLDOWN_TICKS,
  ENEMY_HP,
  ENEMY_SIZE,
  ENEMY_VOADOR_AMPLITUDE,
  ENEMY_VOADOR_FREQUENCY,
  ENEMY_VOADOR_PHASE,
  ENEMY_ATIRADOR_PHASE,
  createEnemy,
  enemyTypePool,
  pickEnemyType,
  spawnEnemy,
  stepEnemy,
  type EnemyPlayer,
  type EnemyShot,
  type EnemySim,
  type EnemyWorld,
} from "./enemies";

/** Mundo de teste: grid de tiles em coordenadas de tile (col, row). */
function makeWorld(
  widthTiles: number,
  heightTiles: number,
  tiles: Array<[number, number]>
): EnemyWorld {
  const solid = new Set(tiles.map(([x, y]) => `${x},${y}`));
  return {
    width: widthTiles * TILE,
    height: heightTiles * TILE,
    solid: (tx, ty) => solid.has(`${tx},${ty}`),
  };
}

/** Chão contínuo da linha groundRow até o fundo, com lacunas opcionais. */
function groundWorld(
  widthTiles: number,
  heightTiles: number,
  groundRow: number,
  gaps: Array<[number, number]> = []
): EnemyWorld {
  const tiles: Array<[number, number]> = [];
  for (let tx = 0; tx < widthTiles; tx++) {
    const gap = gaps.some(([gx, len]) => tx >= gx && tx < gx + len);
    if (gap) continue;
    for (let ty = groundRow; ty < heightTiles; ty++) tiles.push([tx, ty]);
  }
  return makeWorld(widthTiles, heightTiles, tiles);
}

/** Player de teste com centro conhecido. */
function player(
  id: string,
  cx: number,
  cy: number,
  hp = 100,
  w = 28,
  h = 40
): EnemyPlayer {
  return { id, x: cx - w / 2, y: cy - h / 2, w, h, hp };
}

/** Roda stepEnemy por n passos de dt fixo, coletando disparos. */
function run(
  e: EnemySim,
  world: EnemyWorld,
  players: EnemyPlayer[],
  n: number,
  dt = 1 / 60
): EnemyShot[] {
  const shots: EnemyShot[] = [];
  for (let i = 0; i < n; i++) stepEnemy(e, world, players, dt, shots);
  return shots;
}

const W = 20; // tiles de largura
const H = 12; // tiles de altura
const GROUND = 10; // fileira do topo do chão
const GROUND_TOP = GROUND * TILE;

const spawnAt = (tx: number) => ({ x: tx * TILE, y: GROUND_TOP - 30 });

describe("enemyTypePool — gates de fase (1+/3+/5+)", () => {
  it("fase 1 e 2: só andador", () => {
    expect(enemyTypePool(1)).toEqual(["andador"]);
    expect(enemyTypePool(2)).toEqual(["andador"]);
  });
  it("fase 3 e 4: andador + voador", () => {
    expect(enemyTypePool(3)).toEqual(["andador", "voador"]);
    expect(enemyTypePool(4)).toEqual(["andador", "voador"]);
  });
  it("fase 5+: os três tipos em ordem fixa", () => {
    expect(enemyTypePool(5)).toEqual(["andador", "voador", "atirador"]);
    expect(enemyTypePool(7)).toEqual(["andador", "voador", "atirador"]);
  });
});

describe("pickEnemyType — escolha determinística pelo pool da fase", () => {
  it("fase 1: sempre andador, independente do RNG", () => {
    for (const rnd of [() => 0, () => 0.99, () => 0.5]) {
      expect(pickEnemyType(1, rnd)).toBe("andador");
    }
  });
  it("fase 3: só andador/voador", () => {
    for (let i = 0; i < 100; i++) {
      const t = pickEnemyType(3, () => i / 100);
      expect(["andador", "voador"]).toContain(t);
    }
  });
  it("mesma seed → mesma sequência de tipos (determinismo)", () => {
    const seqA = Array.from({ length: 20 }, () => pickEnemyType(5, mulberry32(7)));
    const seqB = Array.from({ length: 20 }, () => pickEnemyType(5, mulberry32(7)));
    expect(seqA).toEqual(seqB);
  });
});

describe("createEnemy — spawn por tipo", () => {
  it("andador: pés no chão, 1 tiro de HP (25)", () => {
    const e = createEnemy("andador", spawnAt(3), 1, "e1");
    expect(e.x).toBe(3 * TILE);
    expect(e.y).toBe(GROUND_TOP - 30);
    expect(e.w).toBe(30);
    expect(e.h).toBe(30);
    expect(e.hp).toBe(25);
    expect(e.grounded).toBe(true);
    expect(e.shootIn).toBe(0);
  });
  it("voador: flutua um tile acima do chão, 2 tiros de HP (50)", () => {
    const e = createEnemy("voador", spawnAt(3), 3, "e2");
    expect(e.y).toBe(GROUND_TOP - 28 - TILE);
    expect(e.baseY).toBe(e.y);
    expect(e.hp).toBe(50);
    expect(e.grounded).toBe(false);
  });
  it("atirador: pés no chão, 2 tiros de HP (50)", () => {
    const e = createEnemy("atirador", spawnAt(3), 5, "e3");
    expect(e.y).toBe(GROUND_TOP - 36);
    expect(e.hp).toBe(50);
  });
  it("atirador: primeiro tiro escalonado pelo ID (não dispara tudo no mesmo tick)", () => {
    const a = createEnemy("atirador", spawnAt(1), 5, "e1");
    const b = createEnemy("atirador", spawnAt(2), 5, "e42");
    expect(a.shootIn).toBe(1 % ENEMY_ATIRADOR_COOLDOWN_TICKS);
    expect(b.shootIn).toBe(42 % ENEMY_ATIRADOR_COOLDOWN_TICKS);
  });
});

describe("ANDADOR — patrulha no chão", () => {
  const world = groundWorld(W, H, GROUND);

  it("anda na direção e mantém o chão (grounded)", () => {
    const e = createEnemy("andador", spawnAt(3), 1, "e1");
    const x0 = e.x;
    run(e, world, [], 60); // 1 s
    expect(e.x).toBeGreaterThan(x0);
    expect(e.x).toBeCloseTo(x0 + 60, 1);
    expect(e.y).toBe(GROUND_TOP - 30);
    expect(e.grounded).toBe(true);
  });

  it("vira ao encontrar parede sólida à frente", () => {
    const tiles: Array<[number, number]> = [];
    for (let tx = 0; tx < W; tx++)
      for (let ty = GROUND; ty < H; ty++) tiles.push([tx, ty]);
    for (let ty = 6; ty <= GROUND; ty++) tiles.push([5, ty]); // parede na coluna 5
    const w = makeWorld(W, H, tiles);

    const e = createEnemy("andador", spawnAt(0), 1, "e1");
    // Aproxima da parede em x=5*TILE; deve inverter antes de encostar.
    let flipped = false;
    for (let i = 0; i < 400 && !flipped; i++) {
      stepEnemy(e, w, [], 1 / 60, []);
      if (e.dir === -1) flipped = true;
    }
    expect(flipped).toBe(true);
    expect(e.x).toBeLessThan(5 * TILE);
  });

  it("vira ao encontrar buraco à frente (nunca cai em lacuna)", () => {
    const w = groundWorld(W, H, GROUND, [[5, 2]]); // lacuna nas colunas 5-6
    const e = createEnemy("andador", spawnAt(2), 1, "e1");
    let flipped = false;
    for (let i = 0; i < 300 && !flipped; i++) {
      stepEnemy(e, w, [], 1 / 60, []);
      if (e.dir === -1) flipped = true;
    }
    expect(flipped).toBe(true);
    // Nunca entrou na coluna da lacuna.
    expect(e.x + e.w).toBeLessThanOrEqual(5 * TILE);
  });

  it("cai com gravidade quando perde o chão (e aterra)", () => {
    // Queda livre: spawn flutuando 2 fileiras acima do chão (sem chão abaixo).
    const w = groundWorld(W, H, GROUND);
    const e = createEnemy("andador", spawnAt(2), 1, "e1");
    e.y = 8 * TILE - 30;
    e.grounded = false;
    const y0 = e.y;
    run(e, w, [], 10); // 0,17 s de queda — ainda no ar
    expect(e.y).toBeGreaterThan(y0);
    expect(e.vy).toBeGreaterThan(0);
    run(e, w, [], 300); // aterra no chão (row GROUND)
    expect(e.grounded).toBe(true);
    expect(e.y).toBe(GROUND_TOP - 30);
  });
});

describe("VOADOR — flutua com seno, ignora buracos", () => {
  const world = groundWorld(W, H, GROUND);

  it("oscila verticalmente em torno da âncora (seno)", () => {
    const e = createEnemy("voador", spawnAt(3), 3, "e1");
    const baseY = e.baseY;
    run(e, world, [], 15, 1 / 60); // t = 0.25 s
    const want =
      baseY +
      Math.sin(2 * Math.PI * ENEMY_VOADOR_FREQUENCY * 0.25) *
        ENEMY_VOADOR_AMPLITUDE;
    expect(e.y).toBeCloseTo(want, 1);
    expect(e.y).toBeGreaterThanOrEqual(baseY - ENEMY_VOADOR_AMPLITUDE - 0.01);
    expect(e.y).toBeLessThanOrEqual(baseY + ENEMY_VOADOR_AMPLITUDE + 0.01);
  });

  it("cruza buracos sem cair (ignora lacunas)", () => {
    const w = groundWorld(W, H, GROUND, [[5, 3]]); // lacuna 5-7
    const e = createEnemy("voador", spawnAt(2), 3, "e1");
    run(e, w, [], 400); // ~6,7 s de voo — atravessa a lacuna por completo
    expect(e.y).toBeGreaterThanOrEqual(e.baseY - ENEMY_VOADOR_AMPLITUDE - 0.01);
    expect(e.y).toBeLessThanOrEqual(e.baseY + ENEMY_VOADOR_AMPLITUDE + 0.01);
    expect(e.x).toBeGreaterThan(8 * TILE);
  });

  it("quica nas bordas do mundo (toca as duas ao longo do voo)", () => {
    const e = createEnemy("voador", spawnAt(0), 3, "e1");
    let touchedRight = false;
    let touchedLeft = false;
    for (let i = 0; i < 6000; i++) {
      stepEnemy(e, world, [], 1 / 60, []);
      if (e.x >= world.width - e.w) touchedRight = true;
      if (e.x <= 0) touchedLeft = true;
    }
    expect(touchedRight).toBe(true);
    expect(touchedLeft).toBe(true);
    expect(e.x).toBeGreaterThanOrEqual(0);
    expect(e.x).toBeLessThanOrEqual(world.width - e.w);
  });

  it("quica ao encontrar parede sólida na altura do voo", () => {
    const tiles: Array<[number, number]> = [];
    for (let tx = 0; tx < W; tx++)
      for (let ty = GROUND; ty < H; ty++) tiles.push([tx, ty]);
    for (let ty = 3; ty <= 9; ty++) tiles.push([9, ty]); // parede coluna 9
    const w = makeWorld(W, H, tiles);

    const e = createEnemy("voador", spawnAt(3), 3, "e1");
    let flipped = false;
    for (let i = 0; i < 400 && !flipped; i++) {
      stepEnemy(e, w, [], 1 / 60, []);
      if (e.dir === -1) flipped = true;
    }
    expect(flipped).toBe(true);
    // A checagem usa x+w−1 (como no servidor): a borda pode penetrar 1px na
    // coluna da parede antes de virar, mas nunca a atravessa.
    expect(e.x).toBeLessThan(9 * TILE);
    expect(e.x + e.w).toBeLessThanOrEqual(9 * TILE + 1);
  });
});

describe("ATIRADOR — alvo determinístico e disparo", () => {
  const world = groundWorld(W, H, GROUND);
  const center = (e: EnemySim) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });

  it("dispara no jogador mais próximo (centros)", () => {
    const e = createEnemy("atirador", spawnAt(5), 5, "e1");
    e.shootIn = 0;
    const far = player("p1", e.x + 800, e.y + 200);
    const near = player("p2", e.x + 120, e.y + 60);
    const shots = run(e, world, [far, near], 1);
    expect(shots).toHaveLength(1);
    const c = center(e);
    expect(shots[0].x).toBeCloseTo(c.x, 5);
    expect(shots[0].y).toBeCloseTo(c.y, 5);
    expect(shots[0].targetX).toBeCloseTo(near.x + near.w / 2, 5);
    expect(shots[0].targetY).toBeCloseTo(near.y + near.h / 2, 5);
    // Após disparar, entra em cooldown.
    const after = run(e, world, [far, near], 1);
    expect(after).toHaveLength(0);
  });

  it("empate de distância: alvo = menor ID", () => {
    const e = createEnemy("atirador", spawnAt(5), 5, "e1");
    e.shootIn = 0;
    // Equidistantes do atirador.
    const a = player("p9", e.x - 100, e.y);
    const b = player("p2", e.x + 100, e.y);
    const shots = run(e, world, [a, b], 1);
    expect(shots).toHaveLength(1);
    expect(shots[0].targetX).toBeCloseTo(b.x + b.w / 2, 5);
  });

  it("não dispara com todos os jogadores mortos", () => {
    const e = createEnemy("atirador", spawnAt(5), 5, "e1");
    e.shootIn = 0;
    const dead = player("p1", e.x + 100, e.y, 0);
    const shots = run(e, world, [dead], 3);
    expect(shots).toHaveLength(0);
  });

  it("respeita o cooldown inicial (shootIn do spawn)", () => {
    const e = createEnemy("atirador", spawnAt(5), 5, "e1"); // shootIn = 1
    const p = player("p1", e.x + 200, e.y);
    const first = run(e, world, [p], 1); // tick 1: ainda em cooldown
    expect(first).toHaveLength(0);
    const second = run(e, world, [p], 1); // tick 2: cooldown zerou → dispara
    expect(second).toHaveLength(1);
  });
});

describe("determinismo — mesma entrada, mesma saída", () => {
  it("dois inimigos idênticos com os mesmos passos terminam iguais", () => {
    const world = groundWorld(W, H, GROUND, [[5, 2]]);
    const players = [player("p1", 300, 200), player("p2", 500, 300)];
    const mk = (tx: number) => createEnemy("andador", spawnAt(tx), 1, "e1");

    const a = mk(2);
    const b = mk(2);
    for (let i = 0; i < 300; i++) {
      stepEnemy(a, world, players, 1 / 60, []);
      stepEnemy(b, world, players, 1 / 60, []);
    }
    expect(a).toEqual(b);
  });

  it("HP/tamanhos seguem a tabela por tipo", () => {
    expect(ENEMY_HP).toEqual({ andador: 25, voador: 50, atirador: 50 });
    expect(ENEMY_SIZE.andador).toEqual({ w: 30, h: 30 });
    expect(ENEMY_SIZE.voador).toEqual({ w: 34, h: 28 });
    expect(ENEMY_SIZE.atirador).toEqual({ w: 30, h: 36 });
  });
});

// ===== Camada kaplay (spawnEnemy) com engine fake =====
// O módulo não importa kaplay em runtime; o fake satisfaz as APIs usadas pelo
// wrapper e rastreia objetos criados e callbacks de onUpdate para as asserções.

interface FakeObj {
  tags: string[];
  pos: { x: number; y: number };
  children: unknown[][];
  add: (comps: unknown[]) => void;
  exists: () => boolean;
  /** Espelho do GameObj.paused do kaplay (default undefined = não-pausado). */
  paused?: boolean;
}

function makeFakeKaplay() {
  const created: FakeObj[] = [];
  const updates: Array<() => void> = [];
  const k = {
    add: vi.fn((comps: unknown[]) => {
      const obj: FakeObj = {
        tags: comps.filter((c): c is string => typeof c === "string"),
        pos: { x: 0, y: 0 },
        children: [],
        add: (c: unknown[]) => {
          obj.children.push(c);
        },
        exists: () => true,
      };
      const posComp = comps.find(
        (c): c is { x: number; y: number } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { x?: unknown }).x === "number" &&
          typeof (c as { y?: unknown }).y === "number"
      );
      if (posComp) obj.pos = { x: posComp.x, y: posComp.y };
      created.push(obj);
      return obj;
    }),
    pos: vi.fn((x: number, y: number) => ({ x, y })),
    rect: vi.fn((w: number, h: number, o?: unknown) => ({ w, h, o })),
    color: vi.fn((r: number, g: number, b: number) => ({ r, g, b })),
    area: vi.fn(() => ({})),
    z: vi.fn((v: number) => ({ v })),
    vec2: vi.fn((x: number, y: number) => ({ x, y })),
    dt: vi.fn(() => 1 / 60),
    onUpdate: vi.fn((fn: () => void) => {
      updates.push(fn);
    }),
  };
  return { k, created, updates };
}

describe("spawnEnemy — wrapper kaplay (engine fake)", () => {
  const world = groundWorld(W, H, GROUND);

  it("andador: tag enemy, rect/cor do tipo e posição inicial no spawn", () => {
    const { k, created } = makeFakeKaplay();
    const e = spawnEnemy(k as never, {
      pos: spawnAt(3),
      type: "andador",
      phase: 1,
      id: "e1",
      world,
      players: () => [],
    });
    expect(created).toHaveLength(1);
    expect(e.tags).toContain("enemy");
    expect(k.rect).toHaveBeenCalledWith(30, 30, { radius: 4 });
    expect(k.color).toHaveBeenCalledWith(235, 70, 70);
    expect(e.pos).toEqual({ x: 3 * TILE, y: GROUND_TOP - 30 });
  });

  it("voador: rect/cor próprios e flutua acima do chão", () => {
    const { k, created } = makeFakeKaplay();
    const e = spawnEnemy(k as never, {
      pos: spawnAt(3),
      type: "voador",
      phase: 3,
      id: "e1",
      world,
      players: () => [],
    });
    expect(created).toHaveLength(1);
    expect(k.rect).toHaveBeenCalledWith(34, 28, { radius: 10 });
    expect(k.color).toHaveBeenCalledWith(90, 210, 120);
    expect(e.pos.y).toBe(GROUND_TOP - 28 - TILE);
  });

  it("atirador: rect/cor próprios e ganha o cano (filho)", () => {
    const { k, created } = makeFakeKaplay();
    const e = spawnEnemy(k as never, {
      pos: spawnAt(3),
      type: "atirador",
      phase: 5,
      id: "e1",
      world,
      players: () => [],
    });
    expect(created).toHaveLength(1);
    expect(k.rect).toHaveBeenCalledWith(30, 36, { radius: 4 });
    expect(k.color).toHaveBeenCalledWith(190, 120, 235);
    expect(e.children).toHaveLength(1); // cano
    expect(e.pos.y).toBe(GROUND_TOP - 36);
  });

  it("onUpdate avança a IA e aplica a posição (andador anda)", () => {
    const { k, updates } = makeFakeKaplay();
    const e = spawnEnemy(k as never, {
      pos: spawnAt(2),
      type: "andador",
      phase: 1,
      id: "e1",
      world,
      players: () => [],
    });
    expect(updates).toHaveLength(1);
    const x0 = e.pos.x;
    for (let i = 0; i < 60; i++) updates[0](); // 1 s de patrulha
    expect(e.pos.x).toBeGreaterThan(x0);
  });

  it("paused=true congela a IA (loja entre fases pausa o mundo)", () => {
    const { k, updates } = makeFakeKaplay();
    const e = spawnEnemy(k as never, {
      pos: spawnAt(2),
      type: "andador",
      phase: 1,
      id: "e1",
      world,
      players: () => [],
    });
    expect(updates).toHaveLength(1);
    const x0 = e.pos.x;
    e.paused = true;
    for (let i = 0; i < 60; i++) updates[0](); // 1 s com o mundo pausado
    expect(e.pos.x).toBe(x0);
    e.paused = false;
    for (let i = 0; i < 60; i++) updates[0](); // 1 s de patrulha
    expect(e.pos.x).toBeGreaterThan(x0);
  });

  it("atirador: onShot é chamado apontando para o centro do player", () => {
    const { k, updates } = makeFakeKaplay();
    const onShot = vi.fn();
    const p = player("local", 600, GROUND_TOP - 30);
    const e = spawnEnemy(k as never, {
      pos: spawnAt(8),
      type: "atirador",
      phase: 5,
      id: "e1", // shootIn = 1 % 40
      world,
      players: () => [p],
      onShot,
    });
    for (let i = 0; i < 2; i++) updates[0](); // cooldown inicial zera → dispara
    expect(onShot).toHaveBeenCalledTimes(1);
    const shot = onShot.mock.calls[0][0] as EnemyShot;
    expect(shot.targetX).toBeCloseTo(p.x + p.w / 2, 5);
    expect(shot.targetY).toBeCloseTo(p.y + p.h / 2, 5);
    expect(shot.speed).toBe(260);
    expect(shot.lifetime).toBe(4);
  });
});
