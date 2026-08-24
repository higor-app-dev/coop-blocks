package game

import (
	"errors"
	"fmt"
	"testing"
)

// genLevels são os níveis exercitados nos testes do gerador progressivo
// (Generate/generateGrid). Cobrem a rampa de dificuldade: fase 1 (paridade
// com o espelho), fases médias e fases altas.
var genLevels = []int{1, 2, 3, 5, 8}

// genLvl gera o grid e o Level para (seed, nível), falhando o teste em erro.
func genLvl(t *testing.T, seed uint64, level int) (*Level, *genGrid) {
	t.Helper()
	g, err := generateGrid(seed, level)
	if err != nil {
		t.Fatalf("generateGrid(seed=%d, level=%d): %v", seed, level, err)
	}
	return g.toLevel(seed), g
}

// gridSig devolve uma chave canônica do grid (célula a célula, por fileira)
// para comparação de igualdade/diferença entre gerações.
func gridSig(g *genGrid) string {
	b := make([]byte, 0, g.w*g.h+g.h)
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			b = append(b, byte(g.cells[y][x])+'0')
		}
		b = append(b, '|')
	}
	return string(b)
}

// TestGenerateDeterminismoMesmaSeedNivel: critério de aceite — a MESMA seed E
// o MESMO nível geram EXATAMENTE o mesmo grid (célula a célula) e o mesmo
// Level (Signature), em toda a varredura de seeds × níveis.
func TestGenerateDeterminismoMesmaSeedNivel(t *testing.T) {
	for _, level := range genLevels {
		for _, seed := range testSeeds {
			name := fmt.Sprintf("level_%d_seed_%d", level, seed)
			t.Run(name, func(t *testing.T) {
				l1, g1 := genLvl(t, uint64(seed), level)
				l2, g2 := genLvl(t, uint64(seed), level)

				if gridSig(g1) != gridSig(g2) {
					t.Fatal("mesma seed+nível gerou grids diferentes")
				}
				if l1.Signature() != l2.Signature() {
					t.Fatal("mesma seed+nível gerou Levels diferentes")
				}
			})
		}
	}
}

// TestGenerateSeedsDiferentes: critério de aceite — seeds diferentes geram
// grids diferentes (fase 3 tem entropia suficiente para o conjunto fixo).
func TestGenerateSeedsDiferentes(t *testing.T) {
	sigs := map[string]uint32{}
	for _, seed := range testSeeds {
		_, g := genLvl(t, uint64(seed), 3)
		sig := gridSig(g)
		if prev, ok := sigs[sig]; ok {
			t.Errorf("seeds %d e %d geraram o MESMO grid", prev, seed)
		}
		sigs[sig] = seed
	}
}

// TestGenerateNiveisDiferentes: o mesmo seed com níveis diferentes gera grids
// diferentes, e o mapa CRESCE com a fase (largura estritamente maior).
func TestGenerateNiveisDiferentes(t *testing.T) {
	prevW, prevSig := 0, ""
	for _, level := range genLevels {
		_, g := genLvl(t, 42, level)
		if prevW > 0 {
			if g.w <= prevW {
				t.Errorf("nível %d: largura %d não maior que a do nível anterior (%d)",
					level, g.w, prevW)
			}
			if gridSig(g) == prevSig {
				t.Errorf("nível %d repetiu o grid do nível anterior", level)
			}
		}
		prevW, prevSig = g.w, gridSig(g)
	}
}

// TestGenerateAtravessavel: critério de aceite central — TODA fase gerada
// possui caminho do início ao fim (Level.Traversable), com spawn e fim sobre
// solo sólido, para toda a varredura de seeds × níveis.
func TestGenerateAtravessavel(t *testing.T) {
	for _, level := range genLevels {
		for _, seed := range testSeeds {
			name := fmt.Sprintf("level_%d_seed_%d", level, seed)
			t.Run(name, func(t *testing.T) {
				l, _ := genLvl(t, uint64(seed), level)

				if !l.Solid(l.PlayerSpawn.X, l.PlayerSpawn.Y) {
					t.Fatalf("spawn %+v não está sobre solo sólido", l.PlayerSpawn)
				}
				if !l.Solid(l.Spec.Width-1, l.GroundY) {
					t.Fatalf("fim (%d, %d) não está sobre solo sólido", l.Spec.Width-1, l.GroundY)
				}
				if !l.Traversable() {
					t.Fatalf("fase não atravessável: seed=%d level=%d", seed, level)
				}
			})
		}
	}
}

// TestGenerateInicioEFimNasBordas: o caminho base começa na borda esquerda
// (x=0) e termina na borda direita (x=W-1), ambos na fileira do chão, e TODA
// coluna tem pelo menos uma célula de chão (caminho conexo coluna a coluna).
func TestGenerateInicioEFimNasBordas(t *testing.T) {
	for _, level := range genLevels {
		for _, seed := range testSeeds {
			_, g := genLvl(t, uint64(seed), level)

			if g.path[0] != g.groundY || g.path[g.w-1] != g.groundY {
				t.Fatalf("seed %d level %d: caminho não termina no chão (path[0]=%d path[W-1]=%d groundY=%d)",
					seed, level, g.path[0], g.path[g.w-1], g.groundY)
			}
			if c := g.cellAt(0, g.groundY); c != CellChao {
				t.Errorf("seed %d level %d: borda esquerda (0, %d) = %v, want chão", seed, level, g.groundY, c)
			}
			if c := g.cellAt(g.w-1, g.groundY); c != CellChao {
				t.Errorf("seed %d level %d: borda direita (%d, %d) = %v, want chão", seed, level, g.w-1, g.groundY, c)
			}
			for x := 0; x < g.w; x++ {
				if g.cellAt(x, g.path[x]) != CellChao {
					t.Errorf("seed %d level %d: coluna %d sem chão no caminho base", seed, level, x)
				}
			}
		}
	}
}

// TestGenerateCelulasValidas: só existem os 4 tipos de célula (chão,
// plataforma, parede, vazio); o Level expõe exatamente as células sólidas
// (chão+plataforma+parede); vazio existe em toda fase; e não há tile do Level
// que seja vazio no grid.
func TestGenerateCelulasValidas(t *testing.T) {
	for _, level := range genLevels {
		for _, seed := range testSeeds {
			l, g := genLvl(t, uint64(seed), level)

			counts := map[Cell]int{}
			for y := 0; y < g.h; y++ {
				for x := 0; x < g.w; x++ {
					c := g.cellAt(x, y)
					if c < CellVazio || c > CellParede {
						t.Fatalf("seed %d level %d: célula inválida %d em (%d,%d)", seed, level, c, x, y)
					}
					counts[c]++
				}
			}
			if counts[CellVazio] == 0 {
				t.Errorf("seed %d level %d: fase sem células vazias", seed, level)
			}
			solidCells := counts[CellChao] + counts[CellPlataforma] + counts[CellParede]
			if solidCells != len(l.Tiles) {
				t.Errorf("seed %d level %d: %d células sólidas no grid vs %d tiles no Level",
					seed, level, solidCells, len(l.Tiles))
			}
			for _, tl := range l.Tiles {
				if g.cellAt(tl.X, tl.Y) == CellVazio {
					t.Errorf("seed %d level %d: tile %+v do Level é vazio no grid", seed, level, tl)
				}
			}
		}
	}
}

// TestGenerateDificuldadeCrescente: fases maiores são mais difíceis POR
// CONSTRUÇÃO — mais buracos, plataformas menores, chão mais fino (caminho
// mais estreito), buracos mais largos e mapa maior. Os parâmetros são funções
// puras do nível (dificultyParams); além deles, o teste confere no grid que a
// fase 5 tem mais buracos que a fase 1 e chão mais fino (mesma seed).
func TestGenerateDificuldadeCrescente(t *testing.T) {
	p1, err := difficultyParams(1)
	if err != nil {
		t.Fatal(err)
	}
	p5, err := difficultyParams(5)
	if err != nil {
		t.Fatal(err)
	}
	if p5.holeBudget <= p1.holeBudget {
		t.Errorf("holeBudget fase 5 (%d) não maior que fase 1 (%d)", p5.holeBudget, p1.holeBudget)
	}
	if p5.platformLen >= p1.platformLen {
		t.Errorf("platformLen fase 5 (%d) não menor que fase 1 (%d)", p5.platformLen, p1.platformLen)
	}
	if p5.floorDepth >= p1.floorDepth {
		t.Errorf("floorDepth fase 5 (%d) não menor que fase 1 (%d)", p5.floorDepth, p1.floorDepth)
	}
	if p5.width <= p1.width {
		t.Errorf("largura fase 5 (%d) não maior que fase 1 (%d)", p5.width, p1.width)
	}
	if p5.maxHoleWidth < p1.maxHoleWidth {
		t.Errorf("maxHoleWidth fase 5 (%d) menor que fase 1 (%d)", p5.maxHoleWidth, p1.maxHoleWidth)
	}

	for _, seed := range testSeeds {
		_, g1 := genLvl(t, uint64(seed), 1)
		_, g5 := genLvl(t, uint64(seed), 5)
		if len(g5.holes) <= len(g1.holes) {
			t.Errorf("seed %d: %d buracos na fase 5 vs %d na fase 1", seed, len(g5.holes), len(g1.holes))
		}
		if g5.floorDepth >= g1.floorDepth {
			t.Errorf("seed %d: espessura do chão não reduziu (fase 1: %d, fase 5: %d)",
				seed, g1.floorDepth, g5.floorDepth)
		}
	}
}

// TestGeneratePlataformasPresentes: toda fase tem plataformas suspensas
// (contagem mínima largura/7 ≥ 6 na fase 1), na fileira groundY-3 (nunca na
// rota de pulo nem no clearance do caminho).
func TestGeneratePlataformasPresentes(t *testing.T) {
	for _, level := range genLevels {
		for _, seed := range testSeeds {
			_, g := genLvl(t, uint64(seed), level)
			if g.count(CellPlataforma) == 0 {
				t.Errorf("seed %d level %d: fase sem plataformas", seed, level)
			}
			for y := 0; y < g.h; y++ {
				for x := 0; x < g.w; x++ {
					if g.cellAt(x, y) == CellPlataforma {
						if y != g.groundY-genPlatformRowGap {
							t.Errorf("seed %d level %d: plataforma em (%d,%d) fora da fileira %d",
								seed, level, x, y, g.groundY-genPlatformRowGap)
						}
					}
				}
			}
		}
	}
}

// TestGenerateParedesAparecem: fases altas produzem paredes (varredura de
// seeds) — sempre em coluna plana do caminho, longe das bordas, com altura
// dentro do limite da dificuldade (paredes são sempre puláveis pelo modelo).
func TestGenerateParedesAparecem(t *testing.T) {
	found := false
	for _, level := range []int{3, 5, 8} {
		p, _ := difficultyParams(level)
		for _, seed := range testSeeds {
			_, g := genLvl(t, uint64(seed), level)
			for _, w := range g.walls {
				found = true
				if w.h < 1 || w.h > p.wallMaxHeight {
					t.Errorf("seed %d level %d: parede com altura %d fora do limite %d",
						seed, level, w.h, p.wallMaxHeight)
				}
				if w.x < 4 || w.x > g.w-5 {
					t.Errorf("seed %d level %d: parede na coluna %d perto da borda", seed, level, w.x)
				}
				if g.path[w.x-1] != g.path[w.x] || g.path[w.x+1] != g.path[w.x] {
					t.Errorf("seed %d level %d: parede em coluna não plana %d", seed, level, w.x)
				}
			}
		}
	}
	if !found {
		t.Fatal("nenhuma fase com parede na varredura seeds×fases altas")
	}
}

// TestGenerateNivelInvalido: nível < 1 retorna erro (mesmo sentinel de spec
// inválida), tanto em Generate quanto em generateGrid.
func TestGenerateNivelInvalido(t *testing.T) {
	for _, level := range []int{0, -1, -42} {
		if _, err := Generate(123, level); !errors.Is(err, ErrInvalidLevelSpec) {
			t.Errorf("Generate(123, %d) erro = %v, want ErrInvalidLevelSpec", level, err)
		}
		if _, err := generateGrid(123, level); !errors.Is(err, ErrInvalidLevelSpec) {
			t.Errorf("generateGrid(123, %d) erro = %v, want ErrInvalidLevelSpec", level, err)
		}
	}
}
