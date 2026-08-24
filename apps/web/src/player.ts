import type { KaplayCtx } from "kaplay";

/**
 * Cria o jogador local: pulo, tiro e HP (100 total).
 */
export interface PlayerOpts {
  pos: { x: number; y: number };
  maxHp: number;
  onHpChange?: (hp: number) => void;
}

export function createPlayer(k: KaplayCtx, opts: PlayerOpts) {
  const { add, pos, rect, color, area, body, scale, z, onKeyPress, onUpdate, destroy, wait } = k;

  const obj = add([
    "player",
    pos(opts.pos.x, opts.pos.y),
    rect(28, 40),
    color(66, 200, 245),
    area(),
    body(),
    scale(1),
    z(10),
    {
      hp: opts.maxHp,
      speed: 320,
      facing: 1, // 1 = direita, -1 = esquerda
      move(dir: number) {
        if (dir !== 0) this.facing = dir;
        this.move(dir * this.speed, 0);
      },
      jump() {
        if (this.isGrounded()) this.jump(520);
      },
      shoot() {
        const b = add([
          "bullet",
          pos(this.pos.x + this.facing * 24, this.pos.y - 10),
          rect(12, 5),
          color(255, 220, 80),
          area(),
          z(9),
          { vel: this.facing * 560, damage: 25 },
        ]);
        b.onUpdate(() => {
          b.move(b.vel, 0);
          if (b.pos.x < 0 || b.pos.x > 9600) destroy(b);
        });
      },
      takeDamage(n: number) {
        this.hp -= n;
        opts.onHpChange?.(this.hp);
        if (this.hp <= 0) {
          this.trigger("death");
          destroy(this);
        }
      },
    },
  ]);

  return obj;
}
