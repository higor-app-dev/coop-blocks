import { describe, expect, it } from "vitest";
import {
  CoinColumnStep,
  CoinSeedXor,
  CoinStartCol,
  GapPeriod,
  GapWidth,
  MinSpecHeight,
  MinSpecWidth,
  POWERUP_MAX_PER_PHASE,
  PLAYER_WIDTH,
  PlayerSpawnX,
  TILE,
  clampDifficulty,
  generateLevel,
  generateLevelData,
  isLevelFinished,
  mulberry32,
} from "./levelgen";
import type { LevelSpec } from "./levelgen";

// Mesmo conjunto fixo do level_test.go do servidor Go.
const testSeeds = [
  0, 1, 2, 3, 4, 7, 42, 99, 1337, 2024, 65536, 999983, 123456789,
  2147483647, 4294967294, 4294967295,
];

// Mesmas specs do level_test.go (a do client é 120x12).
const testSpecs: Array<{ name: string; width: number; height: number }> = [
  { name: "client_120x12", width: 120, height: 12 },
  { name: "estreita_30x8", width: 30, height: 8 },
  { name: "larga_240x16", width: 240, height: 16 },
  { name: "media_60x10", width: 60, height: 10 },
  { name: "minima_9x6", width: 9, height: 6 },
];

function specOf(s: { width: number; height: number }, seed: number): LevelSpec {
  return { width: s.width, height: s.height, seed };
}

/**
 * Assinatura canônica no MESMO formato do servidor Go (Level.Signature em
 * apps/api/internal/game/level.go): header + tiles ordenados + inimigos.
 * Spawns de inimigos/player chegam em pixels; converte de volta para tile.
 */
function signature(spec: LevelSpec, data: ReturnType<typeof generateLevelData>): string {
  const groundY = spec.height - 2;
  let s = `w=${spec.width} h=${spec.height} ground=${groundY} spawn=${PlayerSpawnX},${groundY} enemies=${data.enemySpawns.length}`;
  for (const t of data.tiles) s += `;${t.x},${t.y}`;
  for (const e of data.enemySpawns) s += `|${e.x / TILE},${groundY}`;
  return s;
}

describe("mulberry32 — paridade bit-a-bit com o servidor Go", () => {
  // Golden values vindos do level_test.go Go (que foram cruzados com node
  // via toFixed(9)); mesma tolerância eps = 1e-8.
  const goldens: Array<{ seed: number; want: number[] }> = [
    { seed: 0, want: [0.266429209, 0.000329746, 0.223272027, 0.146202148] },
    { seed: 1, want: [0.627073941, 0.002735721, 0.52744704, 0.981050967] },
    { seed: 42, want: [0.601103752, 0.448290559, 0.852465793, 0.669734041] },
    { seed: 4294967295, want: [0.896422614, 0.189478257, 0.715652678, 0.944059909] },
  ];
  const eps = 1e-8;

  it.each(goldens)("seed $seed produz a mesma sequência que o Go", ({ seed, want }) => {
    const rnd = mulberry32(seed);
    for (const w of want) {
      const got = rnd();
      expect(Math.abs(got - w)).toBeLessThan(eps);
    }
  });

  it("coage a seed para uint32 (>>> 0)", () => {
    const rnd = mulberry32(-1); // -1 >>> 0 === 4294967295
    expect(Math.abs(rnd() - 0.896422614)).toBeLessThan(eps);
    expect(Math.abs(rnd() - 0.189478257)).toBeLessThan(eps);
  });
});

describe("generateLevelData — determinismo", () => {
  it("mesma seed ⇒ exatamente a mesma fase (tiles, spawn, inimigos)", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const a = signature(specOf(s, seed), generateLevelData(specOf(s, seed)));
        const b = signature(specOf(s, seed), generateLevelData(specOf(s, seed)));
        expect(b).toBe(a);
      }
    }
  });

  it("seeds diferentes ⇒ fases diferentes (specs com entropia suficiente)", () => {
    for (const s of testSpecs) {
      if (s.width < GapPeriod * 2) continue; // 9x6: poucos layouts, colisões esperadas
      const sigs = new Set(
        testSeeds.map((seed) => signature(specOf(s, seed), generateLevelData(specOf(s, seed))))
      );
      expect(sigs.size).toBe(testSeeds.length);
    }
  });
});

describe("generateLevelData — estrutura", () => {
  it("invariantes estruturais valem para todos os specs × seeds", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const spec = specOf(s, seed);
        const d = generateLevelData(spec);
        const w = spec.width;
        const h = spec.height;
        const groundY = h - 2;
        const solid = new Set(d.tiles.map((t) => `${t.x},${t.y}`));
        const has = (x: number, y: number) => solid.has(`${x},${y}`);

        // spawn e fim da fase sobre solo sólido (fim garantido pelo patch)
        expect(has(PlayerSpawnX, groundY)).toBe(true);
        for (let tx = w - GapWidth; tx < w; tx++) {
          expect(has(tx, groundY)).toBe(true);
        }

        // lacunas do chão com no máximo GapWidth tiles (puláveis)
        let gapRun = 0;
        let maxGap = 0;
        for (let tx = 0; tx < w; tx++) {
          if (has(tx, groundY)) {
            gapRun = 0;
            continue;
          }
          gapRun++;
          maxGap = Math.max(maxGap, gapRun);
        }
        expect(maxGap).toBeLessThanOrEqual(GapWidth);

        // clearance: nada sólido na fileira acima do chão (sem parede)
        for (let tx = 0; tx < w; tx++) {
          expect(has(tx, groundY - 1)).toBe(false);
        }

        // nada abaixo do chão (solo tem 2 tiles de espessura)
        for (let tx = 0; tx < w; tx++) {
          expect(has(tx, groundY + 2)).toBe(false);
        }

        // chão com espessura consistente
        for (let tx = 0; tx < w; tx++) {
          expect(has(tx, groundY)).toBe(has(tx, groundY + 1));
        }

        // inimigos: sobre o chão, longe do spawn (tx >= 12) e no grid
        for (const e of d.enemySpawns) {
          const ex = e.x / TILE;
          expect(has(ex, groundY)).toBe(true);
          expect(ex).toBeGreaterThanOrEqual(12);
          expect(ex).toBeLessThan(w - 1);
          expect(e.y).toBe(groundY * TILE - 30);
        }

        // player spawn em pixels, na coluna 2
        expect(d.playerSpawn.x).toBe(PlayerSpawnX * TILE);
        expect(d.playerSpawn.y).toBe(groundY * TILE - 42);

        // saída canônica: ordenado, sem duplicatas, dentro do grid
        expect(d.tiles.length).toBe(new Set(d.tiles.map((t) => `${t.x},${t.y}`)).size);
        for (let i = 1; i < d.tiles.length; i++) {
          const prev = d.tiles[i - 1];
          const cur = d.tiles[i];
          expect(cur.x > prev.x || (cur.x === prev.x && cur.y > prev.y)).toBe(true);
        }
        for (const t of d.tiles) {
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(t.x).toBeLessThan(w);
          expect(t.y).toBeGreaterThanOrEqual(0);
          expect(t.y).toBeLessThan(h);
        }
      }
    }
  });
});

describe("generateLevelData — specs inválidos", () => {
  const invalid: Array<Omit<LevelSpec, "seed">> = [
    { width: 8, height: 12 }, // largura abaixo do mínimo (client usa 120)
    { width: 120, height: 5 }, // altura abaixo do mínimo (client usa 12)
    { width: 1, height: 1 },
    { width: 0, height: 12 },
    { width: 120, height: 0 },
    { width: -10, height: -10 },
    { width: 9.5, height: 12 }, // não-inteiro
    { width: 120, height: 5.5 },
    { width: NaN, height: 12 },
    { width: Infinity, height: 12 },
  ];

  it.each(invalid)("lança RangeError para %j", (spec) => {
    expect(() => generateLevelData({ seed: 0, ...spec })).toThrow(RangeError);
  });

  it("aceita o spec mínimo 9x6", () => {
    const d = generateLevelData({ width: MinSpecWidth, height: MinSpecHeight, seed: 42 });
    expect(d.tiles.length).toBeGreaterThan(0);
    expect(d.playerSpawn.x).toBe(PlayerSpawnX * TILE);
  });
});

describe("paridade client ↔ servidor Go — golden (120x12)", () => {
  // Assinaturas capturadas rodando GenerateLevel do apps/api (go run) — se
  // estas quebrarem, client e servidor divergiram na "seed compartilhada".
  const goldens: Array<{ seed: number; sig: string }> = [
    {
      seed: 0,
      sig:
        "w=120 h=12 ground=10 spawn=2,10 enemies=15" +
        ";2,10;2,11;3,10;3,11;4,10;4,11;5,10;5,11;6,10;6,11;7,10;7,11;8,10;8,11" +
        ";10,8;11,8;11,10;11,11;12,10;12,11;13,10;13,11;14,10;14,11;15,10;15,11;16,10;16,11" +
        ";17,8;17,10;17,11;18,7;18,8;19,7;20,7;20,10;20,11;21,10;21,11;22,10;22,11;23,10;23,11" +
        ";24,10;24,11;25,10;25,11;26,10;26,11" +
        ";29,10;29,11;30,10;30,11;31,10;31,11;32,8;32,10;32,11;33,8;33,10;33,11;34,10;34,11;35,10;35,11" +
        ";38,10;38,11;39,10;39,11;40,10;40,11;41,6;41,10;41,11;42,6;42,8;42,10;42,11;43,6;43,8;43,10;43,11;44,10;44,11" +
        ";46,7;47,7;47,10;47,11;48,10;48,11;49,10;49,11;50,10;50,11;51,10;51,11;52,10;52,11;53,10;53,11" +
        ";56,7;56,10;56,11;57,6;57,7;57,10;57,11;58,6;58,10;58,11;59,6;59,10;59,11;60,6;60,10;60,11;61,10;61,11;62,10;62,11" +
        ";65,10;65,11;66,10;66,11;67,10;67,11;68,8;68,10;68,11;69,8;69,10;69,11;70,8;70,10;70,11;71,10;71,11" +
        ";73,7;74,7;74,10;74,11;75,7;75,10;75,11;76,10;76,11;77,8;77,10;77,11;78,6;78,8;78,10;78,11;79,6;79,8;79,10;79,11;80,6;80,10;80,11" +
        ";83,10;83,11;84,10;84,11;85,10;85,11;86,10;86,11;87,10;87,11;88,10;88,11;89,7;89,10;89,11;90,7" +
        ";92,10;92,11;93,6;93,10;93,11;94,6;94,10;94,11;95,6;95,10;95,11;96,8;96,10;96,11;97,8;97,10;97,11;98,10;98,11" +
        ";101,10;101,11;102,10;102,11;103,10;103,11;104,10;104,11;105,10;105,11;106,7;106,10;106,11;107,7;107,10;107,11;108,7;109,7" +
        ";110,10;110,11;111,10;111,11;112,10;112,11;113,7;113,10;113,11;114,7;114,10;114,11;115,7;115,10;115,11;116,7;116,10;116,11" +
        ";118,10;118,11;119,10;119,11" +
        "|12,10|17,10|25,10|31,10|44,10|52,10|58,10|66,10|71,10|77,10|84,10|92,10|105,10|110,10|116,10",
    },
    {
      seed: 42,
      sig:
        "w=120 h=12 ground=10 spawn=2,10 enemies=14" +
        ";2,7;2,10;2,11;3,7;3,10;3,11;4,7;4,10;4,11;5,7;5,10;5,11;6,8;6,10;6,11;7,7;7,8;7,10;7,11;8,7;8,8;8,10;8,11" +
        ";11,10;11,11;12,10;12,11;13,10;13,11;14,10;14,11;15,10;15,11;16,10;16,11;17,10;17,11" +
        ";20,10;20,11;21,10;21,11;22,6;22,10;22,11;23,6;23,10;23,11;24,6;24,10;24,11;25,10;25,11;26,8;26,10;26,11;27,8;28,8;29,8;29,10;29,11;30,10;30,11;31,10;31,11" +
        ";32,8;32,10;32,11;33,7;33,8;33,10;33,11;34,7;34,8;34,10;34,11;35,7;35,8;35,10;35,11;36,7" +
        ";38,10;38,11;39,10;39,11;40,10;40,11;41,10;41,11;42,10;42,11;43,10;43,11;44,10;44,11" +
        ";47,10;47,11;48,10;48,11;49,10;49,11;50,10;50,11;51,10;51,11;52,6;52,10;52,11;53,6;53,10;53,11" +
        ";56,8;56,10;56,11;57,8;57,10;57,11;58,8;58,10;58,11;59,8;59,10;59,11;60,6;60,10;60,11;61,6;61,10;61,11;62,6;62,10;62,11" +
        ";65,10;65,11;66,10;66,11;67,10;67,11;68,10;68,11;69,10;69,11;70,10;70,11;71,7;71,8;71,10;71,11;72,7;72,8;73,7;73,8;74,7;74,10;74,11;75,10;75,11;76,10;76,11;77,10;77,11" +
        ";78,6;78,10;78,11;79,6;79,8;79,10;79,11;80,6;80,8;80,10;80,11;81,6;81,8" +
        ";83,10;83,11;84,10;84,11;85,10;85,11;86,10;86,11;87,10;87,11;88,8;88,10;88,11;89,8;89,10;89,11" +
        ";92,7;92,10;92,11;93,7;93,10;93,11;94,10;94,11;95,8;95,10;95,11;96,8;96,10;96,11;97,8;97,10;97,11;98,10;98,11" +
        ";101,7;101,10;101,11;102,7;102,10;102,11;103,10;103,11;104,10;104,11;105,10;105,11;106,10;106,11;107,10;107,11" +
        ";109,8;110,8;110,10;110,11;111,8;111,10;111,11;112,8;112,10;112,11;113,10;113,11;114,10;114,11;115,10;115,11;116,10;116,11" +
        ";118,10;118,11;119,10;119,11" +
        "|12,10|17,10|22,10|34,10|41,10|49,10|61,10|69,10|75,10|87,10|94,10|102,10|107,10|115,10",
    },
    {
      seed: 123456789,
      sig:
        "w=120 h=12 ground=10 spawn=2,10 enemies=15" +
        ";2,10;2,11;3,10;3,11;4,10;4,11;5,8;5,10;5,11;6,8;6,10;6,11;7,8;7,10;7,11;8,8;8,10;8,11" +
        ";11,10;11,11;12,10;12,11;13,10;13,11;14,10;14,11;15,10;15,11;16,10;16,11;17,10;17,11" +
        ";20,7;20,10;20,11;21,7;21,10;21,11;22,7;22,10;22,11;23,10;23,11;24,10;24,11;25,8;25,10;25,11;26,8;26,10;26,11;27,8;28,7;28,8;29,7;29,10;29,11;30,7;30,10;30,11;31,6;31,7;31,10;31,11;32,6;32,10;32,11;33,6;33,8;33,10;33,11;34,6;34,8;34,10;34,11;35,8;35,10;35,11;36,8;37,8" +
        ";38,10;38,11;39,10;39,11;40,10;40,11;41,10;41,11;42,8;42,10;42,11;43,8;43,10;43,11;44,8;44,10;44,11;45,8" +
        ";47,6;47,10;47,11;48,6;48,10;48,11;49,6;49,10;49,11;50,10;50,11;51,10;51,11;52,10;52,11;53,10;53,11" +
        ";56,6;56,10;56,11;57,6;57,10;57,11;58,10;58,11;59,10;59,11;60,10;60,11;61,10;61,11;62,10;62,11" +
        ";65,7;65,10;65,11;66,7;66,10;66,11;67,6;67,7;67,8;67,10;67,11;68,6;68,8;68,10;68,11;69,8;69,10;69,11;70,10;70,11;71,10;71,11" +
        ";74,10;74,11;75,10;75,11;76,10;76,11;77,10;77,11;78,10;78,11;79,10;79,11;80,10;80,11" +
        ";83,10;83,11;84,10;84,11;85,10;85,11;86,10;86,11;87,10;87,11;88,10;88,11;89,10;89,11" +
        ";92,6;92,8;92,10;92,11;93,6;93,8;93,10;93,11;94,10;94,11;95,10;95,11;96,7;96,10;96,11;97,6;97,7;97,10;97,11;98,6;98,7;98,10;98,11;99,6;100,6" +
        ";101,10;101,11;102,10;102,11;103,10;103,11;104,7;104,10;104,11;105,7;105,10;105,11;106,7;106,10;106,11;107,7;107,10;107,11;108,7" +
        ";110,10;110,11;111,10;111,11;112,10;112,11;113,7;113,10;113,11;114,7;114,10;114,11;115,10;115,11;116,10;116,11" +
        ";118,10;118,11;119,10;119,11" +
        "|12,10|17,10|24,10|32,10|38,10|44,10|49,10|62,10|70,10|78,10|85,10|92,10|98,10|104,10|111,10",
    },
    {
      seed: 4294967295,
      sig:
        "w=120 h=12 ground=10 spawn=2,10 enemies=13" +
        ";2,10;2,11;3,10;3,11;4,10;4,11;5,8;5,10;5,11;6,8;6,10;6,11;7,10;7,11;8,10;8,11" +
        ";11,10;11,11;12,10;12,11;13,10;13,11;14,10;14,11;15,8;15,10;15,11;16,8;16,10;16,11;17,8;17,10;17,11;18,7;19,7;20,7;20,10;20,11;21,6;21,7;21,10;21,11;22,6;22,10;22,11;23,6;23,10;23,11;24,6;24,10;24,11;25,10;25,11;26,10;26,11" +
        ";29,10;29,11;30,10;30,11;31,7;31,10;31,11;32,6;32,7;32,10;32,11;33,6;33,7;33,8;33,10;33,11;34,6;34,8;34,10;34,11;35,6;35,10;35,11" +
        ";38,10;38,11;39,10;39,11;40,10;40,11;41,6;41,10;41,11;42,6;42,10;42,11;43,6;43,10;43,11;44,10;44,11" +
        ";46,7;47,7;47,10;47,11;48,7;48,10;48,11;49,7;49,10;49,11;50,10;50,11;51,10;51,11;52,8;52,10;52,11;53,8;53,10;53,11;54,8;55,8;56,8;56,10;56,11;57,10;57,11;58,10;58,11;59,10;59,11;60,10;60,11;61,10;61,11;62,10;62,11" +
        ";64,7;65,7;65,10;65,11;66,10;66,11;67,10;67,11;68,10;68,11;69,10;69,11;70,10;70,11;71,10;71,11" +
        ";74,10;74,11;75,10;75,11;76,10;76,11;77,10;77,11;78,10;78,11;79,10;79,11;80,7;80,10;80,11;81,7" +
        ";83,10;83,11;84,10;84,11;85,10;85,11;86,10;86,11;87,10;87,11;88,7;88,10;88,11;89,6;89,7;89,10;89,11;90,6;90,7;91,7" +
        ";92,10;92,11;93,10;93,11;94,10;94,11;95,10;95,11;96,10;96,11;97,10;97,11;98,10;98,11" +
        ";101,10;101,11;102,10;102,11;103,10;103,11;104,10;104,11;105,8;105,10;105,11;106,8;106,10;106,11;107,8;107,10;107,11;108,8" +
        ";109,6;110,6;110,10;110,11;111,6;111,10;111,11;112,6;112,10;112,11;113,6;113,10;113,11;114,10;114,11;115,10;115,11;116,6;116,7;116,10;116,11;117,6;117,7;118,7;118,10;118,11;119,10;119,11" +
        "|12,10|20,10|25,10|33,10|38,10|43,10|50,10|57,10|71,10|76,10|96,10|103,10|111,10",
    },
  ];

  it.each(goldens)("seed $seed gera a MESMA fase que o servidor Go", ({ seed, sig }) => {
    const spec = { width: 120, height: 12, seed };
    const d = generateLevelData(spec);
    expect(signature(spec, d)).toBe(sig);
  });
});

describe("isLevelFinished — fim do mapa", () => {
  const W = 120;
  const endX = (W - 1) * TILE; // primeira coluna do fim (tile 119)

  it("não termina antes da borda direita do hitbox cruzar o fim", () => {
    expect(isLevelFinished(W, endX - PLAYER_WIDTH - 1)).toBe(false);
    expect(isLevelFinished(W, 0)).toBe(false);
  });

  it("termina quando a borda direita atinge a primeira coluna do fim", () => {
    // borda direita = playerX + PLAYER_WIDTH; cruza em (W-1)*TILE
    expect(isLevelFinished(W, endX - PLAYER_WIDTH)).toBe(true);
    expect(isLevelFinished(W, endX)).toBe(true);
  });

  it("espelha Level.Finished do servidor Go (mesmo PlayerWidth=28)", () => {
    // o servidor usa px + PlayerWidth >= (Width-1)*TileSize
    expect(isLevelFinished(W, endX - 28)).toBe(true);
    expect(isLevelFinished(W, endX - 29)).toBe(false);
  });
});

describe("clampDifficulty — dificuldade efetiva da fase", () => {
  it("default/inválido → 1 (paridade com o servidor Go)", () => {
    expect(clampDifficulty(undefined)).toBe(1);
    expect(clampDifficulty(0)).toBe(1);
    expect(clampDifficulty(-5)).toBe(1);
    expect(clampDifficulty(NaN)).toBe(1);
    expect(clampDifficulty(Infinity)).toBe(1);
  });

  it("arredonda para baixo e respeita mínimo 1", () => {
    expect(clampDifficulty(2)).toBe(2);
    expect(clampDifficulty(2.9)).toBe(2);
    expect(clampDifficulty(1.1)).toBe(1);
  });
});

describe("generateLevelData — dificuldade progressiva", () => {
  const spec = (difficulty?: number): LevelSpec => ({
    width: 120,
    height: 12,
    seed: 42,
    ...(difficulty !== undefined ? { difficulty } : {}),
  });

  /** Maior corrida contígua de tiles sólidos suspensos (não-chão) por linha. */
  function maxPlatformRun(d: ReturnType<typeof generateLevelData>): number {
    const rows = new Map<number, number[]>();
    const groundY = 10;
    for (const t of d.tiles) {
      if (t.y < groundY) {
        const col = rows.get(t.y) ?? [];
        col.push(t.x);
        rows.set(t.y, col);
      }
    }
    let best = 0;
    for (const cols of rows.values()) {
      cols.sort((a, b) => a - b);
      let run = 1;
      for (let i = 1; i < cols.length; i++) {
        run = cols[i] === cols[i - 1] + 1 ? run + 1 : 1;
        best = Math.max(best, run);
      }
      best = Math.max(best, cols.length > 0 ? 1 : 0);
    }
    return best;
  }

  it("difficulty ausente ≡ difficulty 1 (paridade bit-a-bit)", () => {
    for (const seed of [0, 1, 42, 123456789, 4294967295]) {
      const a = generateLevelData(spec());
      const b = generateLevelData({ ...spec(), difficulty: 1 });
      expect(b.tiles).toEqual(a.tiles);
      expect(b.playerSpawn).toEqual(a.playerSpawn);
      expect(b.enemySpawns).toEqual(a.enemySpawns);
    }
  });

  it("fases maiores ⇒ mais spawns de inimigos (mesma seed)", () => {
    const base = generateLevelData(spec(1)).enemySpawns.length;
    expect(generateLevelData(spec(2)).enemySpawns.length).toBeGreaterThanOrEqual(base);
    expect(generateLevelData(spec(5)).enemySpawns.length).toBeGreaterThan(base);
    // densidade satura em MaxEnemyDensity — fases altas não ficam triviais
    const d10 = generateLevelData(spec(10)).enemySpawns.length;
    const d20 = generateLevelData(spec(20)).enemySpawns.length;
    expect(d20).toBe(d10);
  });

  it("fases maiores ⇒ plataformas suspensas menores ou iguais", () => {
    const run1 = maxPlatformRun(generateLevelData(spec(1)));
    const run5 = maxPlatformRun(generateLevelData(spec(5)));
    expect(run5).toBeLessThanOrEqual(run1);
    // nenhuma plataforma vira buraco no chão: spawn e fim continuam sólidos
    for (const diff of [1, 2, 3, 5, 10]) {
      const d = generateLevelData(spec(diff));
      const solid = new Set(d.tiles.map((t) => `${t.x},${t.y}`));
      expect(solid.has(`${PlayerSpawnX},10`)).toBe(true);
      for (let tx = 120 - GapWidth; tx < 120; tx++) {
        expect(solid.has(`${tx},10`)).toBe(true);
      }
    }
  });

  it("determinístico por (seed, difficulty)", () => {
    for (const diff of [1, 2, 5]) {
      const a = generateLevelData(spec(diff));
      const b = generateLevelData(spec(diff));
      expect(b.tiles).toEqual(a.tiles);
      expect(b.enemySpawns).toEqual(a.enemySpawns);
    }
  });

  it("seed nova entre fases consecutivas ⇒ mapas diferentes", () => {
    // fase N usa seed N (convenção do client): mapa 2 ≠ mapa 1 na MESMA dificuldade
    const m1 = generateLevelData({ width: 120, height: 12, seed: 1, difficulty: 1 });
    const m2 = generateLevelData({ width: 120, height: 12, seed: 2, difficulty: 1 });
    expect(m2.tiles).not.toEqual(m1.tiles);
    expect(m2.enemySpawns).not.toEqual(m1.enemySpawns);
  });
});

describe("generateLevel — wrapper kaplay", () => {
  it("render() desenha um tile por entry e devolve os mesmos dados puros", () => {
    const calls: Array<Array<unknown>> = [];
    const k = {
      add: (comps: unknown[]) => {
        calls.push(comps);
        return {};
      },
      pos: () => ({}),
      rect: () => ({}),
      color: () => ({}),
      area: () => ({}),
      body: () => ({}),
      z: () => ({}),
    } as never;

    const spec: LevelSpec = { width: 120, height: 12, seed: 42 };
    const pure = generateLevelData(spec);
    const level = generateLevel(k, spec);

    expect(level.tiles).toEqual(pure.tiles);
    expect(level.playerSpawn).toEqual(pure.playerSpawn);
    expect(level.enemySpawns).toEqual(pure.enemySpawns);
    expect(level.coinSpawns).toEqual(pure.coinSpawns);

    level.render();
    expect(calls.length).toBe(pure.tiles.length);
    for (const comps of calls) {
      expect(comps[0]).toBe("solid");
    }
  });

  it("propaga RangeError de spec inválido", () => {
    const k = {} as never;
    expect(() => generateLevel(k, { width: 4, height: 4, seed: 1 })).toThrow(RangeError);
  });
});

// ===== Moedas no gerador de fase (espelho do Level.CoinSpawns do servidor) =====
// As regras abaixo são a porta TS do passo 5 do level.go do servidor Go
// (apps/api/internal/game/level.go) + as constantes de coins.go
// (CoinStartCol/CoinColumnStep). Os goldens foram capturados rodando
// GenerateLevel do apps/api (go run ./cmd/dumpcoins) — se quebrarem, client
// e servidor divergiram na seed compartilhada.

describe("generateLevelData — moedas douradas (paridade com o servidor Go)", () => {
  // CoinSpawns (x,y) em ordem canônica para 120x12, capturados do Go.
  const goldens: Array<{ seed: number; coins: string }> = [
    {
      seed: 0,
      coins:
        "8,10;11,8;12,10;16,10;19,7;20,10;24,10;32,10;40,10;43,6;43,8;44,10;47,7;48,10;52,10;56,10;59,6;60,10;68,10;75,7;76,10;79,6;79,8;80,10;84,10;88,10;92,10;95,6;96,10;104,10;107,7;112,10;115,7;116,10",
    },
    {
      seed: 42,
      coins:
        "3,7;7,7;8,10;12,10;16,10;20,10;23,6;24,10;27,8;32,10;35,7;40,10;44,10;48,10;52,10;56,10;59,8;60,10;68,10;71,7;76,10;79,6;79,8;80,10;84,10;88,10;92,10;95,8;96,10;104,10;111,8;112,10;116,10",
    },
    {
      seed: 123456789,
      coins:
        "8,8;8,10;12,10;16,10;20,7;20,10;24,10;28,7;32,6;32,10;36,8;40,10;44,8;44,10;48,6;48,10;52,10;56,6;56,10;60,10;68,6;68,8;68,10;76,10;80,10;84,10;88,10;92,6;92,8;92,10;96,7;96,10;100,6;104,7;104,10;108,7;112,10;116,10",
    },
    {
      seed: 4294967295,
      coins:
        "5,8;8,10;12,10;16,10;17,8;20,10;21,6;24,10;32,10;33,6;40,10;41,6;44,10;48,10;49,7;52,10;53,8;56,10;60,10;65,7;68,10;76,10;80,10;81,7;84,10;88,10;89,6;92,10;96,10;104,10;105,8;109,6;112,10;113,6;116,10;117,6",
    },
  ];

  it.each(goldens)("seed $seed gera as MESMAS moedas que o servidor Go", ({ seed, coins }) => {
    const d = generateLevelData({ width: 120, height: 12, seed });
    const got = d.coinSpawns.map((c) => `${c.x},${c.y}`).join(";");
    expect(got).toBe(coins);
  });
});

describe("generateLevelData — moedas presentes em toda fase", () => {
  // Espelho do TestLevelCoinSpawnsPresentesEmTodaFase do servidor Go: cada
  // fase carrega um conjunto de moedas coletáveis; reconstrói o conjunto
  // exato esperado pela regra do gerador (chão + topos expostos com o passo
  // deslocado pela seed) e confere igualdade + nunca enterrada/sobre lacuna.
  it("toda fase tem moedas: chão + topos expostos, sem faltar/sobrar", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const ctx = `${s.name} seed ${seed}`;
        const spec = specOf(s, seed);
        const d = generateLevelData(spec);
        const groundY = spec.height - 2;
        const solid = new Set(d.tiles.map((t) => `${t.x},${t.y}`));
        const has = (x: number, y: number) => solid.has(`${x},${y}`);

        const coinOffset = Math.floor(mulberry32(seed ^ CoinSeedXor)() * CoinColumnStep);
        const want = new Set<string>();
        // a) chão: fileira do chão, regra do servidor (paridade exata)
        for (let tx = 0; tx < spec.width; tx++) {
          if (tx >= CoinStartCol && tx % CoinColumnStep === 0 && has(tx, groundY)) {
            want.add(`${tx},${groundY}`);
          }
        }
        // b) plataformas: topo exposto acima do chão, passo deslocado
        for (const t of d.tiles) {
          if (t.y >= groundY || has(t.x, t.y - 1)) continue;
          if ((t.x + coinOffset) % CoinColumnStep === 0) {
            want.add(`${t.x},${t.y}`);
          }
        }
        expect(want.size, ctx).toBeGreaterThan(0);

        const got = new Set(d.coinSpawns.map((c) => `${c.x},${c.y}`));
        expect(got.size, ctx).toBe(d.coinSpawns.length); // sem duplicatas
        for (const c of d.coinSpawns) {
          expect(c.y, ctx).toBeLessThanOrEqual(groundY); // nada abaixo do chão
          expect(has(c.x, c.y), `${ctx} moeda ${c.x},${c.y} sem tile sólido`).toBe(true);
          expect(has(c.x, c.y - 1), `${ctx} moeda ${c.x},${c.y} enterrada`).toBe(false);
        }
        expect(got.size, ctx).toBe(want.size);
        for (const k of want) expect(got.has(k), `${ctx} faltou moeda em ${k}`).toBe(true);
        for (const k of got) expect(want.has(k), `${ctx} moeda extra em ${k}`).toBe(true);
      }
    }
  });

  it("determinístico: mesma seed ⇒ exatamente as mesmas moedas", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const spec = specOf(s, seed);
        const a = generateLevelData(spec).coinSpawns;
        const b = generateLevelData(spec).coinSpawns;
        expect(b).toEqual(a);
      }
    }
  });

  it("regra do chão: exatamente colunas sólidas com x>=6 e x%4==0", () => {
    // Espelho do TestLevelCoinSpawnsRegraChao: paridade da fileira do chão
    // com o servidor — nem mais, nem menos.
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const ctx = `${s.name} seed ${seed}`;
        const spec = specOf(s, seed);
        const d = generateLevelData(spec);
        const groundY = spec.height - 2;
        const solid = new Set(d.tiles.map((t) => `${t.x},${t.y}`));
        const want = new Set<string>();
        for (let tx = 0; tx < spec.width; tx++) {
          if (tx >= CoinStartCol && tx % CoinColumnStep === 0 && solid.has(`${tx},${groundY}`)) {
            want.add(`${tx},${groundY}`);
          }
        }
        const got = new Set(
          d.coinSpawns.filter((c) => c.y === groundY).map((c) => `${c.x},${c.y}`)
        );
        expect(got.size, ctx).toBe(want.size);
        for (const k of want) expect(got.has(k), `${ctx} faltou moeda de chão em ${k}`).toBe(true);
      }
    }
  });

  it("scatter seed-dependente e esparso por fileira", () => {
    // Espelho do TestLevelCoinSpawnsScatterSeedDependente: fases distintas
    // produzem conjuntos de moedas distintos (spec do client, com
    // plataformas suficientes) e, na mesma fileira, colunas separadas por
    // múltiplos de CoinColumnStep (nunca duas moedas coladas).
    const sigs = new Set<string>();
    for (const seed of testSeeds) {
      const d = generateLevelData({ width: 120, height: 12, seed });
      sigs.add(d.coinSpawns.map((c) => `${c.x},${c.y}`).join(";"));
    }
    expect(sigs.size).toBeGreaterThanOrEqual(3);

    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const d = generateLevelData(specOf(s, seed));
        const byRow = new Map<number, number[]>();
        for (const c of d.coinSpawns) {
          const xs = byRow.get(c.y) ?? [];
          xs.push(c.x);
          byRow.set(c.y, xs);
        }
        for (const [row, xs] of byRow) {
          xs.sort((a, b) => a - b);
          for (let i = 1; i < xs.length; i++) {
            expect(
              (xs[i] - xs[i - 1]) % CoinColumnStep,
              `seed ${seed} fileira ${row} moedas em ${xs[i - 1]} e ${xs[i]} violam o passo`
            ).toBe(0);
          }
        }
      }
    }
  });
});

// ===== Power-ups: paridade com o servidor Go (level.go passo 6) =====

describe("generateLevelData — powerUpSpawns paridade com o servidor Go", () => {
  // Golden capturados do servidor Go (GenerateLevel, 120x12) via teste
  // temporário zz_dump_powerup_test.go: mesmas posições (tile) e TIPOS.
  const goldens: Array<{ seed: number; want: string }> = [
    { seed: 0, want: "count=1 [42,6,tiro_triplo]" },
    { seed: 1, want: "count=2 [29,6,tiro_triplo] [112,6,escudo]" },
    { seed: 2, want: "count=1 [63,8,escudo]" },
    { seed: 42, want: "count=3 [79,6,tiro_triplo] [79,8,vida] [80,6,escudo]" },
    { seed: 123456789, want: "count=2 [8,8,vida] [106,7,escudo]" },
    { seed: 4294967295, want: "count=2 [43,6,vida] [81,7,escudo]" },
  ];

  it.each(goldens)("seed $seed produz os MESMOS power-ups que o servidor Go", ({ seed, want }) => {
    const d = generateLevelData({ width: 120, height: 12, seed });
    const got =
      `count=${d.powerUpSpawns.length}` +
      d.powerUpSpawns.map((p) => ` [${p.x},${p.y},${p.kind}]`).join("");
    expect(got).toBe(want);
  });

  it("limite: no máximo POWERUP_MAX_PER_PHASE por fase", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const d = generateLevelData(specOf(s, seed));
        expect(d.powerUpSpawns.length, `${s.name} seed ${seed}`).toBeLessThanOrEqual(
          POWERUP_MAX_PER_PHASE
        );
        expect(d.powerUpSpawns.length).toBeGreaterThan(0);
      }
    }
  });

  it("no máximo UM de cada tipo por fase", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const d = generateLevelData(specOf(s, seed));
        const kinds = d.powerUpSpawns.map((p) => p.kind);
        expect(new Set(kinds).size, `${s.name} seed ${seed}`).toBe(kinds.length);
      }
    }
  });

  it("nunca enterrado: sempre em topo exposto (ou chão no fallback)", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const ctx = `${s.name} seed ${seed}`;
        const spec = specOf(s, seed);
        const d = generateLevelData(spec);
        const groundY = spec.height - 2;
        const solid = new Set(d.tiles.map((t) => `${t.x},${t.y}`));
        const has = (x: number, y: number) => solid.has(`${x},${y}`);
        const hasPlatform = d.tiles.some((t) => t.y < groundY);
        for (const p of d.powerUpSpawns) {
          // Acima do chão: topo exposto (nada sólido em cima).
          if (p.y < groundY) {
            expect(has(p.x, p.y), `${ctx} power-up sem tile sólido`).toBe(true);
            expect(has(p.x, p.y - 1), `${ctx} power-up ${p.x},${p.y} enterrado`).toBe(false);
          } else if (!hasPlatform) {
            // Fallback: chão sólido com nada em cima.
            expect(p.y, `${ctx} fallback deve usar o chão`).toBe(groundY);
            expect(has(p.x, p.y), `${ctx} fallback sem tile sólido`).toBe(true);
          }
        }
      }
    }
  });

  it("determinístico: mesma seed ⇒ exatamente os mesmos power-ups", () => {
    for (const s of testSpecs) {
      for (const seed of testSeeds) {
        const spec = specOf(s, seed);
        const a = generateLevelData(spec).powerUpSpawns;
        const b = generateLevelData(spec).powerUpSpawns;
        expect(b).toEqual(a);
      }
    }
  });
});
