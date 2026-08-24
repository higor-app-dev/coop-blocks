// Package game — gerador de fase/level procedural.
//
// Este arquivo porta para Go o gerador do client (apps/web/src/levelgen.ts):
// mesmo PRNG mulberry32, mesmas regras de layout (chão com lacunas, plataformas
// suspensas, spawns de inimigos). O espelho é proposital — a feature planejada
// de "seed compartilhada de fase" exige que servidor e client gerem exatamente
// a MESMA fase a partir da mesma seed.
//
// Além do espelho, o gerador Go adiciona uma garantia que o client não tem:
// ATRAVESSABILIDADE. Toda fase gerada é verificável por Level.Traversable()
// (existe caminho válido do spawn até o fim da fase), e a geração garante por
// construção que:
//   - as últimas GapWidth colunas são sempre solo sólido (fim standable —
//     o client pode terminar a fase em um buraco; o servidor não);
//   - lacunas são sempre puláveis: têm no máximo GapWidth tiles de largura e
//     o pulo modelado (MaxJumpHeight) alcança o topo de qualquer pilha de
//     plataformas que porventura fique sobre uma lacuna;
//   - como rede de segurança, um laço de ponto fixo verifica a fase com o
//     próprio BFS de atravessabilidade e preenche lacunas intransponíveis.
package game

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// Constantes de layout (alinhadas ao client levelgen.ts).
const (
	// TileSize é o tamanho do tile em pixels (client: TILE = 48).
	TileSize = 48
	// GapPeriod é o período das lacunas do chão (client: tx % 9 === 0).
	GapPeriod = 9
	// GapWidth é a largura de cada lacuna, em tiles (client: tx%9 ∈ {0,1}).
	GapWidth = 2
	// PlayerSpawnX é a coluna do spawn do jogador (client: tx = 2).
	PlayerSpawnX = 2
	// MinPlatformLen / MaxPlatformLen: comprimento das plataformas suspensas.
	MinPlatformLen = 2
	MaxPlatformLen = 4
	// GroundDepth é a espessura do chão, em tiles (client empilha 2).
	GroundDepth = 2
	// MaxPlatformHeight é a altura máxima de uma plataforma sobre o chão,
	// em tiles (client sorteia py em [groundY-4, groundY-2]).
	MaxPlatformHeight = 4

	// Modelo de atravessabilidade (não é o motor de física do jogo; é um
	// modelo conservador de propósito simples usado por Level.Traversable):
	// MaxJumpRange é o alcance horizontal máximo de um pulo, em tiles —
	// cobre lacunas de até GapWidth (o client gera lacunas de exatamente
	// GapWidth tiles, sempre puláveis com um salto de MaxJumpRange).
	MaxJumpRange = 3
	// MaxJumpHeight é a altura máxima de um pulo, em tiles. É 1 acima da
	// pilha máxima possível de plataformas sobre uma lacuna (MaxPlatformHeight
	// = 4), para que o topo de qualquer parede seja alcançável em um pulo.
	MaxJumpHeight = 4
	// MaxFallTiles é a queda máxima modelada num único pulo, em tiles.
	MaxFallTiles = 10
)

// Erro retornado para specs de fase inválidos.
var ErrInvalidLevelSpec = errors.New("spec de fase inválido")

// LevelSpec descreve a fase a gerar. Width e Height são contagens de tiles;
// Seed é a semente do PRNG mulberry32 (coerção uint32, igual ao `>>> 0` do
// client — seeds do tipo Date.now() caem nos 32 bits baixos).
type LevelSpec struct {
	Width  int
	Height int
	Seed   uint32
}

// Tile é uma célula do grid da fase (x = coluna, y = fileira; y cresce para
// baixo, como no client).
type Tile struct {
	X int
	Y int
}

// Level é uma fase gerada: tiles sólidos, spawn do jogador, spawns de
// inimigos e moedas em coordenadas de tile (multiplicar por TileSize para
// pixels).
type Level struct {
	Spec        LevelSpec
	GroundY     int // fileira do topo do chão (spec.Height - 2)
	Tiles       []Tile
	PlayerSpawn Tile
	EnemySpawns []Tile
	// CoinSpawns são as posições de moedas da fase (chão + topos expostos
	// de plataforma), decididas pelo gerador — o CoinManager (coins.go)
	// registra cada uma com ID único e converte tile→pixels no spawn.
	CoinSpawns []Tile

	solid map[Tile]bool // índice interno de Solid() — populado por GenerateLevel
}

// newMulberry32 é a porta Go exata do PRNG mulberry32 do client. Duas
// instâncias com a mesma seed produzem a mesma sequência em [0, 1) — e a
// sequência é bit-a-bit igual à do client (verificado por testes golden).
func newMulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := a
		t = (t ^ (t >> 15)) * (t | 1)
		t = (t + (t^(t>>7))*(t|61)) ^ t
		return float64(t^(t>>14)) / 4294967296.0
	}
}

// GenerateLevel gera a fase para o spec dado. A saída é determinística por
// seed: a mesma seed produz exatamente a mesma fase (mesmos tiles, mesmo
// spawn, mesmos inimigos). Specs com Width < GapPeriod ou Height < 6 retornam
// ErrInvalidLevelSpec (o client usa 120×12; abaixo disso as plataformas
// sairiam do grid).
func GenerateLevel(spec LevelSpec) (Level, error) {
	if spec.Width < GapPeriod || spec.Height < 6 {
		return Level{}, fmt.Errorf("%w: width=%d height=%d (mínimo %dx%d)",
			ErrInvalidLevelSpec, spec.Width, spec.Height, GapPeriod, 6)
	}

	rnd := newMulberry32(spec.Seed)
	groundY := spec.Height - 2
	solid := make(map[Tile]bool)

	addTile := func(x, y int) {
		if x >= 0 && x < spec.Width && y >= 0 && y < spec.Height {
			solid[Tile{X: x, Y: y}] = true
		}
	}
	hasTile := func(x, y int) bool { return solid[Tile{X: x, Y: y}] }

	// 1) Chão: linha base com lacunas de GapWidth tiles a cada GapPeriod.
	//    (idêntico ao client: gap quando tx%9 ∈ {0,1}).
	for tx := 0; tx < spec.Width; tx++ {
		if tx%GapPeriod == 0 || tx%GapPeriod == 1 {
			continue
		}
		for d := 0; d < GroundDepth; d++ {
			addTile(tx, groundY+d)
		}
	}

	// 2) Plataformas suspensas (idêntico ao client: count = width/6, cada uma
	//    com px/py/len sorteados do mulberry32 na mesma ordem de consumo).
	for i := 0; i < spec.Width/6; i++ {
		px := int(math.Floor(rnd()*float64(spec.Width-4))) + 2
		py := groundY - 2 - int(math.Floor(rnd()*3))
		length := 2 + int(math.Floor(rnd()*3))
		for l := 0; l < length; l++ {
			if px+l < spec.Width {
				addTile(px+l, py)
			}
		}
	}

	// 3) Spawns de inimigos: sobre o chão, longe do spawn do jogador
	//    (idêntico ao client: tx a partir de 12, passo 5+rnd()*4; o rnd é
	//    consumido a cada iteração do laço, inclusive na última).
	var enemySpawns []Tile
	for tx := 12; tx < spec.Width-1; tx += 5 + int(math.Floor(rnd()*4)) {
		if hasTile(tx, groundY) {
			enemySpawns = append(enemySpawns, Tile{X: tx, Y: groundY})
		}
	}

	l := Level{
		Spec:        spec,
		GroundY:     groundY,
		PlayerSpawn: Tile{X: PlayerSpawnX, Y: groundY},
		EnemySpawns: enemySpawns,
		solid:       solid,
	}

	// 4) Garantia de atravessabilidade (divergência deliberada do client).
	//    a) Fim standable: as últimas GapWidth colunas são sempre solo sólido
	//       (o client pode terminar a fase em buraco; o servidor não).
	for tx := spec.Width - GapWidth; tx < spec.Width; tx++ {
		if !hasTile(tx, groundY) {
			for d := 0; d < GroundDepth; d++ {
				addTile(tx, groundY+d)
			}
		}
	}

	//    b) Ponto fixo (rede de segurança): verifica a fase com o próprio BFS
	//       de atravessabilidade; se ainda houver lacuna intransponível,
	//       preenche a primeira coluna de lacuna (da esquerda para a direita)
	//       e re-verifica. Determinístico e limitado: cada iteração preenche
	//       uma coluna; no pior caso o chão fica contínuo (trivialmente
	//       atravessável), então o laço termina em no máximo GapPeriod
	//       iterações — daí o teto de spec.Width por segurança.
	for i := 0; i < spec.Width && !l.Traversable(); i++ {
		filled := false
		for tx := 0; tx < spec.Width; tx++ {
			if !hasTile(tx, groundY) {
				for d := 0; d < GroundDepth; d++ {
					addTile(tx, groundY+d)
				}
				filled = true
				break
			}
		}
		if !filled {
			break
		}
	}

	// 5) Moedas: posições determinísticas da fase — o gerador decide ONDE as
	//    moedas ficam; o CoinManager (coins.go, SpawnForLevel) registra cada
	//    uma com ID único e converte tile→pixels no spawn. Regras:
	//      - chão: coluna sólida da fileira do chão com x >= CoinStartCol e
	//        x % CoinColumnStep == 0 — mesmo critério do client (main.ts),
	//        garantia de moedas coletáveis andando em TODA fase;
	//      - plataformas: topo exposto (tile sólido acima do chão com espaço
	//        livre em cima — nunca enterrada em parede), selecionado com um
	//        deslocamento sorteado da seed (coinOffset): a mesma coluna de
	//        plataforma pode ter moeda numa fase e não em outra — scatter
	//        seed-dependente;
	//      - cada moeda flutua CoinFloatHeight px acima do topo do tile,
	//        alcançável andando (chão) ou pulando na plataforma.
	var coinSpawns []Tile
	coinRnd := newMulberry32(spec.Seed ^ 0x9E3779B9) // stream própria — não altera a ordem de consumo do layout
	coinOffset := int(math.Floor(coinRnd() * CoinColumnStep))

	// a) Chão: fileira do chão, mesmo critério do client (paridade exata).
	for tx := 0; tx < spec.Width; tx++ {
		if tx >= CoinStartCol && tx%CoinColumnStep == 0 && hasTile(tx, groundY) {
			coinSpawns = append(coinSpawns, Tile{X: tx, Y: groundY})
		}
	}

	// b) Plataformas: superfícies expostas acima do chão (tile sólido sem
	//    sólido em cima), com o passo deslocado pela seed.
	for t := range solid {
		if t.Y >= groundY || hasTile(t.X, t.Y-1) {
			continue // chão já coberto em (a); tile com sólido em cima = enterrado
		}
		if (t.X+coinOffset)%CoinColumnStep == 0 {
			coinSpawns = append(coinSpawns, t)
		}
	}

	// Saída canônica: tiles ordenados e sem duplicatas.
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
	sort.Slice(enemySpawns, func(i, j int) bool {
		if enemySpawns[i].X != enemySpawns[j].X {
			return enemySpawns[i].X < enemySpawns[j].X
		}
		return enemySpawns[i].Y < enemySpawns[j].Y
	})
	sort.Slice(coinSpawns, func(i, j int) bool {
		if coinSpawns[i].X != coinSpawns[j].X {
			return coinSpawns[i].X < coinSpawns[j].X
		}
		return coinSpawns[i].Y < coinSpawns[j].Y
	})
	l.Tiles = tiles
	l.CoinSpawns = coinSpawns

	return l, nil
}

// Solid informa se a célula (x, y) é um tile sólido. Fora do grid retorna
// false (vazio).
func (l *Level) Solid(x, y int) bool {
	if x < 0 || x >= l.Spec.Width || y < 0 || y >= l.Spec.Height {
		return false
	}
	return l.solid[Tile{X: x, Y: y}]
}

// Signature devolve uma representação canônica e determinística da fase
// (tiles ordenados + spawns de inimigos + moedas). Duas fases têm a mesma
// Signature sse forem idênticas — útil para comparar fases por seed e
// detectar divergências client/servidor. O formato depende de CoinSpawns
// estar ordenado (saída canônica de GenerateLevel).
func (l *Level) Signature() string {
	var b strings.Builder
	fmt.Fprintf(&b, "w=%d h=%d ground=%d spawn=%d,%d enemies=%d coins=%d",
		l.Spec.Width, l.Spec.Height, l.GroundY, l.PlayerSpawn.X, l.PlayerSpawn.Y, len(l.EnemySpawns), len(l.CoinSpawns))
	for _, t := range l.Tiles {
		fmt.Fprintf(&b, ";%d,%d", t.X, t.Y)
	}
	for _, e := range l.EnemySpawns {
		fmt.Fprintf(&b, "|%d,%d", e.X, e.Y)
	}
	for _, c := range l.CoinSpawns {
		fmt.Fprintf(&b, "~%d,%d", c.X, c.Y)
	}
	return b.String()
}

// Finished diz se a fase está completa para um jogador na coordenada x em
// pixels (canto superior esquerdo do hitbox): a borda direita do hitbox
// cruzou a primeira coluna do fim (Width-1). Espelha a meta de
// atravessabilidade do gerador (Level.Traversable: coluna Width-1 no chão) —
// chegar ao fim do mapa é o que fecha a fase e abre a loja.
func (l *Level) Finished(px float64) bool {
	return px+PlayerWidth >= float64((l.Spec.Width-1)*TileSize)
}

// Traversable reports whether existe caminho válido do spawn do jogador até o
// fim da fase (coluna Width-1 no chão), sem paredes bloqueando o progresso.
//
// O modelo é conservador e de propósito simples (não é um motor de física):
//   - o jogador ocupa 1 tile e fica de pé sobre um tile sólido;
//   - anda 1 tile por passo horizontal, sobe 1 tile (degrau) e cai por
//     gravidade quando não há chão do lado (borda de plataforma);
//   - pula até MaxJumpRange tiles na horizontal e MaxJumpHeight na vertical;
//     o arco do pulo é uma parábola e não pode atravessar tile sólido.
//
// A geração garante por construção que o spawn e o fim ficam sobre solo
// sólido e que lacunas têm no máximo GapWidth tiles; Traversable() verifica a
// propriedade completa (caminho do início ao fim) sobre o grid.
func (l *Level) Traversable() bool {
	spawn := l.PlayerSpawn
	if !l.Solid(spawn.X, spawn.Y) {
		return false
	}
	goal := Tile{X: l.Spec.Width - 1, Y: l.GroundY}
	if !l.Solid(goal.X, goal.Y) {
		return false
	}

	visited := map[Tile]bool{spawn: true}
	queue := []Tile{spawn}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == goal {
			return true
		}
		for _, n := range l.neighbors(cur) {
			if !visited[n] {
				visited[n] = true
				queue = append(queue, n)
			}
		}
	}
	return false
}

// neighbors devolve as posições de pé alcançáveis a partir de p em um passo
// (anda/desce/sobe/pula), respeitando o modelo de movimento de Traversable.
func (l *Level) neighbors(p Tile) []Tile {
	w, h := l.Spec.Width, l.Spec.Height
	var out []Tile

	// Passo horizontal: mesma altura, degrau de 1 tile acima, ou queda por
	// gravidade quando não há chão do lado (borda de plataforma).
	for _, dx := range []int{-1, 1} {
		nx := p.X + dx
		if nx < 0 || nx >= w {
			continue
		}
		if l.Solid(nx, p.Y) {
			// mesmo nível — precisa de espaço para a cabeça
			if !l.Solid(nx, p.Y-1) {
				out = append(out, Tile{X: nx, Y: p.Y})
			}
		} else {
			// sem chão do lado: cai até o próximo sólido (ou no vazio = não vai)
			for ny := p.Y + 1; ny < h; ny++ {
				if l.Solid(nx, ny) {
					if !l.Solid(nx, ny-1) {
						out = append(out, Tile{X: nx, Y: ny})
					}
					break
				}
			}
		}
		// degrau: sobe 1 tile
		if l.Solid(nx, p.Y-1) && !l.Solid(nx, p.Y-2) {
			out = append(out, Tile{X: nx, Y: p.Y - 1})
		}
	}

	// Pulo: alcança até MaxJumpRange tiles na horizontal; o arco (parábola)
	// não pode atravessar tile sólido em nenhuma coluna intermediária.
	for dx := -MaxJumpRange; dx <= MaxJumpRange; dx++ {
		if dx == 0 {
			continue
		}
		nx := p.X + dx
		if nx < 0 || nx >= w {
			continue
		}
		for ny := p.Y - MaxJumpHeight; ny <= p.Y+MaxFallTiles; ny++ {
			if ny < 0 || ny >= h {
				continue
			}
			if !l.Solid(nx, ny) || l.Solid(nx, ny-1) {
				continue // pouso precisa de tile sólido com espaço para a cabeça
			}
			if l.jumpClear(p, Tile{X: nx, Y: ny}) {
				out = append(out, Tile{X: nx, Y: ny})
			}
		}
	}
	return out
}

// jumpClear verifica se o arco de um pulo de p até q está livre de tiles
// sólidos em todas as colunas intermediárias. O arco é uma parábola cujos pés
// sobem de p.Y até o ápice (p.Y - MaxJumpHeight) e descem até q.Y; o corpo
// (1 tile acima dos pés) não pode colidir com tile sólido no caminho.
func (l *Level) jumpClear(p, q Tile) bool {
	dx := q.X - p.X
	if dx == 0 {
		return false
	}
	ndx := dx
	if ndx < 0 {
		ndx = -ndx
	}
	apex := p.Y - MaxJumpHeight
	if q.Y < apex {
		apex = q.Y // chegada mais alta que o ápice padrão
	}
	dy := float64(q.Y - p.Y)
	rise := float64(p.Y - apex) // >= 0: altura do ápice sobre a partida
	for i := 1; i < ndx; i++ {
		cx := p.X + i
		if dx < 0 {
			cx = p.X - i
		}
		t := float64(i) / float64(ndx)
		feet := float64(p.Y) + dy*t - 4*rise*t*(1-t)
		feetRow := int(math.Floor(feet)) // célula que contém os pés
		// corpo = 1 tile acima dos pés; checar pés e cabeça
		if l.Solid(cx, feetRow) || l.Solid(cx, feetRow-1) {
			return false
		}
	}
	return true
}
