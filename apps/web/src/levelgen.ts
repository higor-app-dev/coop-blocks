import type { KAPLAYCtx } from "kaplay";

/**
 * Geração automática de fases estilo Mario:
 * chão com buracos, plataformas suspensas e spawns de inimigos.
 *
 * O núcleo de geração (`generateLevelData`) é 100% puro e determinístico por
 * seed — espelho fiel do gerador do servidor (apps/api/internal/game/level.go,
 * porta Go deste mesmo arquivo). A feature planejada de "seed compartilhada de
 * fase" exige que servidor e client gerem EXATAMENTE a mesma fase a partir da
 * mesma seed; testes golden em levelgen.test.ts travam essa paridade.
 *
 * Divergência deliberada (alinhada ao servidor): as últimas GapWidth colunas
 * são sempre solo sólido ("fim standable") — o client antigo podia terminar a
 * fase em um buraco; o servidor não.
 */

export interface LevelSpec {
  width: number; // tiles horizontais
  height: number; // tiles verticais
  seed: number; // semente do PRNG mulberry32 (coerção uint32 via >>> 0)
  /**
   * Fase atual (1-based) — dificuldade progressiva do singleplayer local:
   * fases maiores têm plataformas menores e spawns de inimigos mais densos.
   * Default 1 mantém a paridade EXATA com o gerador do servidor Go (golden
   * tests) — o escalonamento só começa a partir da fase 2.
   */
  difficulty?: number;
}

export interface Tile {
  x: number; // coluna (tile)
  y: number; // fileira (tile; y cresce para baixo)
}

export interface LevelData {
  tiles: Tile[]; // tiles "solid" (coordenadas de tile, ordenados, sem duplicatas)
  playerSpawn: { x: number; y: number }; // pixels
  enemySpawns: Array<{ x: number; y: number }>; // pixels
  /**
   * Posições de moedas da fase (chão + topos expostos de plataforma) em
   * coordenadas de tile, ordenadas por (x, y) — espelho do Level.CoinSpawns
   * do servidor Go (apps/api/internal/game/level.go, passo 5). A conversão
   * tile→pixels fica na camada de moedas (coins.ts, levelCoin).
   */
  coinSpawns: Tile[];
  render(): void;
}

// Constantes de layout (alinhadas ao servidor Go).
export const TILE = 48; // tamanho do tile em pixels
export const GapPeriod = 9; // período das lacunas do chão (tx % 9)
export const GapWidth = 2; // largura de cada lacuna, em tiles (tx%9 ∈ {0,1})
export const PlayerSpawnX = 2; // coluna do spawn do jogador
export const MinSpecWidth = GapPeriod; // largura mínima aceita (client usa 120)
export const MinSpecHeight = 6; // altura mínima aceita (client usa 12)

// Regras de moedas no gerador de fase (mesmas do servidor Go — level.go
// usa as constantes CoinStartCol/CoinColumnStep de coins.go).
export const CoinStartCol = 6; // primeira coluna de moedas do chão (tx >= 6)
export const CoinColumnStep = 4; // moedas a cada N colunas (tx % 4 === 0)
// XOR aplicado à seed para a stream própria das moedas (scatter das
// plataformas) — NÃO altera a ordem de consumo do layout (mesma constante
// 0x9E3779B9 do servidor Go em level.go passo 5).
export const CoinSeedXor = 0x9e3779b9;

// Largura do hitbox do jogador em pixels — mesma do servidor
// (apps/api/internal/game/player.go: PlayerWidth = 28.0).
export const PLAYER_WIDTH = 28;

// Dificuldade progressiva (singleplayer local, divergência deliberada do
// espelho Go que NÃO escala por fase): a partir da fase 2, cada fase
// - encolhe plataformas suspensas em até MaxPlatformShrink tiles; e
// - aproxima os spawns de inimigos em até MaxEnemyDensity tiles (mais
//   inimigos na mesma extensão de mapa).
export const MaxPlatformShrink = 2;
export const MaxEnemyDensity = 4;

/**
 * Dificuldade efetiva da fase: inteiro >= 1 (spec.difficulty ausente/ inválido
 * → 1, que reproduz o gerador do servidor bit-a-bit).
 */
export function clampDifficulty(difficulty?: number): number {
  const d = Math.floor(difficulty ?? 1);
  return Number.isFinite(d) && d >= 1 ? d : 1;
}

/**
 * A fase terminou quando a borda direita do hitbox do jogador (largura
 * PLAYER_WIDTH) cruza a primeira coluna do fim (widthTiles-1) — espelho do
 * Level.Finished do servidor Go (apps/api/internal/game/level.go), que usa o
 * mesmo PlayerWidth. Chegar ao fim do mapa é o gatilho da transição de fase.
 */
export function isLevelFinished(widthTiles: number, playerX: number): boolean {
  return playerX + PLAYER_WIDTH >= (widthTiles - 1) * TILE;
}

/**
 * PRNG mulberry32 — porta exata do gerador do servidor. Duas instâncias com a
 * mesma seed produzem a mesma sequência em [0, 1), bit-a-bit igual à do Go
 * (verificado por testes golden).
 */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validateSpec(spec: LevelSpec): void {
  const ok =
    Number.isInteger(spec.width) &&
    Number.isInteger(spec.height) &&
    spec.width >= MinSpecWidth &&
    spec.height >= MinSpecHeight;
  if (!ok) {
    throw new RangeError(
      `spec de fase inválido: width=${spec.width} height=${spec.height} (mínimo ${MinSpecWidth}x${MinSpecHeight})`
    );
  }
}

/**
 * Núcleo puro da geração de fase: sem dependência de kaplay, determinístico
 * por seed. Retorna tiles sólidos (coordenadas de tile, ordenados e sem
 * duplicatas), spawn do jogador e spawns de inimigos (em pixels, como o
 * cliente consome). Lança RangeError para specs fora do grid (width < 9 ou
 * height < 6), espelhando a validação do servidor.
 */
export function generateLevelData(spec: LevelSpec): {
  tiles: Tile[];
  playerSpawn: { x: number; y: number };
  enemySpawns: Array<{ x: number; y: number }>;
  coinSpawns: Tile[];
} {
  validateSpec(spec);

  const rnd = mulberry32(spec.seed);
  const groundY = spec.height - 2;
  // Dificuldade progressiva: fase 1 = paridade exata com o servidor Go
  // (shrinks zerados). A partir da fase 2 as plataformas encolhem e os spawns
  // de inimigos ficam mais próximos (mais inimigos). Nenhum consumo EXTRA de
  // RNG — os ajustes são funções puras do mesmo valor sorteado, então o
  // determinismo por (seed, dificuldade) e a paridade por seed continuam.
  const difficulty = clampDifficulty(spec.difficulty);
  const platformShrink = Math.min(MaxPlatformShrink, difficulty - 1);
  const enemyDensity = Math.min(MaxEnemyDensity, difficulty - 1);

  const solid = new Set<string>();
  const tileKey = (x: number, y: number) => `${x},${y}`;
  const addTile = (x: number, y: number) => {
    if (x >= 0 && x < spec.width && y >= 0 && y < spec.height) {
      solid.add(tileKey(x, y));
    }
  };
  const hasTile = (x: number, y: number) => solid.has(tileKey(x, y));

  // 1) Chão: linha base com buracos (gap de GapWidth tiles a cada GapPeriod).
  for (let tx = 0; tx < spec.width; tx++) {
    if (tx % GapPeriod === 0 || tx % GapPeriod === 1) continue;
    addTile(tx, groundY);
    addTile(tx, groundY + 1);
  }

  // 2) Plataformas suspensas aleatórias (mesma ordem de consumo do RNG do Go).
  //    Fases maiores encolhem o comprimento sorteado (min 1 tile).
  for (let i = 0; i < Math.floor(spec.width / 6); i++) {
    const px = Math.floor(rnd() * (spec.width - 4)) + 2;
    const py = groundY - 2 - Math.floor(rnd() * 3);
    const len = Math.max(1, 2 + Math.floor(rnd() * 3) - platformShrink);
    for (let l = 0; l < len; l++) {
      addTile(px + l, py);
    }
  }

  // 3) Spawns de inimigos: sobre o chão, longe do spawn do jogador.
  //    Fases maiores reduzem o passo entre spawns (mais inimigos no mapa).
  const enemySpawns: Array<{ x: number; y: number }> = [];
  for (let tx = 12; tx < spec.width - 1; tx += Math.max(2, 5 + Math.floor(rnd() * 4) - enemyDensity)) {
    if (hasTile(tx, groundY)) {
      enemySpawns.push({ x: tx * TILE, y: groundY * TILE - 30 });
    }
  }

  // 4) Garantia de "fim standable" (alinhada ao servidor Go): as últimas
  //    GapWidth colunas são sempre solo sólido.
  for (let tx = spec.width - GapWidth; tx < spec.width; tx++) {
    if (!hasTile(tx, groundY)) {
      addTile(tx, groundY);
      addTile(tx, groundY + 1);
    }
  }

  // Saída canônica: tiles ordenados e sem duplicatas (mesma forma do Go).
  const tiles: Tile[] = [...solid]
    .map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    })
    .sort((a, b) => a.x - b.x || a.y - b.y);

  // 5) Moedas: posições determinísticas da fase — espelho fiel do servidor
  //    Go (Level.CoinSpawns, level.go passo 5). Regras:
  //      - chão: coluna sólida da fileira do chão com x >= CoinStartCol e
  //        x % CoinColumnStep == 0 — regra histórica do client, paridade
  //        exata com o servidor, garantia de moedas coletáveis andando em
  //        TODA fase;
  //      - plataformas: topo exposto (tile sólido acima do chão com espaço
  //        livre em cima — nunca enterrada em parede), selecionado com um
  //        deslocamento sorteado da seed (coinOffset): a mesma coluna de
  //        plataforma pode ter moeda numa fase e não em outra — scatter
  //        seed-dependente. A stream é própria (mulberry32(seed ^
  //        CoinSeedXor)) e NÃO altera a ordem de consumo do layout;
  //      - saída ordenada por (x, y), como o servidor.
  const coinSpawns: Tile[] = [];
  const coinRnd = mulberry32(spec.seed ^ CoinSeedXor);
  const coinOffset = Math.floor(coinRnd() * CoinColumnStep);
  // a) Chão: fileira do chão, mesmo critério do servidor (paridade exata).
  for (let tx = 0; tx < spec.width; tx++) {
    if (tx >= CoinStartCol && tx % CoinColumnStep === 0 && hasTile(tx, groundY)) {
      coinSpawns.push({ x: tx, y: groundY });
    }
  }
  // b) Plataformas: superfícies expostas acima do chão (tile sólido sem
  //    sólido em cima), com o passo deslocado pela seed.
  for (const t of tiles) {
    if (t.y >= groundY || hasTile(t.x, t.y - 1)) {
      continue; // chão já coberto em (a); tile com sólido em cima = enterrado
    }
    if ((t.x + coinOffset) % CoinColumnStep === 0) {
      coinSpawns.push(t);
    }
  }
  coinSpawns.sort((a, b) => a.x - b.x || a.y - b.y);

  const playerSpawn = { x: PlayerSpawnX * TILE, y: groundY * TILE - 42 };

  return { tiles, playerSpawn, enemySpawns, coinSpawns };
}

/**
 * Gera a fase e devolve o objeto com `render()`, que desenha os tiles no
 * contexto kaplay. Wrapper fino sobre `generateLevelData` (a geração em si é
 * pura e testável sem kaplay).
 */
export function generateLevel(k: KAPLAYCtx, spec: LevelSpec): LevelData {
  const { add, pos, rect, color, area, body, z } = k;
  const { tiles, playerSpawn, enemySpawns, coinSpawns } = generateLevelData(spec);

  return {
    tiles,
    playerSpawn,
    enemySpawns,
    coinSpawns,
    render() {
      for (const t of tiles) {
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
