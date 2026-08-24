// Package game — motor de simulação autoritativa do coop-blocks.
//
// Implementa o núcleo de regras planejado no README/docs (servidor autoritativo
// com tick fixo de 20 tps): avanço de tick, dano, morte/respawn, squad wipe e
// moedas. A aleatoriedade é injetável (RandomSource) para manter os testes
// determinísticos.
package game

import (
	"errors"
	"math/rand"
	"sort"
	"sync"
)

// Constantes de regra do jogo (alinhadas ao client atual — apps/web/src).
const (
	// DefaultMaxHP é a vida máxima inicial de um jogador (client: HP 100).
	DefaultMaxHP = 100
	// DefaultContactDamage é o dano de colisão com inimigo (client: -10 HP).
	DefaultContactDamage = 10
	// DefaultRespawnTicks é o tempo de respawn em ticks (60 ticks @ 20 tps = 3 s).
	DefaultRespawnTicks = 60
	// DefaultMinCoinDrop / DefaultMaxCoinDrop: faixa de moedas por coleta.
	DefaultMinCoinDrop = 1
	DefaultMaxCoinDrop = 1
	// TicksPerSecond é a taxa alvo do loop autoritativo (50 ms por tick).
	TicksPerSecond = 20
)

// Erros do motor de simulação.
var (
	ErrPlayerNotFound    = errors.New("jogador não encontrado")
	ErrPlayerDead        = errors.New("jogador morto")
	ErrInsufficientCoins = errors.New("moedas insuficientes")
	ErrNegativeAmount    = errors.New("quantidade deve ser positiva")
)

// RandomSource é a fonte de aleatoriedade do motor. Injetável para que os
// testes usem sequências fixas e determinísticas.
type RandomSource interface {
	// Intn retorna um inteiro em [0, n). n > 0.
	Intn(n int) int
}

type mathRandSource struct{ r *rand.Rand }

func (s mathRandSource) Intn(n int) int { return s.r.Intn(n) }

// NewRandomSource cria uma fonte de aleatoriedade baseada em math/rand com a
// seed dada. Duas fontes com a mesma seed produzem a mesma sequência.
func NewRandomSource(seed int64) RandomSource {
	return mathRandSource{r: rand.New(rand.NewSource(seed))}
}

// EventType identifica um evento emitido pelo motor.
type EventType int

const (
	EventDeath     EventType = iota // jogador morreu (HP <= 0)
	EventRespawn                    // jogador renasceu
	EventWipe                       // squad inteiro morreu (squad wipe)
	EventCoinGain                   // jogador ganhou moedas
	EventCoinSpend                  // jogador gastou moedas
)

// Event é um fato ocorrido na simulação, emitido para o servidor poder
// broadcastar (morte, respawn, wipe, moedas).
type Event struct {
	Type     EventType
	PlayerID string
	Amount   int
	Tick     int64
}

// SimPlayer é o estado simulado de um jogador dentro do motor.
type SimPlayer struct {
	ID        string
	HP        int
	MaxHP     int
	Coins     int
	Alive     bool
	RespawnIn int // ticks restantes até o respawn (0 = sem respawn agendado)
	Deaths    int // total de mortes na partida
}

// SimConfig configura o motor de simulação. Campos <= 0 usam os defaults.
type SimConfig struct {
	MaxHP         int // vida máxima (default DefaultMaxHP)
	ContactDamage int // dano de contato (default DefaultContactDamage)
	RespawnTicks  int // ticks até respawn (default DefaultRespawnTicks)
	MinCoinDrop   int // menor coleta de moeda (default DefaultMinCoinDrop)
	MaxCoinDrop   int // maior coleta de moeda (default DefaultMaxCoinDrop)
}

func (c SimConfig) withDefaults() SimConfig {
	if c.MaxHP <= 0 {
		c.MaxHP = DefaultMaxHP
	}
	if c.ContactDamage <= 0 {
		c.ContactDamage = DefaultContactDamage
	}
	if c.RespawnTicks <= 0 {
		c.RespawnTicks = DefaultRespawnTicks
	}
	if c.MinCoinDrop <= 0 {
		c.MinCoinDrop = DefaultMinCoinDrop
	}
	if c.MaxCoinDrop < c.MinCoinDrop {
		c.MaxCoinDrop = c.MinCoinDrop
	}
	return c
}

// Sim é o motor de simulação autoritativo. Não é uma goroutine: o chamador
// (loop do servidor) invoca Tick() a cada tick (20 tps no alvo).
type Sim struct {
	mu        sync.RWMutex
	cfg       SimConfig
	rng       RandomSource
	tick      int64
	players   map[string]*SimPlayer
	wiped     bool
	wipeCount int
}

// NewSim cria um motor de simulação com a fonte de aleatoriedade e a config
// dadas. rng nunca é trocado depois da criação (determinismo por seed).
func NewSim(rng RandomSource, cfg SimConfig) *Sim {
	return &Sim{
		cfg:     cfg.withDefaults(),
		rng:     rng,
		players: make(map[string]*SimPlayer),
	}
}

// NewSimDefault cria um motor com as regras padrão (HP 100, dano 10,
// respawn de 3 s, coleta de 1 moeda).
func NewSimDefault(rng RandomSource) *Sim {
	return NewSim(rng, SimConfig{})
}

// AddPlayer adiciona um jogador vivo com HP cheio e 0 moedas. Se o ID já
// existe (reconexão), retorna o jogador existente sem duplicar.
func (s *Sim) AddPlayer(id string) *SimPlayer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.players[id]; ok {
		return p
	}
	p := &SimPlayer{
		ID:    id,
		HP:    s.cfg.MaxHP,
		MaxHP: s.cfg.MaxHP,
		Alive: true,
	}
	s.players[id] = p
	return p
}

// RemovePlayer tira o jogador do sim de uma vez (estado, carteira e tudo):
// desconectou da sala, some da simulação e dos próximos broadcasts. Se o ID
// não existe, é no-op (idempotente).
func (s *Sim) RemovePlayer(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.players, id)
}

// GetPlayer retorna o estado simulado de um jogador.
func (s *Sim) GetPlayer(id string) (*SimPlayer, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.players[id]
	return p, ok
}

// Snapshot devolve cópias ordenadas por ID do estado de todos os jogadores.
// A ordem estável garante consistência entre ticks/broadcasts.
func (s *Sim) Snapshot() []SimPlayer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]SimPlayer, 0, len(s.players))
	for _, p := range s.players {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// TickCount devolve o número de ticks já avançados.
func (s *Sim) TickCount() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tick
}

// Tick avança a simulação em um tick: decrementa contadores de respawn,
// renasce jogadores agendados e reavalia o squad wipe. Retorna os eventos
// ocorridos neste tick (respawns; wipe apenas na transição para todos-mortos).
func (s *Sim) Tick() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tick++
	var events []Event
	for _, p := range s.players {
		if p.Alive || p.RespawnIn <= 0 {
			continue
		}
		p.RespawnIn--
		if p.RespawnIn == 0 {
			p.HP = p.MaxHP
			p.Alive = true
			events = append(events, Event{Type: EventRespawn, PlayerID: p.ID, Tick: s.tick})
		}
	}
	events = append(events, s.checkWipeLocked()...)
	return events
}

// ApplyDamage aplica dano a um jogador vivo. Se o HP chegar a 0, o jogador
// morre: fica morto, agenda o respawn e conta a morte (HP é limitado a 0,
// nunca fica negativo). Retorna os eventos: morte e, se for o último vivo
// da squad, squad wipe.
func (s *Sim) ApplyDamage(id string, amount int) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if amount <= 0 {
		return nil, ErrNegativeAmount
	}
	p, ok := s.players[id]
	if !ok {
		return nil, ErrPlayerNotFound
	}
	if !p.Alive {
		return nil, ErrPlayerDead
	}
	p.HP -= amount
	var events []Event
	if p.HP <= 0 {
		p.HP = 0
		p.Alive = false
		p.Deaths++
		p.RespawnIn = s.cfg.RespawnTicks
		events = append(events, Event{Type: EventDeath, PlayerID: id, Tick: s.tick})
	}
	events = append(events, s.checkWipeLocked()...)
	return events, nil
}

// ApplyContactDamage aplica o dano de contato padrão da config (colisão com
// inimigo no client).
func (s *Sim) ApplyContactDamage(id string) ([]Event, error) {
	return s.ApplyDamage(id, s.cfg.ContactDamage)
}

// CollectCoin coleta uma moeda: o valor é sorteado da fonte de aleatoriedade
// injetada dentro de [MinCoinDrop, MaxCoinDrop]. Jogador morto não coleta.
// Retorna a quantidade coletada e o evento de ganho.
func (s *Sim) CollectCoin(id string) (int, []Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.players[id]
	if !ok {
		return 0, nil, ErrPlayerNotFound
	}
	if !p.Alive {
		return 0, nil, ErrPlayerDead
	}
	amount := s.cfg.MinCoinDrop + s.rng.Intn(s.cfg.MaxCoinDrop-s.cfg.MinCoinDrop+1)
	p.Coins += amount
	return amount, []Event{{Type: EventCoinGain, PlayerID: id, Amount: amount, Tick: s.tick}}, nil
}

// AddCoins credita moedas de forma determinística (ex.: recompensa de fim de
// fase). Não exige jogador vivo — a economia é persistente na sessão.
func (s *Sim) AddCoins(id string, n int) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= 0 {
		return nil, ErrNegativeAmount
	}
	p, ok := s.players[id]
	if !ok {
		return nil, ErrPlayerNotFound
	}
	p.Coins += n
	return []Event{{Type: EventCoinGain, PlayerID: id, Amount: n, Tick: s.tick}}, nil
}

// SpendCoins debita moedas (ex.: loja entre fases). Retorna
// ErrInsufficientCoins se o saldo não cobrir; o saldo nunca fica negativo.
func (s *Sim) SpendCoins(id string, n int) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= 0 {
		return nil, ErrNegativeAmount
	}
	p, ok := s.players[id]
	if !ok {
		return nil, ErrPlayerNotFound
	}
	if p.Coins < n {
		return nil, ErrInsufficientCoins
	}
	p.Coins -= n
	return []Event{{Type: EventCoinSpend, PlayerID: id, Amount: n, Tick: s.tick}}, nil
}

// Balance devolve o saldo de moedas do jogador e false se ele não existe.
// Implementa CoinWallet (loja): o saldo é INDIVIDUAL — não existe carteira
// compartilhada do time.
func (s *Sim) Balance(id string) (int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.players[id]
	if !ok {
		return 0, false
	}
	return p.Coins, true
}

// Spend debita moedas do jogador com a mesma semântica de SpendCoins
// (ErrInsufficientCoins se o saldo não cobrir; nunca fica negativo).
// Implementa CoinWallet (loja): o débito atinge apenas o saldo do jogador.
func (s *Sim) Spend(id string, n int) error {
	_, err := s.SpendCoins(id, n)
	return err
}

// SetMaxHP redefine o teto de vida de um jogador (efeito do upgrade max_hp
// da loja). Só aceita teto MAIOR que o atual (upgrades não caem). Vivo, o
// delta é curado junto (HP sobe com o teto, cap no novo máximo). O teto
// elevado persiste no respawn (respawn usa p.MaxHP).
func (s *Sim) SetMaxHP(id string, maxHP int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.players[id]
	if !ok {
		return ErrPlayerNotFound
	}
	if maxHP <= p.MaxHP {
		return errors.New("teto de HP só pode subir (upgrade de max_hp)")
	}
	delta := maxHP - p.MaxHP
	p.MaxHP = maxHP
	if p.Alive {
		p.HP += delta // cura o delta; o dano já sofrido continua descontado
		if p.HP > p.MaxHP {
			p.HP = p.MaxHP
		}
	}
	return nil
}

// ReviveAll revive TODOS os jogadores no início de uma nova fase: vivos com
// HP cheio (teto individual preservado — upgrades da run nunca regridem), sem
// respawn pendente. A carteira de moedas NÃO é tocada — a economia da run
// persiste entre fases e é o que a loja gasta no intervalo.
func (s *Sim) ReviveAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.players {
		p.Alive = true
		p.HP = p.MaxHP
		p.RespawnIn = 0
	}
	s.wiped = false
}

// IsWiped devolve true quando a squad inteira está morta (squad wipe).
func (s *Sim) IsWiped() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.wiped
}

// WipeCount conta quantas vezes a squad entrou em wipe (transições para
// todos-mortos).
func (s *Sim) WipeCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.wipeCount
}

// checkWipeLocked detecta a transição para squad wipe (todos mortos) e
// devolve o evento apenas na borda de subida. Deve ser chamada com o lock
// held. Squad vazia (0 jogadores) não conta como wipe.
func (s *Sim) checkWipeLocked() []Event {
	alive := 0
	for _, p := range s.players {
		if p.Alive {
			alive++
		}
	}
	allDead := len(s.players) > 0 && alive == 0
	if allDead {
		if !s.wiped {
			s.wiped = true
			s.wipeCount++
			return []Event{{Type: EventWipe, Tick: s.tick}}
		}
	} else {
		s.wiped = false
	}
	return nil
}
