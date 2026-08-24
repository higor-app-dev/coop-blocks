import type { KaplayCtx } from "kaplay";

/**
 * Geração automática de fases estilo Mario:
 * chão com buracos, plataformas suspensas e spawns de inimigos.
 */
export interface LevelSpec {
  width: number; // tiles horizontais
  height: number; // tiles verticais
  seed: number;
}

export interface LevelData {
  tiles: Array<{ x: number; y: number }>; // tiles "solid"
  playerSpawn: { x: number; y: number };
  enemySpawns: Array<{ x: number; y: number }>;
  render(): void;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateLevel(k: KaplayCtx, spec: LevelSpec): LevelData {
  const { add, pos, rect, color, area, body, z } = k;
  const rnd = mulberry32(spec.seed);
  const TILE = 48;

  const solid: Array<{ x: number; y: number }> = [];
  const enemySpawns: Array<{ x: number; y: number }> = [];

  // Chão: linha base com buracos (gap de 2-3 tiles a cada ~10)
  const groundY = spec.height - 2;
  for (let tx = 0; tx < spec.width; tx++) {
    // buraco?
    const gap = tx % 9 === 0 || tx % 9 === 1;
    if (!gap) {
      solid.push({ x: tx, y: groundY });
      solid.push({ x: tx, y: groundY + 1 });
    }
  }

  // Plataformas suspensas aleatórias
  for (let i = 0; i < Math.floor(spec.width / 6); i++) {
    const px = Math.floor(rnd() * (spec.width - 4)) + 2;
    const py = groundY - 2 - Math.floor(rnd() * 3);
    const len = 2 + Math.floor(rnd() * 3);
    for (let l = 0; l < len; l++) {
      if (px + l < spec.width) solid.push({ x: px + l, y: py });
    }
  }

  // Spawns de inimigos: sobre o chão, longe do spawn do player
  for (let tx = 12; tx < spec.width - 1; tx += 5 + Math.floor(rnd() * 4)) {
    const onGround = solid.some((t) => t.x === tx && t.y === groundY);
    if (onGround) {
      enemySpawns.push({ x: tx * TILE, y: groundY * TILE - 30 });
    }
  }

  const playerSpawn = { x: 2 * TILE, y: groundY * TILE - 42 };

  return {
    tiles: solid,
    playerSpawn,
    enemySpawns,
    render() {
      for (const t of solid) {
        add([
          "solid",
          pos(t.x * TILE, t.y * TILE),
          rect(TILE, TILE),
          color(92, 120, 255),
          area(),
          body({ isStatic: true }),
          z(1),
        ]);
      }
    },
  };
}
