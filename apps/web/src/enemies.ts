import type { KaplayCtx } from "kaplay";

/**
 * Inimigo de contato: ao relar no player, causa `damage` de HP.
 */
export interface EnemyOpts {
  pos: { x: number; y: number };
  damage: number;
  maxHp: number;
}

export function spawnEnemy(k: KaplayCtx, opts: EnemyOpts) {
  const { add, pos, rect, color, area, body, z, onUpdate } = k;

  const e = add([
    "enemy",
    pos(opts.pos.x, opts.pos.y),
    rect(30, 30),
    color(235, 70, 70),
    area(),
    body(),
    z(5),
    {
      damage: opts.damage,
      hp: opts.maxHp,
      dir: 1,
      speed: 60,
    },
  ]);

  // Patrulha: anda de um lado para o outro
  onUpdate(() => {
    e.move(e.dir * e.speed, 0);
  });

  // Inverte direção ao bater em paredes
  e.onCollide("solid", () => {
    e.dir *= -1;
  });

  return e;
}
