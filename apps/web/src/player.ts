import type { GameObj, KAPLAYCtx } from "kaplay";

/**
 * Cria o jogador local: pulo, tiro e HP (100 total).
 */
export interface PlayerOpts {
  pos: { x: number; y: number };
  maxHp: number;
  onHpChange?: (hp: number) => void;
}

/** Tipo do objeto do jogador: GameObj kaplay + estado/métodos custom. */
export interface PlayerObject extends GameObj {
  hp: number;
  speed: number;
  facing: number; // 1 = direita, -1 = esquerda
  // movePlayer(dir) é o atalho do player; move(x, y) delega para o GameObj.
  // (Nomes sem colisão: o componente `pos` do kaplay já define move/moveBy/moveTo;
  // idem jump vs body().jump.)
  movePlayer(dir: number): void;
  jumpPlayer(force?: number): void;
  shoot(): void;
  /**
   * Tiro triplo (power-up): 3 projéteis paralelos com lanes -6/0/+6 — espelho
   * do servidor (main.go OnShoot, TripleShotActive). Visual puro: o dano real
   * é dos projéteis autoritativos do servidor.
   */
  shootTriple(): void;
  takeDamage(n: number): void;
  isGrounded(): boolean;
}

/**
 * Comportamento custom injetado como componente no objeto do jogador.
 * O `this` é tipado explicitamente (parâmetro de tipo é apagado em runtime)
 * para expor os campos/métodos do jogador dentro dos handlers.
 */
interface PlayerBehavior {
  hp: number;
  speed: number;
  facing: number;
  movePlayer(this: PlayerObject, dir: number): void;
  jumpPlayer(this: PlayerObject, force?: number): void;
  shoot(this: PlayerObject): void;
  shootTriple(this: PlayerObject): void;
  /** Dispara um projétil com deslocamento vertical `dy` (lane do tiro triplo). */
  fireBullet(this: PlayerObject, dy: number): void;
  takeDamage(this: PlayerObject, n: number): void;
}

export function createPlayer(k: KAPLAYCtx, opts: PlayerOpts): PlayerObject {
  const { add, pos, rect, color, area, body, scale, z, destroy } = k;

  const behavior: PlayerBehavior = {
    hp: opts.maxHp,
    speed: 320,
    facing: 1, // 1 = direita, -1 = esquerda
    movePlayer(dir: number) {
      if (dir !== 0) this.facing = dir;
      this.move(dir * this.speed, 0);
    },
    jumpPlayer(force?: number) {
      if (this.isGrounded()) this.jump(force ?? 520);
    },
    /**
     * Dispara um projétil amigável na direção do facing, com deslocamento
     * vertical `dy` (lanes do tiro triplo — 0 no tiro simples).
     */
    fireBullet(this: PlayerObject, dy: number): void {
      const b = add([
        "bullet",
        pos(this.pos.x + this.facing * 24, this.pos.y - 10 + dy),
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
    shoot() {
      this.fireBullet(0);
    },
    shootTriple() {
      // Espelho do servidor (main.go OnShoot + TripleShotActive): 3 projéteis
      // paralelos com lanes -6/0/+6 enquanto o TIRO TRIPLO estiver ativo.
      // Visual apenas — o dano vem dos projéteis autoritativos do servidor.
      this.fireBullet(-6);
      this.fireBullet(0);
      this.fireBullet(6);
    },
    takeDamage(n: number) {
      this.hp -= n;
      opts.onHpChange?.(this.hp);
      if (this.hp <= 0) {
        this.trigger("death");
        destroy(this);
      }
    },
  };

  const obj = add([
    "player",
    pos(opts.pos.x, opts.pos.y),
    rect(28, 40),
    color(66, 200, 245),
    area(),
    body(),
    scale(1),
    z(10),
    behavior,
  ]) as unknown as PlayerObject;

  return obj;
}
