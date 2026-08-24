package game

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"testing"
)

// testSeeds é o conjunto fixo de sementes usado pelos testes table-driven.
// Inclui 0, seeds adjacentes (para pegar dependência de estado do RNG), seeds
// grandes e os limites uint32.
var testSeeds = []uint32{
	0, 1, 2, 3, 4, 7, 42, 99, 1337, 2024, 65536, 999983, 123456789,
	2147483647, 4294967294, 4294967295,
}

// testSpecs são dimensões de fase exercitadas: a do client (120×12) e
// variações (estreita, larga, mínima).
var testSpecs = []struct {
	name   string
	width  int
	height int
}{
	{"client_120x12", 120, 12},
	{"estreita_30x8", 30, 8},
	{"larga_240x16", 240, 16},
	{"media_60x10", 60, 10},
	{"minima_9x6", 9, 6},
}

// genLevel gera a fase para o spec/seed dados, falhando o teste em erro.
func genLevel(t *testing.T, width, height int, seed uint32) Level {
	t.Helper()
	l, err := GenerateLevel(LevelSpec{Width: width, Height: height, Seed: seed})
	if err != nil {
		t.Fatalf("GenerateLevel(%dx%d, seed=%d): %v", width, height, seed, err)
	}
	return l
}

// TestLevelMulberry32Golden trava a porta Go do PRNG ao client (levelgen.ts):
// os mesmos valores que o mulberry32 do TypeScript produz para as mesmas
// seeds — determinismo cross-implementação, base da feature "seed
// compartilhada" entre servidor e client.
func TestLevelMulberry32Golden(t *testing.T) {
	tests := []struct {
		seed uint32
		want [4]float64
	}{
		{0, [4]float64{0.266429209, 0.000329746, 0.223272027, 0.146202148}},
		{1, [4]float64{0.627073941, 0.002735721, 0.527447040, 0.981050967}},
		{42, [4]float64{0.601103752, 0.448290559, 0.852465793, 0.669734041}},
		{4294967295, [4]float64{0.896422614, 0.189478257, 0.715652678, 0.944059909}},
	}
	const eps = 1e-8 // valores golden vêm de toFixed(9) no node
	for _, tt := range tests {
		t.Run(fmt.Sprintf("seed_%d", tt.seed), func(t *testing.T) {
			r := newMulberry32(tt.seed)
			for i, want := range tt.want {
				got := r()
				if math.Abs(got-want) > eps {
					t.Errorf("draw %d = %.9f, want %.9f", i, got, want)
				}
			}
		})
	}
}

// TestLevelDeterminismoMesmaSeed verifica que a MESMA seed gera EXATAMENTE a
// mesma fase: mesmos tiles, mesmo spawn, mesmos inimigos, na mesma ordem
// canônica. Gera duas vezes e compara a assinatura completa.
func TestLevelDeterminismoMesmaSeed(t *testing.T) {
	for _, spec := range testSpecs {
		for _, seed := range testSeeds {
			name := fmt.Sprintf("%s_seed_%d", spec.name, seed)
			t.Run(name, func(t *testing.T) {
				l1 := genLevel(t, spec.width, spec.height, seed)
				l2 := genLevel(t, spec.width, spec.height, seed)

				if l1.Signature() != l2.Signature() {
					t.Fatalf("mesma seed gerou fases diferentes:\n%s\n%s",
						l1.Signature(), l2.Signature())
				}
				// conferência direta dos campos (além da assinatura)
				if len(l1.Tiles) != len(l2.Tiles) {
					t.Fatalf("len(Tiles) = %d vs %d", len(l1.Tiles), len(l2.Tiles))
				}
				if l1.PlayerSpawn != l2.PlayerSpawn {
					t.Errorf("PlayerSpawn = %+v vs %+v", l1.PlayerSpawn, l2.PlayerSpawn)
				}
				if len(l1.EnemySpawns) != len(l2.EnemySpawns) {
					t.Errorf("len(EnemySpawns) = %d vs %d", len(l1.EnemySpawns), len(l2.EnemySpawns))
				}
			})
		}
	}
}

// TestLevelSeedsDiferentes verifica que seeds diferentes geram saídas
// diferentes (nenhuma colisão de assinatura no conjunto fixo de seeds).
//
// Nota: o spec mínimo (9×6) é excluído de propósito — com apenas 1 plataforma
// (3 sorteios do RNG), o espaço de layouts é pequeno (px×py×len = 5×3×3 = 45
// combinações) e colisões entre seeds são esperadas (princípio da casa dos
// pombos). A propriedade "seeds distintas ⇒ fases distintas" vale para fases
// com entropia suficiente (o client usa 120×12, com ~80 sorteios).
func TestLevelSeedsDiferentes(t *testing.T) {
	for _, spec := range testSpecs {
		if spec.width < GapPeriod*2 {
			continue // spec mínimo: poucos layouts, colisões esperadas
		}
		t.Run(spec.name, func(t *testing.T) {
			sigBySeed := make(map[string]uint32, len(testSeeds))
			for _, seed := range testSeeds {
				l := genLevel(t, spec.width, spec.height, seed)
				sig := l.Signature()
				if prev, ok := sigBySeed[sig]; ok {
					t.Errorf("seed %d e seed %d geraram a MESMA fase (%s)",
						seed, prev, spec.name)
				}
				sigBySeed[sig] = seed
			}
		})
	}
}

// TestLevelTraversable verifica que TODA fase gerada é atravessável: existe
// caminho válido do spawn (coluna 2) até o fim (coluna Width-1 no chão), com
// spawn e fim sobre solo sólido. É o critério de aceite central da task.
func TestLevelTraversable(t *testing.T) {
	for _, spec := range testSpecs {
		for _, seed := range testSeeds {
			name := fmt.Sprintf("%s_seed_%d", spec.name, seed)
			t.Run(name, func(t *testing.T) {
				l := genLevel(t, spec.width, spec.height, seed)

				if !l.Solid(l.PlayerSpawn.X, l.PlayerSpawn.Y) {
					t.Fatalf("spawn %+v não está sobre solo sólido", l.PlayerSpawn)
				}
				if !l.Solid(l.Spec.Width-1, l.GroundY) {
					t.Fatalf("fim (%d, %d) não está sobre solo sólido", l.Spec.Width-1, l.GroundY)
				}
				if !l.Traversable() {
					t.Fatalf("fase não atravessável: seed=%d, %dx%d", seed, spec.width, spec.height)
				}
			})
		}
	}
}

// TestLevelEstrutura valida invariantes estruturais do layout:
//   - spawn e fim da fase sobre solo sólido (fim garantido pelo patch);
//   - lacunas do chão com no máximo GapWidth tiles (puláveis);
//   - fileira de clearance acima do chão sempre vazia — nenhuma "parede"
//     encostada no chão bloqueando progresso;
//   - inimigos spawnam sobre o chão, longe do spawn do jogador;
//   - saída canônica: tiles ordenados e sem duplicatas.
func TestLevelEstrutura(t *testing.T) {
	for _, spec := range testSpecs {
		for _, seed := range testSeeds {
			name := fmt.Sprintf("%s_seed_%d", spec.name, seed)
			t.Run(name, func(t *testing.T) {
				l := genLevel(t, spec.width, spec.height, seed)
				w, h, groundY := l.Spec.Width, l.Spec.Height, l.GroundY

				// spawn e fim sólidos
				if !l.Solid(PlayerSpawnX, groundY) {
					t.Errorf("spawn (%d, %d) não é sólido", PlayerSpawnX, groundY)
				}
				if !l.Solid(w-1, groundY) || !l.Solid(w-2, groundY) {
					t.Errorf("últimas %d colunas não são solo sólido (garantia do fim)",
						GapWidth)
				}

				// lacunas do chão: runs de no máximo GapWidth tiles
				gapRun, maxGap := 0, 0
				for tx := 0; tx < w; tx++ {
					if l.Solid(tx, groundY) {
						gapRun = 0
						continue
					}
					gapRun++
					if gapRun > maxGap {
						maxGap = gapRun
					}
				}
				if maxGap > GapWidth {
					t.Errorf("lacuna de %d tiles (máx %d) — não pulável", maxGap, GapWidth)
				}

				// clearance: nada sólido na fileira acima do chão (sem parede)
				for tx := 0; tx < w; tx++ {
					if l.Solid(tx, groundY-1) {
						t.Errorf("tile sólido na fileira de clearance (%d, %d) — parede no chão", tx, groundY-1)
					}
				}

				// nenhum tile abaixo do chão (solo tem GroundDepth de espessura)
				for tx := 0; tx < w; tx++ {
					if l.Solid(tx, groundY+GroundDepth) {
						t.Errorf("tile abaixo do chão em (%d, %d)", tx, groundY+GroundDepth)
					}
				}

				// inimigos: sobre o chão, longe do spawn (tx >= 12) e no grid
				for _, e := range l.EnemySpawns {
					if e.Y != groundY || !l.Solid(e.X, e.Y) {
						t.Errorf("inimigo %+v fora do chão (groundY=%d)", e, groundY)
					}
					if e.X < 12 || e.X >= w-1 {
						t.Errorf("inimigo %+v fora da faixa segura [12, %d)", e, w-1)
					}
				}

				// saída canônica: tiles ordenados, sem duplicatas, dentro do grid
				if !sort.SliceIsSorted(l.Tiles, func(i, j int) bool {
					if l.Tiles[i].X != l.Tiles[j].X {
						return l.Tiles[i].X < l.Tiles[j].X
					}
					return l.Tiles[i].Y < l.Tiles[j].Y
				}) {
					t.Error("Tiles não está ordenado (saída canônica)")
				}
				for i := 1; i < len(l.Tiles); i++ {
					if l.Tiles[i] == l.Tiles[i-1] {
						t.Errorf("tile duplicado %+v", l.Tiles[i])
					}
				}
				for _, tl := range l.Tiles {
					if tl.X < 0 || tl.X >= w || tl.Y < 0 || tl.Y >= h {
						t.Errorf("tile %+v fora do grid %dx%d", tl, w, h)
					}
				}

				// contagem do chão: cada coluna sólida tem GroundDepth tiles
				for tx := 0; tx < w; tx++ {
					if l.Solid(tx, groundY) != l.Solid(tx, groundY+1) {
						t.Errorf("coluna %d: chão com espessura inconsistente", tx)
					}
				}
			})
		}
	}
}

// TestLevelInvalidSpec verifica a validação de specs: largura/altura abaixo
// do mínimo retornam ErrInvalidLevelSpec.
func TestLevelInvalidSpec(t *testing.T) {
	tests := []struct {
		name   string
		width  int
		height int
	}{
		{"largura_abaixo_min", 8, 12},
		{"altura_abaixo_min", 120, 5},
		{"largura_e_altura_baixas", 1, 1},
		{"largura_zero", 0, 12},
		{"altura_zero", 120, 0},
		{"negativas", -10, -10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := GenerateLevel(LevelSpec{Width: tt.width, Height: tt.height, Seed: 42})
			if !errors.Is(err, ErrInvalidLevelSpec) {
				t.Errorf("GenerateLevel(%dx%d) erro = %v, want ErrInvalidLevelSpec",
					tt.width, tt.height, err)
			}
		})
	}
}

// TestLevelSpawnLongeDeLacuna garante que o spawn do jogador nunca cai numa
// lacuna: PlayerSpawnX não é coluna de gap por construção (2 % 9 = 2) e a
// geração mantém isso para todo o conjunto de seeds.
func TestLevelSpawnLongeDeLacuna(t *testing.T) {
	for _, spec := range testSpecs {
		for _, seed := range testSeeds {
			l := genLevel(t, spec.width, spec.height, seed)
			want := Tile{X: PlayerSpawnX, Y: l.GroundY}
			if l.PlayerSpawn != want {
				t.Errorf("seed %d: PlayerSpawn = %+v, want %+v", seed, l.PlayerSpawn, want)
			}
		}
	}
}

// TestLevelFinished define a fronteira de fim de fase: a fase está completa
// quando a BORDA DIREITA do hitbox do jogador cruza a primeira coluna do fim
// (Width-1) — espelho da meta de atravessabilidade do gerador (coluna final).
// No spawn (x=96) a fase nunca está completa; na borda exata vira true.
func TestLevelFinished(t *testing.T) {
	l := genLevel(t, 120, 12, 1)
	finishX := float64((l.Spec.Width - 1) * TileSize) // pixel da 1ª coluna do fim
	tests := []struct {
		name string
		px   float64
		want bool
	}{
		{name: "spawn longe do fim", px: 96, want: false},
		{name: "meio do mapa", px: finishX / 2, want: false},
		{name: "borda direita na coluna final", px: finishX - PlayerWidth, want: true},
		{name: "passou do fim", px: finishX + 100, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := l.Finished(tt.px); got != tt.want {
				t.Errorf("Finished(%v) = %v, want %v", tt.px, got, tt.want)
			}
		})
	}
}
