package game

import (
	"fmt"
	"math"
	"sort"
)

// ---------------------------------------------------------------------------
// Gerador de fase procedural com dificuldade progressiva (levelgen).
//
// Diferente do GenerateLevel (espelho do client), este gerador constrói o
// grid a partir de um CAMINHO BASE conectado — uma trilha contínua de chão
// que liga a borda esquerda à direita — e só então adiciona variações
// (buracos com ponte, paredes, plataformas). A atravessabilidade é garantida
// POR CONSTRUÇÃO: o caminho base existe em toda coluna (path[x] aponta para
// uma célula CellChao) e varia no máximo 1 tile de altura entre colunas
// adjacentes (degrau pulável pelo modelo de Level.Traversable).
//
// Dificuldade progressiva por fase (parâmetros puros do nível):
//   - mapas maiores (width cresce com level);
//   - mais buracos e buracos mais largos (holeBudget/maxHoleWidth crescem);
//   - chão mais fino (floorDepth decresce);
//   - plataformas menores (platformLen decresce);
//   - paredes aparecem em fases altas (wallMaxHeight cresce).
//
// Tudo é determinístico: mesma seed + mesmo level → exatamente o mesmo grid.
// ---------------------------------------------------------------------------

// Cell é o tipo de uma célula do grid gerado.
type Cell int

const (
	CellVazio Cell = iota
	CellChao
	CellPlataforma
	CellParede
)

// genPlatformRowGap é a distância (em tiles) entre o topo do chão e a fileira
// das plataformas suspensas (py = groundY - genPlatformRowGap). Escolhida para
// ficar dentro do MaxJumpHeight (4) — o jogador alcança as plataformas pulando.
const genPlatformRowGap = 3

// genHole é um buraco no chão: largura em tiles começando na coluna x.
type genHole struct {
	x     int
	width int
}

// genWall é uma parede: altura h em tiles na coluna x (cresce do chão).
type genWall struct {
	x int
	h int
}

// genParams são os parâmetros de dificuldade da fase — funções PURAS do
// nível (não dependem da seed), usados tanto pela geração quanto pelos
// testes de dificuldade crescente.
type genParams struct {
	width         int // largura do mapa em tiles
	height        int // altura do mapa em tiles
	floorDepth    int // espessura do chão (fileiras groundY..groundY+floorDepth-1)
	holeBudget    int // nº de buracos a abrir no chão
	maxHoleWidth  int // largura máxima de um buraco
	platformLen   int // comprimento das plataformas suspensas
	platformCount int // nº de plataformas suspensas
	wallMaxHeight int // altura máxima de uma parede (0 = fase sem paredes)
}

// difficultyParams devolve os parâmetros de dificuldade do nível. Nível < 1
// retorna ErrInvalidLevelSpec (mesmo sentinel das specs inválidas).
func difficultyParams(level int) (genParams, error) {
	if level < 1 {
		return genParams{}, ErrInvalidLevelSpec
	}
	// Rampa de dificuldade: mapas maiores, mais buracos e mais largos, chão
	// mais fino, plataformas menores; paredes só em fases altas.
	width := 60 + level*12 // fase 1: 72, fase 5: 120, fase 8: 156
	floorDepth := 4 - (level-1)/2
	if floorDepth < 1 {
		floorDepth = 1
	}
	if floorDepth > 4 {
		floorDepth = 4
	}
	holeBudget := 1 + (level-1)/2 // fase 1: 1, fase 5: 3
	maxHoleWidth := 1 + level/4   // fase 1: 1, fase 5: 2 (sempre <= MaxJumpRange-1)
	if maxHoleWidth > 2 {
		maxHoleWidth = 2
	}
	platformLen := 5 - (level-1)/3 // fase 1: 5, fase 5: 3
	if platformLen < 2 {
		platformLen = 2
	}
	platformCount := width / 7 // plataformas proporcionais à largura
	if platformCount < 1 {
		platformCount = 1
	}
	wallMaxHeight := 1 + (level-1)/3 // fase 3: 1, fase 5: 2, fase 8: 3
	if wallMaxHeight > 3 {
		wallMaxHeight = 3
	}
	// Paredes só entram a partir da fase 3.
	if level < 3 {
		wallMaxHeight = 0
	}
	return genParams{
		width:         width,
		height:        12,
		floorDepth:    floorDepth,
		holeBudget:    holeBudget,
		maxHoleWidth:  maxHoleWidth,
		platformLen:   platformLen,
		platformCount: platformCount,
		wallMaxHeight: wallMaxHeight,
	}, nil
}

// genGrid é o grid bruto gerado: células por fileira (cells[y][x]), o caminho
// base (path[x] = fileira do caminho na coluna x), a fileira do chão, e as
// variações registradas (buracos/paredes) para inspeção/testes.
type genGrid struct {
	w          int
	h          int
	cells      [][]Cell // cells[y][x]
	path       []int    // path[x] = fileira do caminho base na coluna x
	groundY    int      // fileira do topo do chão
	floorDepth int      // espessura do chão
	holes      []genHole
	walls      []genWall
}

// cellAt devolve a célula (x, y); fora do grid retorna CellVazio.
func (g *genGrid) cellAt(x, y int) Cell {
	if x < 0 || x >= g.w || y < 0 || y >= g.h {
		return CellVazio
	}
	return g.cells[y][x]
}

// count conta quantas células do grid têm o tipo c.
func (g *genGrid) count(c Cell) int {
	n := 0
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			if g.cells[y][x] == c {
				n++
			}
		}
	}
	return n
}

// generateGrid gera o grid (seed, level) com dificuldade progressiva.
func generateGrid(seed uint64, level int) (*genGrid, error) {
	p, err := difficultyParams(level)
	if err != nil {
		return nil, err
	}
	rnd := newMulberry32(uint32(seed))

	w, h := p.width, p.height
	groundY := h - p.floorDepth
	if groundY < genPlatformRowGap+2 {
		return nil, fmt.Errorf("%w: altura %d insuficiente para o chão (floorDepth %d)", ErrInvalidLevelSpec, h, p.floorDepth)
	}

	g := &genGrid{
		w:          w,
		h:          h,
		cells:      make([][]Cell, h),
		path:       make([]int, w),
		groundY:    groundY,
		floorDepth: p.floorDepth,
	}
	for y := 0; y < h; y++ {
		g.cells[y] = make([]Cell, w)
	}

	// 1) Chão contínuo: fileiras groundY..groundY+floorDepth-1 em todas as
	//    colunas. path[x] começa no topo do chão.
	for x := 0; x < w; x++ {
		g.path[x] = groundY
		for y := groundY; y < h; y++ {
			g.cells[y][x] = CellChao
		}
	}

	// 2) Buracos com ponte elevada: o caminho base sobe 1 tile (degrau
	//    pulável) e cruza o vão por cima; a célula do topo do chão vira
	//    vazio (o jogador cairia se pisasse no chão normal). Buracos ficam
	//    longe das bordas e não se sobrepõem.
	const holeMinX = 6
	holeWidths := make([]int, 0, p.holeBudget)
	for i := 0; i < p.holeBudget; i++ {
		width := 1 + int(math.Floor(rnd()*float64(p.maxHoleWidth)))
		if width > p.maxHoleWidth {
			width = p.maxHoleWidth
		}
		holeWidths = append(holeWidths, width)
	}
	for i := 0; i < p.holeBudget; i++ {
		width := holeWidths[i]
		placed := false
		for attempt := 0; attempt < 40 && !placed; attempt++ {
			maxX := w - width - holeMinX - 1
			if maxX <= holeMinX {
				break
			}
			x := holeMinX + int(math.Floor(rnd()*float64(maxX-holeMinX+1)))
			// Checa sobreposição com buracos já colocados (gap >= 1 coluna).
			ok := true
			for _, hh := range g.holes {
				if x < hh.x+hh.width && hh.x < x+width {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			for cx := x; cx < x+width; cx++ {
				g.cells[groundY][cx] = CellVazio          // buraco
				g.cells[groundY-1][cx] = CellChao         // ponte elevada (caminho)
				g.path[cx] = groundY - 1
			}
			g.holes = append(g.holes, genHole{x: x, width: width})
			placed = true
		}
	}

	// 3) Paredes (fases altas): coluna plana (path constante nas 3 colunas),
	//    longe das bordas, altura dentro do limite da dificuldade. Paredes
	//    são sempre puláveis pelo modelo (altura <= wallMaxHeight <= 3 <
	//    MaxJumpHeight = 4).
	if p.wallMaxHeight > 0 {
		wallCount := 1 + (level-3)/2 // fase 3: 1, fase 5: 2, fase 8: 3
		if wallCount < 1 {
			wallCount = 1
		}
		for i := 0; i < wallCount; i++ {
			placed := false
			for attempt := 0; attempt < 60 && !placed; attempt++ {
				x := 4 + int(math.Floor(rnd()*float64(w-9)))
				if x < 4 || x > w-5 {
					continue
				}
				if g.path[x-1] != groundY || g.path[x] != groundY || g.path[x+1] != groundY {
					continue // precisa ser coluna plana no chão
				}
				hw := 1 + int(math.Floor(rnd()*float64(p.wallMaxHeight)))
				if hw > p.wallMaxHeight {
					hw = p.wallMaxHeight
				}
				// Evita parede sobre buraco vizinho (gap >= 2 colunas de chão).
				nearHole := false
				for _, hh := range g.holes {
					if x >= hh.x-2 && x <= hh.x+hh.width+1 {
						nearHole = true
						break
					}
				}
				if nearHole {
					continue
				}
				for dy := 1; dy <= hw; dy++ {
					g.cells[groundY-dy][x] = CellParede
				}
				g.walls = append(g.walls, genWall{x: x, h: hw})
				placed = true
			}
		}
	}

	// 4) Plataformas suspensas: fileira py = groundY - genPlatformRowGap,
	//    comprimento platformLen, posições seed-dependentes. Nunca em coluna
	//    de parede nem sobre buraco (não interferem no caminho base).
	py := groundY - genPlatformRowGap
	for i := 0; i < p.platformCount; i++ {
		placed := false
		for attempt := 0; attempt < 50 && !placed; attempt++ {
			x := int(math.Floor(rnd() * float64(w-p.platformLen)))
			if x < 0 || x+p.platformLen > w {
				continue
			}
			ok := true
			for cx := x; cx < x+p.platformLen; cx++ {
				if g.cells[py][cx] != CellVazio {
					ok = false
					break
				}
				if g.cells[groundY][cx] == CellVazio {
					ok = false // sobre buraco
					break
				}
			}
			if !ok {
				continue
			}
			for cx := x; cx < x+p.platformLen; cx++ {
				g.cells[py][cx] = CellPlataforma
			}
			placed = true
		}
	}

	return g, nil
}

// toLevel converte o grid em um Level (tiles sólidos, spawn, inimigos). A
// saída é canônica: tiles ordenados e sem duplicatas, inimigos determinísticos.
func (g *genGrid) toLevel(seed uint64) *Level {
	solid := map[Tile]bool{}
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			if g.cells[y][x] != CellVazio {
				solid[Tile{X: x, Y: y}] = true
			}
		}
	}
	tiles := make([]Tile, 0, len(solid))
	for t := range solid {
		tiles = append(tiles, t)
	}
	sort.Slice(tiles, func(i, j int) bool {
		if tiles[i].X != tiles[j].X {
			return tiles[i].X < tiles[j].X
		}
		return tiles[i].Y < tiles[j].Y
	})

	// Inimigos: sobre o topo do chão, longe do spawn, passo determinístico
	// (mesmo padrão do GenerateLevel, stream própria da seed).
	l := &Level{
		Spec:         LevelSpec{Width: g.w, Height: g.h, Seed: uint32(seed)},
		GroundY:      g.groundY,
		Tiles:        tiles,
		PlayerSpawn:  Tile{X: PlayerSpawnX, Y: g.groundY},
		EnemySpawns:  []Tile{},
		CoinSpawns:   []Tile{},
		PowerUpSpawns: []PowerUpSpawn{},
		solid:        solid,
	}
	rnd := newMulberry32(uint32(seed) ^ 0x5EED)
	for tx := 12; tx < g.w-1; tx += 5 + int(math.Floor(rnd()*4)) {
		if g.cells[g.groundY][tx] == CellChao {
			l.EnemySpawns = append(l.EnemySpawns, Tile{X: tx, Y: g.groundY})
		}
	}
	return l
}

// Generate gera o Level da fase (seed, level) com dificuldade progressiva.
func Generate(seed uint64, level int) (*Level, error) {
	g, err := generateGrid(seed, level)
	if err != nil {
		return nil, err
	}
	return g.toLevel(seed), nil
}
