// Package game — power-ups coletáveis da fase (autoritativo, server-side).
//
// Este arquivo implementa o gerente de power-ups do servidor, dono do estado
// dos power-ups da fase atual:
//
//   - PowerUp: entidade coletável com ID único, TIPO (vida / tiro_triplo /
//     escudo) e hitbox AABB em pixels — espelha o padrão de Coin (coins.go);
//   - coleta por sobreposição (AABB player × power-up): o power-up é
//     removido e um evento é devolvido para o servidor aplicar o EFEITO
//     (o manager registra o efeito ativo; a consequência no mundo — HP no
//     Sim, projéteis no tiro — é da camada que liga ao jogo, main.go);
//   - efeitos ativos POR JOGADOR, com duração e limpeza:
//     VIDA        → +PowerUpVidaBonus de HP ACIMA do teto (temporário:
//     some no respawn/fim de fase por construção);
//     TIRO TRIPLO → dura exatamente PowerUpTiroTriploDurationTicks ticks
//     (200 @ 20 tps = 10 s), 3 projéteis por disparo;
//     ESCUDO      → absorve exatamente 1 dano e some ao ser atingido;
//   - TODOS os efeitos ativos somem na morte do jogador (ClearPlayer, mesmo
//     padrão da regra de moedas: morrer no mapa zera o que era da fase).
//
// O posicionamento é decidido pelo gerador de fase (level.go,
// Level.PowerUpSpawns: raros — no máximo PowerUpMaxPerPhase por fase, no
// máximo um de cada tipo — com variação seed-dependente). Este gerente
// apenas registra cada power-up com ID único (p1, p2, …) e converte
// tile→pixels: centro da coluna, flutuando PowerUpFloatHeight px acima do
// topo do tile. Tudo é determinístico: mesma fase (mesmo grid) produz
// exatamente o mesmo conjunto de power-ups. Thread-safe.
package game

import (
	"math"
	"sort"
	"strconv"
	"sync"
)

// Dimensões e posicionamento dos power-ups (alinhados à renderização do
// client — apps/web/src/powerups.ts).
const (
	// PowerUpDefaultWidth / PowerUpDefaultHeight: hitbox do power-up em
	// pixels (maior que a moeda 14x14 — coletável raro merece área de
	// captura generosa).
	PowerUpDefaultWidth  = 20.0
	PowerUpDefaultHeight = 20.0
	// PowerUpFloatHeight: distância do CENTRO do power-up ao topo do tile de
	// apoio (36 > CoinFloatHeight 30 — flutua acima da moeda quando
	// co-localizado, ambos visíveis).
	PowerUpFloatHeight = 36.0
	// PowerUpMaxPerPhase: teto de power-ups por fase (raridade em
	// quantidade — 1 a 3 por fase contra ~30 moedas). Usado pelo gerador de
	// fase (level.go, Level.PowerUpSpawns).
	PowerUpMaxPerPhase = 3
	// PowerUpVidaBonus: HP adicional ACIMA do teto concedido pelo VIDA
	// (100 → 125). Temporário: respawn e fim de fase restauram HP=MaxHP.
	PowerUpVidaBonus = 25
	// PowerUpTiroTriploDurationTicks: duração do TIRO TRIPLO em ticks do
	// relógio do servidor (200 @ 20 tps = exatamente 10 s).
	PowerUpTiroTriploDurationTicks = 200
)

// PowerUpType identifica um dos três power-ups da fase.
type PowerUpType int

const (
	// PowerUpVida: +PowerUpVidaBonus de HP acima do teto (temporário).
	PowerUpVida PowerUpType = iota
	// PowerUpTiroTriplo: 3 projéteis por disparo por PowerUpTiroTriploDurationTicks.
	PowerUpTiroTriplo
	// PowerUpEscudo: absorve 1 dano e some ao ser atingido.
	PowerUpEscudo
)

// String devolve o nome do tipo como enviado ao client ("vida"/
// "tiro_triplo"/"escudo" — o client usa esses nomes para renderizar cada
// tipo e aplicar o efeito no HUD).
func (t PowerUpType) String() string {
	switch t {
	case PowerUpTiroTriplo:
		return "tiro_triplo"
	case PowerUpEscudo:
		return "escudo"
	}
	return "vida"
}

// Valid diz se o tipo é um dos três power-ups conhecidos.
func (t PowerUpType) Valid() bool {
	return t >= PowerUpVida && t <= PowerUpEscudo
}

// PowerUp é um power-up da fase: hitbox AABB em pixels (X/Y = canto superior
// esquerdo, Y cresce para baixo — mesma convenção de Coin/PlayerState) e ID
// único no mundo.
type PowerUp struct {
	ID   string
	Kind PowerUpType
	X, Y float64
	W, H float64
}

// PowerUpState é o estado sincronizado de um power-up, enviado ao client via
// broadcast para renderização.
type PowerUpState struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// PowerUpRemoved descreve um power-up removido (coletado) em uma atualização:
// ID + tipo + posição para o client tocar o efeito de coleta mesmo sem ter o
// objeto localmente (power-ups são autoritativos do servidor).
type PowerUpRemoved struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
}

// PowerUpConfig configura o gerente de power-ups. Campos <= 0 usam os
// defaults (constantes do pacote).
type PowerUpConfig struct {
	Width  float64 // hitbox do power-up (default PowerUpDefaultWidth)
	Height float64 // hitbox do power-up (default PowerUpDefaultHeight)
}

func (c PowerUpConfig) withDefaults() PowerUpConfig {
	if c.Width <= 0 {
		c.Width = PowerUpDefaultWidth
	}
	if c.Height <= 0 {
		c.Height = PowerUpDefaultHeight
	}
	return c
}

// PowerUpEventType identifica um evento emitido pelo gerente de power-ups.
type PowerUpEventType int

const (
	// PowerUpEventCollected: power-up coletado por um jogador (PowerUpID
	// removido; PlayerID = coletor; Kind = tipo; X/Y = posição do power-up
	// para efeitos no client). O servidor aplica o efeito correspondente.
	PowerUpEventCollected PowerUpEventType = iota
)

// PowerUpEvent é um fato ocorrido na simulação de power-ups, emitido para o
// servidor aplicar as consequências (efeito do tipo + broadcast de remoção).
type PowerUpEvent struct {
	Type      PowerUpEventType
	PowerUpID string
	Kind      PowerUpType
	PlayerID  string
	X, Y      float64
}

// playerEffects é o estado de efeitos ativos de UM jogador (interno).
type playerEffects struct {
	vidaBonus   int   // HP acima do teto concedido pelo VIDA (0 = sem efeito)
	tripleUntil int64 // tick de expiração do TIRO TRIPLO (0 = inativo)
	shield      int   // cargas do ESCUDO (0/1)
}

// temEfeito diz se o jogador tem QUALQUER efeito ativo (para o snapshot wire).
func (e *playerEffects) temEfeito(tick int64) bool {
	return e.vidaBonus > 0 || e.tripleUntil > tick || e.shield > 0
}

// PlayerPowerUpsState é o estado sincronizado dos efeitos ativos de um
// jogador, enviado ao client para o HUD:
//
//	vida       — HP ACIMA do teto concedido (0 = sem efeito);
//	tripleShot — TICKS RESTANTES do tiro triplo (0 = inativo; o client
//	             converte para segundos com TicksPerSecond = 20);
//	shield     — cargas de escudo restantes (0/1).
type PlayerPowerUpsState struct {
	Vida       int `json:"vida"`
	TripleShot int `json:"tripleShot"`
	Shield     int `json:"shield"`
}

// PowerUpManager gerencia os power-ups da fase atual: entidades coletáveis
// (posição + tipo + ID único) e os EFEITOS ATIVOS por jogador (vida acima do
// teto, tiro triplo com expiração por tick, escudo de 1 carga). Thread-safe.
type PowerUpManager struct {
	mu       sync.RWMutex
	cfg      PowerUpConfig
	nextID   int
	powerups map[string]*PowerUp
	effects  map[string]*playerEffects
	tick     int64 // relógio interno (avançado por Step — uma chamada por tick do loop)
}

// NewPowerUpManager cria um gerente de power-ups com a config dada.
func NewPowerUpManager(cfg PowerUpConfig) *PowerUpManager {
	return &PowerUpManager{
		cfg:      cfg.withDefaults(),
		powerups: make(map[string]*PowerUp),
		effects:  make(map[string]*playerEffects),
	}
}

// NewPowerUpManagerDefault cria um gerente com as regras padrão (hitbox
// 20x20, mesma do client).
func NewPowerUpManagerDefault() *PowerUpManager {
	return NewPowerUpManager(PowerUpConfig{})
}

// spawnLocked cria o power-up com o próximo ID. Deve ser chamada com o lock
// held.
func (m *PowerUpManager) spawnLocked(x, y float64, kind PowerUpType) *PowerUp {
	m.nextID++
	p := &PowerUp{
		ID:   "p" + strconv.Itoa(m.nextID),
		Kind: kind,
		X:    x,
		Y:    y,
		W:    m.cfg.Width,
		H:    m.cfg.Height,
	}
	m.powerups[p.ID] = p
	return p
}

// SpawnForLevel registra os power-ups da fase no gerente: um por posição de
// Level.PowerUpSpawns (raros, decididos pelo gerador em level.go — nunca
// enterrados). Cada power-up ganha um ID único sequencial (p1, p2, …) e
// flutua PowerUpFloatHeight px acima do topo do tile, centralizado na
// coluna, com o tipo do spawn preservado. Determinístico: a mesma fase
// (mesmo grid) produz exatamente o mesmo conjunto. Devolve quantos foram
// criados.
func (m *PowerUpManager) SpawnForLevel(l *Level) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sp := range l.PowerUpSpawns {
		cx := float64(sp.Tile.X*TileSize) + TileSize/2.0
		cy := float64(sp.Tile.Y*TileSize) - PowerUpFloatHeight
		m.spawnLocked(cx-m.cfg.Width/2, cy-m.cfg.Height/2, sp.Kind)
	}
	return len(l.PowerUpSpawns)
}

// Step avança o relógio interno (1 por tick do loop) e detecta sobreposição
// AABB entre jogadores vivos e power-ups. Cada power-up tocado é removido na
// hora e um evento por coleta é devolvido para o servidor aplicar o efeito e
// broadcastar (remoções + efeitos). Jogador morto (HP <= 0) não coleta.
// Ordem determinística: power-ups por ID e jogadores por ID — mesmos estados
// produzem exatamente os mesmos eventos. Se dois jogadores tocam o mesmo
// power-up no mesmo tick, o de menor ID o coleta.
func (m *PowerUpManager) Step(players []Player) []PowerUpEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tick++
	if len(m.powerups) == 0 {
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

	// Power-ups ordenados por ID (determinismo).
	ids := make([]string, 0, len(m.powerups))
	for id := range m.powerups {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var events []PowerUpEvent
	for _, id := range ids {
		pw := m.powerups[id]
		for _, p := range alive {
			px, py := float64(p.X), float64(p.Y)
			if pw.X < px+PlayerWidth && pw.X+pw.W > px &&
				pw.Y < py+PlayerHeight && pw.Y+pw.H > py {
				delete(m.powerups, id)
				events = append(events, PowerUpEvent{
					Type:      PowerUpEventCollected,
					PowerUpID: id,
					Kind:      pw.Kind,
					PlayerID:  p.ID,
					X:         pw.X,
					Y:         pw.Y,
				})
				break
			}
		}
	}
	return events
}

// ApplyCollected registra o efeito ativo do power-up coletado no jogador
// (chamado pelo servidor ao processar um PowerUpEventCollected):
//
//	VIDA        → concede PowerUpVidaBonus de HP acima do teto;
//	TIRO TRIPLO → expira em PowerUpTiroTriploDurationTicks ticks a partir do
//	              tick atual (re-coletar renova);
//	ESCUDO      → concede 1 carga (máx 1 — re-coletar mantém 1).
//
// Tipo desconhecido é ignorado (no-op).
func (m *PowerUpManager) ApplyCollected(playerID string, kind PowerUpType) {
	if !kind.Valid() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.effects[playerID]
	if e == nil {
		e = &playerEffects{}
		m.effects[playerID] = e
	}
	switch kind {
	case PowerUpVida:
		e.vidaBonus = PowerUpVidaBonus
	case PowerUpTiroTriplo:
		e.tripleUntil = m.tick + PowerUpTiroTriploDurationTicks
	case PowerUpEscudo:
		e.shield = 1
	}
}

// VidaBonusOf devolve o bônus de HP acima do teto do jogador (0 se nunca
// coletou VIDA ou se o efeito foi limpo na morte).
func (m *PowerUpManager) VidaBonusOf(id string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if e := m.effects[id]; e != nil {
		return e.vidaBonus
	}
	return 0
}

// TripleShotActive diz se o TIRO TRIPLO do jogador está ativo no tick atual
// (coletado há menos de PowerUpTiroTriploDurationTicks).
func (m *PowerUpManager) TripleShotActive(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e := m.effects[id]
	return e != nil && e.tripleUntil > m.tick
}

// ConsumeShield absorve um hit com o ESCUDO do jogador. Devolve true se havia
// carga (e ela foi gasta — o escudo some ao ser atingido); false caso
// contrário.
func (m *PowerUpManager) ConsumeShield(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.effects[id]
	if e == nil || e.shield <= 0 {
		return false
	}
	e.shield--
	return true
}

// ClearPlayer remove TODOS os efeitos ativos do jogador — chamado na morte
// (efeito morre junto com o player, mesma regra do contador de moedas da
// fase). Outros jogadores não são afetados.
func (m *PowerUpManager) ClearPlayer(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.effects, id)
}

// Snapshot devolve o estado serializável dos power-ups restantes, ordenado
// por ID (ordem estável para broadcast/renderização).
func (m *PowerUpManager) Snapshot() []PowerUpState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]PowerUpState, 0, len(m.powerups))
	for _, p := range m.powerups {
		out = append(out, PowerUpState{
			ID:   p.ID,
			Kind: p.Kind.String(),
			X:    int(math.Round(p.X)),
			Y:    int(math.Round(p.Y)),
			W:    int(math.Round(p.W)),
			H:    int(math.Round(p.H)),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// EffectsSnapshot devolve o estado wire dos efeitos ativos de TODOS os
// jogadores (id → efeitos), com o tiro triplo em TICKS RESTANTES (0 =
// inativo). Só jogadores com algum efeito ativo aparecem. Usado no broadcast
// para o HUD do client.
func (m *PowerUpManager) EffectsSnapshot() map[string]PlayerPowerUpsState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]PlayerPowerUpsState, len(m.effects))
	for id, e := range m.effects {
		if !e.temEfeito(m.tick) {
			continue
		}
		rest := e.tripleUntil - m.tick
		if rest < 0 {
			rest = 0
		}
		out[id] = PlayerPowerUpsState{
			Vida:       e.vidaBonus,
			TripleShot: int(rest),
			Shield:     e.shield,
		}
	}
	return out
}

// CountPowerUps devolve o número de power-ups ainda no mundo da fase.
func (m *PowerUpManager) CountPowerUps() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.powerups)
}

// Reset limpa todos os power-ups, TODOS os efeitos ativos e zera o relógio
// interno — usado ao reiniciar a fase (efeitos de uma fase não vazam para a
// próxima).
func (m *PowerUpManager) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.powerups = make(map[string]*PowerUp)
	m.effects = make(map[string]*playerEffects)
	m.tick = 0
}
