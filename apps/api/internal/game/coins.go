// Package game — moedas coletáveis da fase (autoritativo, server-side).
//
// Este arquivo implementa o gerenciador de moedas do servidor, dono do estado
// das moedas da fase atual:
//
//   - Coin: entidade com ID único e posição (hitbox AABB em pixels);
//   - contador POR JOGADOR da fase, separado da carteira persistente/gasta
//     (Sim.Coins + loja entre fases) — morrer no mapa atual zera apenas o
//     contador da fase, sem tocar moedas já gastas ou de fases anteriores;
//   - coleta por sobreposição (AABB player × coin): a moeda é removida, o
//     contador do jogador sobe e um evento é devolvido para o servidor
//     broadcastar (remoções + contagens) a todos os clientes;
//   - SEM caixa comum: não existe pool compartilhado de moedas do time —
//     cada jogador tem o seu contador individual.
//
// O posicionamento espelha o client (apps/web/src/main.ts): fileira de moedas
// sobre o chão, uma a cada 4 colunas sólidas a partir de x=6, flutuando 30 px
// acima do topo do tile de solo. Tudo é determinístico: mesma fase (mesmo
// grid) produz exatamente o mesmo conjunto de moedas.
package game

import (
	"math"
	"sort"
	"strconv"
	"sync"
)

// Dimensões e posicionamento das moedas (alinhadas ao client).
const (
	// CoinDefaultWidth / CoinDefaultHeight: hitbox da moeda em pixels
	// (client: rect(14, 14)).
	CoinDefaultWidth  = 14.0
	CoinDefaultHeight = 14.0
	// CoinFloatHeight: distância do CENTRO da moeda ao topo do tile de solo
	// (client: pos(t.x*TILE + TILE/2, t.y*TILE - 30)).
	CoinFloatHeight = 30.0
	// CoinStartCol: primeira coluna de moedas (client: t.x >= 6).
	CoinStartCol = 6
	// CoinColumnStep: moedas a cada N colunas sólidas (client: t.x % 4 === 0).
	CoinColumnStep = 4
)

// Coin é uma moeda da fase: hitbox AABB em pixels (X/Y = canto superior
// esquerdo, Y cresce para baixo — mesma convenção de PlayerState/EnemyState)
// e ID único no mundo.
type Coin struct {
	ID   string
	X, Y float64
	W, H float64
}

// CoinState é o estado sincronizado de uma moeda, enviado ao client via
// broadcast para renderização.
type CoinState struct {
	ID string `json:"id"`
	X  int    `json:"x"`
	Y  int    `json:"y"`
	W  int    `json:"w"`
	H  int    `json:"h"`
}

// CoinRemoved descreve uma moeda removida (coletada) em uma atualização:
// ID + posição para o client tocar o efeito de coleta mesmo sem ter o objeto
// localmente (moedas são autoritativas do servidor).
type CoinRemoved struct {
	ID string `json:"id"`
	X  int    `json:"x"`
	Y  int    `json:"y"`
}

// CoinConfig configura o gerenciador de moedas. Campos <= 0 usam os defaults
// (constantes do pacote).
type CoinConfig struct {
	Width  float64 // hitbox da moeda (default CoinDefaultWidth)
	Height float64 // hitbox da moeda (default CoinDefaultHeight)
}

func (c CoinConfig) withDefaults() CoinConfig {
	if c.Width <= 0 {
		c.Width = CoinDefaultWidth
	}
	if c.Height <= 0 {
		c.Height = CoinDefaultHeight
	}
	return c
}

// CoinEventType identifica um evento emitido pelo gerenciador de moedas.
type CoinEventType int

const (
	// CoinEventCollected: moeda coletada por um jogador (CoinID removida;
	// PlayerID = coletor; X/Y = posição da moeda para efeitos no client).
	CoinEventCollected CoinEventType = iota
)

// CoinEvent é um fato ocorrido na simulação de moedas, emitido para o
// servidor aplicar as consequências (broadcast de remoção + contagem).
type CoinEvent struct {
	Type     CoinEventType
	CoinID   string
	PlayerID string
	X, Y     float64
}

// CoinManager gerencia as moedas da fase atual: entidades (posição + ID
// único) e o contador por jogador DA FASE. O contador é deliberadamente
// separado da carteira persistente (Sim.Coins) — morte no mapa atual zera só
// o contador da fase. Não há pool comum de moedas: cada jogador coleta para
// o próprio contador. Thread-safe.
type CoinManager struct {
	mu     sync.RWMutex
	cfg    CoinConfig
	nextID int
	coins  map[string]*Coin
	counts map[string]int // contador da fase por jogador (0 = nunca coletou)
}

// NewCoinManager cria um gerenciador de moedas com a config dada.
func NewCoinManager(cfg CoinConfig) *CoinManager {
	return &CoinManager{
		cfg:    cfg.withDefaults(),
		coins:  make(map[string]*Coin),
		counts: make(map[string]int),
	}
}

// NewCoinManagerDefault cria um gerenciador com as regras padrão
// (moeda 14x14, mesma hitbox do client).
func NewCoinManagerDefault() *CoinManager {
	return NewCoinManager(CoinConfig{})
}

// SpawnAt adiciona uma moeda na posição dada (px, top-left da hitbox).
// Atribui um ID único sequencial (c1, c2, … — mesmo esquema de inimigos e
// projéteis). Usado para drops de inimigos e para espalhar moedas na fase.
func (m *CoinManager) SpawnAt(x, y float64) *Coin {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.spawnLocked(x, y)
}

// spawnLocked cria a moeda com o próximo ID. Deve ser chamada com o lock held.
func (m *CoinManager) spawnLocked(x, y float64) *Coin {
	m.nextID++
	c := &Coin{
		ID: "c" + strconv.Itoa(m.nextID),
		X:  x,
		Y:  y,
		W:  m.cfg.Width,
		H:  m.cfg.Height,
	}
	m.coins[c.ID] = c
	return c
}

// SpawnForLevel espalha moedas sobre o chão da fase (espelho do client):
// tile sólido da fileira do chão (l.GroundY) com x >= CoinStartCol e
// x % CoinColumnStep == 0, flutuando CoinFloatHeight px acima do topo do
// tile. Só cria moeda onde existe tile sólido (nunca dentro de parede nem
// sobre lacuna). Determinístico: depende apenas do grid canônico de l.Tiles.
// Devolve quantas moedas foram criadas.
func (m *CoinManager) SpawnForLevel(l *Level) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	spawned := 0
	for _, t := range l.Tiles {
		if t.Y != l.GroundY || t.X < CoinStartCol || t.X%CoinColumnStep != 0 {
			continue
		}
		cx := float64(t.X*TileSize) + TileSize/2.0
		cy := float64(t.Y*TileSize) - CoinFloatHeight
		m.spawnLocked(cx-m.cfg.Width/2, cy-m.cfg.Height/2)
		spawned++
	}
	return spawned
}

// Step detecta sobreposição AABB entre jogadores vivos e moedas. Cada moeda
// tocada é removida na hora e o contador do jogador é incrementado; um evento
// por coleta é devolvido para o servidor broadcastar (remoções + contagens).
// Jogador morto (HP <= 0) não coleta. Ordem determinística: moedas por ID e
// jogadores por ID — mesmos estados produzem exatamente os mesmos eventos.
// Se dois jogadores tocam a mesma moeda no mesmo tick, o de menor ID a
// coleta (a moeda é removida no primeiro overlap).
func (m *CoinManager) Step(players []Player) []CoinEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.coins) == 0 {
		return nil
	}

	// Jogadores vivos ordenados por ID (determinismo).
	alive := make([]*Player, 0, len(players))
	for i := range players {
		p := &players[i]
		if p.HP > 0 {
			alive = append(alive, p)
		}
	}
	sort.Slice(alive, func(i, j int) bool { return alive[i].ID < alive[j].ID })
	if len(alive) == 0 {
		return nil
	}

	// Moedas ordenadas por ID (determinismo).
	ids := make([]string, 0, len(m.coins))
	for id := range m.coins {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var events []CoinEvent
	for _, id := range ids {
		c := m.coins[id]
		for _, p := range alive {
			px, py := float64(p.X), float64(p.Y)
			if c.X < px+PlayerWidth && c.X+c.W > px &&
				c.Y < py+PlayerHeight && c.Y+c.H > py {
				delete(m.coins, id)
				m.counts[p.ID]++
				events = append(events, CoinEvent{
					Type:     CoinEventCollected,
					CoinID:   id,
					PlayerID: p.ID,
					X:        c.X,
					Y:        c.Y,
				})
				break
			}
		}
	}
	return events
}

// Count devolve o contador de moedas da fase de um jogador (0 se nunca
// coletou ou se morreu e foi zerado).
func (m *CoinManager) Count(id string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.counts[id]
}

// Counts devolve uma cópia de todos os contadores da fase (playerID → moedas
// coletadas no mapa atual). Usado no broadcast de contagens para o HUD.
func (m *CoinManager) Counts() map[string]int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]int, len(m.counts))
	for id, n := range m.counts {
		out[id] = n
	}
	return out
}

// ResetPlayer zera o contador de moedas da fase de um jogador — chamado na
// morte dentro do mapa atual. A carteira persistente/gasta (Sim.Coins, loja
// entre fases) NÃO é tocada: ela mora em outra camada e sobrevive à morte.
func (m *CoinManager) ResetPlayer(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counts[id] = 0
}

// Snapshot devolve o estado serializável das moedas restantes, ordenado por
// ID (ordem estável para broadcast/renderização).
func (m *CoinManager) Snapshot() []CoinState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]CoinState, 0, len(m.coins))
	for _, c := range m.coins {
		out = append(out, CoinState{
			ID: c.ID,
			X:  int(math.Round(c.X)),
			Y:  int(math.Round(c.Y)),
			W:  int(math.Round(c.W)),
			H:  int(math.Round(c.H)),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// CountCoins devolve o número de moedas ainda no mundo da fase.
func (m *CoinManager) CountCoins() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.coins)
}

// Reset limpa todas as moedas e zera todos os contadores — usado ao reiniciar
// a fase (novo ciclo de mapa). A carteira persistente não é tocada.
func (m *CoinManager) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.coins = make(map[string]*Coin)
	m.counts = make(map[string]int)
}
