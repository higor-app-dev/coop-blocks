// Package game — inimigos simulados no servidor (autoritativo e determinístico).
//
// Este arquivo implementa os 3 tipos de inimigo controlados pelo servidor:
//
//   - ANDADOR: patrulha horizontal no chão, vira em paredes e em buracos
//     (lacunas do grid); disponível nas fases 1+.
//   - VOADOR: flutua (ignora gravidade e buracos) e segue um padrão senoidal
//     vertical enquanto deriva na horizontal; disponível nas fases 3+.
//   - ATIRADOR: parado, dispara projéteis em direção ao jogador-alvo escolhido
//     por regra determinística (mais próximo; empate desfeito pelo ID do
//     jogador); disponível nas fases 5+.
//
// Toda a IA é determinística: usa o mesmo PRNG mulberry32 da geração de fase
// (level.go), semeado pela seed da sala/fase. Dois servidores (ou dois
// observadores) com a mesma seed veem exatamente a mesma sequência de estados.
//
// O sistema de projéteis de jogadores destrói inimigos (ApplyDamage) e o
// contato com o jogador causa dano (evento EnemyEventPlayerHit). A destruição
// devolve o evento EnemyEventDestroyed com a quantidade de moedas e a posição
// final do inimigo — o servidor spawna moedas coletáveis nessa posição
// (CoinManager.SpawnDrop, mesma trilha de coleta/zeramento das moedas
// geradas). O tiro do atirador é encaminhado ao sistema de projéteis via hook
// OnShoot (no servidor: ProjectileSystem.FireEnemyShot).
package game

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// Fases em que cada tipo de inimigo fica disponível (gates de fase).
const (
	EnemyAndadorPhase  = 1
	EnemyVoadorPhase   = 3
	EnemyAtiradorPhase = 5
	// EnemyDefaultPhase é a fase assumida quando nenhuma é configurada.
	EnemyDefaultPhase = 1
)

// Dimensões das hitboxes dos inimigos em pixels.
const (
	EnemyAndadorWidth   = 30.0
	EnemyAndadorHeight  = 30.0
	EnemyVoadorWidth    = 34.0
	EnemyVoadorHeight   = 28.0
	EnemyAtiradorWidth  = 30.0
	EnemyAtiradorHeight = 36.0
)

// Velocidades e regras de movimento.
const (
	// EnemyAndadorSpeed: velocidade horizontal da patrulha (client: 60).
	EnemyAndadorSpeed = 60.0
	// EnemyVoadorSpeed: deriva horizontal do voador.
	EnemyVoadorSpeed = 45.0
	// EnemyVoadorAmplitude: amplitude do seno vertical em pixels.
	EnemyVoadorAmplitude = 14.0
	// EnemyVoadorFrequency: frequência do seno em ciclos por segundo.
	EnemyVoadorFrequency = 1.5
	// EnemyGravity / EnemyMaxFallSpeed: gravidade do andador (mesma do player).
	EnemyGravity      = 980.0
	EnemyMaxFallSpeed = 900.0
)

// Regras do atirador.
const (
	// EnemyAtiradorShotSpeed: velocidade do projétil hostil em px/s.
	EnemyAtiradorShotSpeed = 260.0
	// EnemyAtiradorShotLifetime: tempo de vida do projétil hostil em segundos.
	EnemyAtiradorShotLifetime = 4.0
	// EnemyAtiradorCooldownTicks: ticks entre disparos (40 @ 20 tps = 2 s).
	EnemyAtiradorCooldownTicks = 40
)

// Vida de cada tipo (o tiro do player causa 25 de dano: andador morre em 1
// tiro, voador e atirador em 2).
const (
	EnemyAndadorHP  = 25
	EnemyVoadorHP   = 50
	EnemyAtiradorHP = 50
)

// Regras de contato e moedas.
const (
	// EnemyContactDamage: dano de contato com o jogador (client: -10 HP).
	EnemyContactDamage = 10
	// EnemyContactCooldownTicks: ticks de invulnerabilidade pós-contato por
	// jogador (30 @ 20 tps = 1,5 s) — evita derreter o HP em um único contato.
	EnemyContactCooldownTicks = 30
	// EnemyMinCoinDrop / EnemyMaxCoinDrop: faixa de moedas dropadas na
	// destruição (sorteada do RNG semeado da sala).
	EnemyMinCoinDrop = 1
	EnemyMaxCoinDrop = 3
)

// EnemyType identifica um dos três comportamentos determinísticos.
type EnemyType int

const (
	EnemyAndadorType EnemyType = iota
	EnemyVoadorType
	EnemyAtiradorType
)

// String devolve o nome do tipo como enviado ao client ("andador"/"voador"/
// "atirador" — o client usa esses nomes para renderizar cada tipo).
func (t EnemyType) String() string {
	switch t {
	case EnemyVoadorType:
		return "voador"
	case EnemyAtiradorType:
		return "atirador"
	}
	return "andador"
}

// Enemy é um inimigo simulado. Posição (X, Y) é o canto superior esquerdo da
// hitbox em pixels; Y cresce para baixo (mesma convenção do grid de Level).
// VX/VY são velocidades em px/s. Phase é a fase em que o inimigo foi spawnado
// (o tipo respeita o gate de fase correspondente).
type Enemy struct {
	ID    string
	Type  EnemyType
	X, Y  float64
	W, H  float64
	VX    float64
	VY    float64
	HP    int
	Phase int

	// Estado interno da IA (não serializado).
	dir      int     // facing: 1 = direita, -1 = esquerda
	t        float64 // relógio local do inimigo (seno do voador)
	baseY    float64 // âncora vertical do voador (oscila em torno dela)
	shootIn  int     // ticks restantes até o próximo tiro do atirador
	grounded bool    // andador apoiado no chão
}

// EnemyConfig configura o sistema de inimigos. Campos <= 0 usam os defaults
// (constantes do pacote).
type EnemyConfig struct {
	AndadorHP    int
	VoadorHP     int
	AtiradorHP   int
	AndadorSpeed float64
	VoadorSpeed  float64

	VoadorAmplitude float64
	VoadorFrequency float64

	AtiradorShotSpeed     float64
	AtiradorShotLifetime  float64
	AtiradorCooldownTicks int

	ContactDamage        int
	ContactCooldownTicks int

	CoinMin int
	CoinMax int
}

func (c EnemyConfig) withDefaults() EnemyConfig {
	if c.AndadorHP <= 0 {
		c.AndadorHP = EnemyAndadorHP
	}
	if c.VoadorHP <= 0 {
		c.VoadorHP = EnemyVoadorHP
	}
	if c.AtiradorHP <= 0 {
		c.AtiradorHP = EnemyAtiradorHP
	}
	if c.AndadorSpeed <= 0 {
		c.AndadorSpeed = EnemyAndadorSpeed
	}
	if c.VoadorSpeed <= 0 {
		c.VoadorSpeed = EnemyVoadorSpeed
	}
	if c.VoadorAmplitude <= 0 {
		c.VoadorAmplitude = EnemyVoadorAmplitude
	}
	if c.VoadorFrequency <= 0 {
		c.VoadorFrequency = EnemyVoadorFrequency
	}
	if c.AtiradorShotSpeed <= 0 {
		c.AtiradorShotSpeed = EnemyAtiradorShotSpeed
	}
	if c.AtiradorShotLifetime <= 0 {
		c.AtiradorShotLifetime = EnemyAtiradorShotLifetime
	}
	if c.AtiradorCooldownTicks <= 0 {
		c.AtiradorCooldownTicks = EnemyAtiradorCooldownTicks
	}
	if c.ContactDamage <= 0 {
		c.ContactDamage = EnemyContactDamage
	}
	if c.ContactCooldownTicks <= 0 {
		c.ContactCooldownTicks = EnemyContactCooldownTicks
	}
	if c.CoinMin <= 0 {
		c.CoinMin = EnemyMinCoinDrop
	}
	if c.CoinMax < c.CoinMin {
		c.CoinMax = c.CoinMin
	}
	return c
}

// EnemyEventType identifica um evento emitido pelo sistema de inimigos.
type EnemyEventType int

const (
	// EnemyEventDestroyed: inimigo destruído por um tiro (PlayerID = atirador;
	// Coins = moedas dropadas).
	EnemyEventDestroyed EnemyEventType = iota
	// EnemyEventPlayerHit: contato com jogador (PlayerID = vítima; Damage =
	// dano de contato). O dano é aplicado pela camada de HP/simulação.
	EnemyEventPlayerHit
)

// EnemyEvent é um fato ocorrido na simulação de inimigos, emitido para o
// servidor aplicar as consequências (dano ao jogador, drop de moedas na
// posição da destruição).
type EnemyEvent struct {
	Type     EnemyEventType
	EnemyID  string
	PlayerID string // atirador (destroyed) ou vítima (player hit)
	Damage   int    // dano de contato (PlayerHit)
	Coins    int    // moedas dropadas (Destroyed)
	X, Y     float64
}

// EnemyShot descreve o disparo de um atirador: origem (centro do atirador) e
// alvo (centro do jogador). O servidor conecta OnShoot ao sistema de projéteis
// (ProjectileSystem.FireEnemyShot); nos testes, o hook captura os disparos.
type EnemyShot struct {
	EnemyID          string
	X, Y             float64 // origem (centro do atirador, px)
	TargetX, TargetY float64 // centro do alvo (px)
	Speed            float64
	Lifetime         float64
}

// EnemyState é o estado sincronizado de um inimigo, enviado ao client via
// broadcast para renderização. X/Y são pixels (top-left da hitbox).
type EnemyState struct {
	ID    string `json:"id"`
	Type  string `json:"type"` // "andador" | "voador" | "atirador"
	X     int    `json:"x"`
	Y     int    `json:"y"`
	HP    int    `json:"hp"`
	Phase int    `json:"phase"`
}

// EnemySystem gerencia todos os inimigos do mundo: spawn por fase (integração
// com levelgen), avanço da IA (Update/Step), destruição por tiro (ApplyDamage)
// e snapshot para o broadcast. É thread-safe: os hooks OnShoot/eventos são
// chamados sem o lock held.
type EnemySystem struct {
	mu        sync.RWMutex
	cfg       EnemyConfig
	rng       func() float64 // mulberry32 semeado pela sala/fase (determinístico)
	phase     int
	nextID    int
	tick      int64
	enemies   map[string]*Enemy
	contactCd map[string]int // ticks restantes de invulnerabilidade por jogador

	onShoot func(EnemyShot)
}

// NewEnemySystem cria um sistema com a config dada e RNG semeado pela seed da
// sala/fase (mesmo PRNG do levelgen, mulberry32). A mesma seed produz a mesma
// sequência de inimigos e comportamentos para todos os jogadores da sala.
func NewEnemySystem(seed uint32, cfg EnemyConfig) *EnemySystem {
	return &EnemySystem{
		cfg:       cfg.withDefaults(),
		rng:       newMulberry32(seed),
		phase:     EnemyDefaultPhase,
		enemies:   make(map[string]*Enemy),
		contactCd: make(map[string]int),
	}
}

// NewEnemySystemDefault cria um sistema com as regras padrão e a seed dada.
func NewEnemySystemDefault(seed uint32) *EnemySystem {
	return NewEnemySystem(seed, EnemyConfig{})
}

// OnShoot registra o hook de disparo do atirador: chamado com cada tiro
// decidido pela IA (fora do lock, pode chamar de volta o sistema de projéteis
// sem deadlock). nil remove o hook.
func (s *EnemySystem) OnShoot(fn func(EnemyShot)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onShoot = fn
}

// Phase devolve a fase atual do sistema.
func (s *EnemySystem) Phase() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.phase
}

// SetPhase define a fase atual (mínimo 1). Controla quais tipos aparecem nos
// próximos SpawnForLevel; inimigos já existentes mantêm a fase de spawn.
func (s *EnemySystem) SetPhase(p int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p < 1 {
		p = 1
	}
	s.phase = p
}

// availableTypesLocked devolve os tipos disponíveis na fase atual, em ordem
// fixa (andador < voador < atirador) para escolha determinística.
func (s *EnemySystem) availableTypesLocked() []EnemyType {
	pool := []EnemyType{}
	if s.phase >= EnemyAndadorPhase {
		pool = append(pool, EnemyAndadorType)
	}
	if s.phase >= EnemyVoadorPhase {
		pool = append(pool, EnemyVoadorType)
	}
	if s.phase >= EnemyAtiradorPhase {
		pool = append(pool, EnemyAtiradorType)
	}
	return pool
}

// Reset limpa o campo para o início de uma nova fase: remove todos os
// inimigos e a invulnerabilidade pós-contato, e re-semeia o RNG com a seed da
// nova fase (determinismo por fase: a mesma fase gera o mesmo elenco e o mesmo
// comportamento para todos os jogadores). Mantém o hook OnShoot e a fase atual
// (SetPhase controla o pool de tipos do próximo SpawnForLevel).
func (s *EnemySystem) Reset(seed uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rng = newMulberry32(seed)
	s.nextID = 0
	s.enemies = make(map[string]*Enemy)
	s.contactCd = make(map[string]int)
}

// SpawnForLevel cria um inimigo em cada EnemySpawns do level (integrado ao
// levelgen), com tipo sorteado do pool disponível na fase atual. Devolve o
// número de inimigos criados. A ordem de consumo do RNG é fixa (spawns já
// ordenados por X), então a mesma seed gera o mesmo elenco.
func (s *EnemySystem) SpawnForLevel(l *Level) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	pool := s.availableTypesLocked()
	spawned := 0
	for _, t := range l.EnemySpawns {
		typ := pool[int(math.Floor(s.rng()*float64(len(pool))))]
		s.spawnEnemyLocked(typ, t, l)
		spawned++
	}
	return spawned
}

// spawnEnemyLocked cria um inimigo na posição de tile dada (pé no chão; o
// voador nasce flutuando um tile acima). Deve ser chamada com o lock held.
func (s *EnemySystem) spawnEnemyLocked(typ EnemyType, t Tile, l *Level) {
	s.nextID++
	var w, h, y float64
	switch typ {
	case EnemyVoadorType:
		w, h = EnemyVoadorWidth, EnemyVoadorHeight
		// Flutua um tile acima do chão (ignora o grid).
		y = float64(t.Y*TileSize) - h - TileSize
	case EnemyAtiradorType:
		w, h = EnemyAtiradorWidth, EnemyAtiradorHeight
		y = float64(t.Y*TileSize) - h
	default:
		w, h = EnemyAndadorWidth, EnemyAndadorHeight
		y = float64(t.Y*TileSize) - h
	}
	e := &Enemy{
		ID:       fmt.Sprintf("e%d", s.nextID),
		Type:     typ,
		X:        float64(t.X * TileSize),
		Y:        y,
		W:        w,
		H:        h,
		HP:       s.cfg.hpFor(typ),
		Phase:    s.phase,
		dir:      1,
		baseY:    y,
		grounded: typ != EnemyVoadorType, // andador/atirador nascem no chão
	}
	// Escalonamento determinístico do primeiro tiro: nem todos os atiradores
	// disparam no mesmo tick (shootIn inicial depende do ID sequencial).
	if typ == EnemyAtiradorType {
		e.shootIn = (s.nextID) % s.cfg.AtiradorCooldownTicks
	}
	s.enemies[e.ID] = e
}

// hpFor devolve a vida padrão de um tipo (respeitando a config).
func (c EnemyConfig) hpFor(typ EnemyType) int {
	switch typ {
	case EnemyVoadorType:
		return c.VoadorHP
	case EnemyAtiradorType:
		return c.AtiradorHP
	}
	return c.AndadorHP
}

// Update avança todos os inimigos em dt segundos contra o grid da fase (l) e
// os jogadores (players, com IDs — use Room.Players()). Aplica a IA de cada
// tipo, detecta contato com jogadores e devolve os eventos deste tick (dano de
// contato, destruições). Os disparos do atirador são entregues ao hook OnShoot
// DEPOIS do lock ser liberado (sem deadlock com o sistema de projéteis).
func (s *EnemySystem) Update(l *Level, players []Player, dt float64) []EnemyEvent {
	if dt <= 0 {
		dt = FixedDT
	}
	s.mu.Lock()
	s.tick++
	var events []EnemyEvent
	var shots []EnemyShot

	// Decai a invulnerabilidade pós-contato de cada jogador.
	for id, cd := range s.contactCd {
		if cd <= 1 {
			delete(s.contactCd, id)
		} else {
			s.contactCd[id] = cd - 1
		}
	}

	for _, e := range s.enemies {
		s.stepEnemyLocked(e, l, players, dt, &events, &shots)
	}
	onShoot := s.onShoot
	s.mu.Unlock()

	if onShoot != nil {
		for _, sh := range shots {
			onShoot(sh)
		}
	}
	return events
}

// Step avança um tick com o timestep fixo (FixedDT = 50 ms). É o método do
// loop determinístico do servidor (20 tps).
func (s *EnemySystem) Step(l *Level, players []Player) []EnemyEvent {
	return s.Update(l, players, FixedDT)
}

// stepEnemyLocked avança a IA de um inimigo e avalia o contato com jogadores.
// Deve ser chamada com o lock held.
func (s *EnemySystem) stepEnemyLocked(e *Enemy, l *Level, players []Player, dt float64, events *[]EnemyEvent, shots *[]EnemyShot) {
	switch e.Type {
	case EnemyVoadorType:
		s.stepVoador(e, l, dt)
	case EnemyAtiradorType:
		s.stepAtirador(e, players, dt, shots)
	default:
		s.stepAndador(e, l, dt)
	}

	// Contato com jogadores (todos os tipos): AABB overlap com a hitbox do
	// jogador (PlayerWidth x PlayerHeight, top-left em PlayerState). O dano
	// respeita a invulnerabilidade pós-contato por jogador.
	for i := range players {
		p := &players[i]
		if p.HP <= 0 {
			continue // morto não toma dano de contato
		}
		px, py := float64(p.X), float64(p.Y)
		if e.X < px+PlayerWidth && e.X+e.W > px &&
			e.Y < py+PlayerHeight && e.Y+e.H > py {
			if s.contactCd[p.ID] <= 0 {
				s.contactCd[p.ID] = s.cfg.ContactCooldownTicks
				*events = append(*events, EnemyEvent{
					Type: EnemyEventPlayerHit, EnemyID: e.ID, PlayerID: p.ID,
					Damage: s.cfg.ContactDamage, X: e.X, Y: e.Y,
				})
			}
		}
	}
}

// stepAndador: patrulha horizontal no chão. Anda na direção atual; vira ao
// encontrar parede sólida OU buraco (lacuna) à frente — nunca cai em buracos.
// Gravidade e colisão com o grid como o PlayerBody (per-axis AABB).
func (s *EnemySystem) stepAndador(e *Enemy, l *Level, dt float64) {
	e.t += dt

	// Gravidade (cai quando perde o chão por qualquer motivo).
	if e.grounded {
		e.VY = 0
	} else {
		e.VY += EnemyGravity * dt
		if e.VY > EnemyMaxFallSpeed {
			e.VY = EnemyMaxFallSpeed
		}
	}

	// Virada: parede ou buraco à frente (borda dianteira).
	e.checkAndadorTurn(l)

	// Eixo X: move e resolve contra paredes (vira no impacto também).
	e.VX = float64(e.dir) * s.cfg.AndadorSpeed
	e.X += e.VX * dt
	s.resolveEnemyX(e, l)

	// Eixo Y: move e resolve contra chão/teto.
	e.Y += e.VY * dt
	s.resolveEnemyY(e, l)
	e.grounded = s.enemyGrounded(e, l)

	s.clampEnemyWorld(e, l)
}

// checkAndadorTurn inverte a direção quando a célula imediatamente à frente do
// corpo é sólida (parede) ou quando não há chão abaixo da borda dianteira
// (buraco). A checagem usa tiles discretos, logo é determinística por fase.
func (e *Enemy) checkAndadorTurn(l *Level) {
	var col int
	if e.dir > 0 {
		col = int(math.Floor((e.X + e.W + 1) / TileSize))
	} else {
		col = int(math.Floor((e.X - 1) / TileSize))
	}
	rowTop := int(math.Floor(e.Y / TileSize))
	rowBot := int(math.Floor((e.Y + e.H - 1) / TileSize))
	wall := false
	for row := rowTop; row <= rowBot; row++ {
		if l.Solid(col, row) {
			wall = true
			break
		}
	}
	// Buraco: chão ausente na fileira logo abaixo dos pés, na coluna dianteira.
	footRow := int(math.Floor((e.Y + e.H + 1) / TileSize))
	pit := !l.Solid(col, footRow)
	if wall || pit {
		e.dir = -e.dir
	}
}

// resolveEnemyX encosta o inimigo na parede no eixo X e inverte a direção no
// impacto (mesma técnica per-axis do PlayerBody).
func (s *EnemySystem) resolveEnemyX(e *Enemy, l *Level) {
	if e.VX > 0 {
		col := int(math.Floor((e.X + e.W - 1) / TileSize))
		y0 := int(math.Floor(e.Y / TileSize))
		y1 := int(math.Floor((e.Y + e.H - 1) / TileSize))
		for ty := y0; ty <= y1; ty++ {
			if l.Solid(col, ty) {
				e.X = float64(col*TileSize) - e.W
				e.dir = -e.dir
				return
			}
		}
	} else if e.VX < 0 {
		col := int(math.Floor(e.X / TileSize))
		y0 := int(math.Floor(e.Y / TileSize))
		y1 := int(math.Floor((e.Y + e.H - 1) / TileSize))
		for ty := y0; ty <= y1; ty++ {
			if l.Solid(col, ty) {
				e.X = float64((col + 1) * TileSize)
				e.dir = -e.dir
				return
			}
		}
	}
}

// resolveEnemyY encosta o inimigo no chão (descendo) ou teto (subindo).
func (s *EnemySystem) resolveEnemyY(e *Enemy, l *Level) {
	x0 := int(math.Floor(e.X / TileSize))
	x1 := int(math.Floor((e.X + e.W - 1) / TileSize))
	if e.VY > 0 {
		row := int(math.Floor((e.Y + e.H - 1) / TileSize))
		for tx := x0; tx <= x1; tx++ {
			if l.Solid(tx, row) {
				e.Y = float64(row*TileSize) - e.H
				e.VY = 0
				e.grounded = true
				return
			}
		}
	} else if e.VY < 0 {
		row := int(math.Floor(e.Y / TileSize))
		for tx := x0; tx <= x1; tx++ {
			if l.Solid(tx, row) {
				e.Y = float64((row + 1) * TileSize)
				e.VY = 0
				return
			}
		}
	}
}

// enemyGrounded devolve true quando há tile sólido imediatamente abaixo dos pés.
func (s *EnemySystem) enemyGrounded(e *Enemy, l *Level) bool {
	x0 := int(math.Floor(e.X / TileSize))
	x1 := int(math.Floor((e.X + e.W - 1) / TileSize))
	row := int(math.Floor((e.Y + e.H) / TileSize))
	for tx := x0; tx <= x1; tx++ {
		if l.Solid(tx, row) {
			return true
		}
	}
	return false
}

// stepVoador: deriva na horizontal (quica nas bordas do mundo e em paredes
// sólidas) e oscila verticalmente em torno da âncora com um seno — ignora
// buracos e gravidade.
func (s *EnemySystem) stepVoador(e *Enemy, l *Level, dt float64) {
	e.t += dt
	e.VX = float64(e.dir) * s.cfg.VoadorSpeed
	e.X += e.VX * dt

	// Borda do mundo: quica.
	maxX := float64(l.Spec.Width*TileSize) - e.W
	if e.X < 0 {
		e.X = 0
		e.dir = 1
	} else if e.X > maxX {
		e.X = maxX
		e.dir = -1
	}
	// Parede sólida na direção de voo: quica.
	var col int
	if e.dir > 0 {
		col = int(math.Floor((e.X + e.W - 1) / TileSize))
	} else {
		col = int(math.Floor(e.X / TileSize))
	}
	midRow := int(math.Floor((e.Y + e.H/2) / TileSize))
	if l.Solid(col, midRow) {
		e.dir = -e.dir
		e.VX = 0
	}

	// Seno vertical em torno da âncora (padrão determinístico).
	e.Y = e.baseY + math.Sin(2*math.Pi*s.cfg.VoadorFrequency*e.t)*s.cfg.VoadorAmplitude
	if e.Y < 0 {
		e.Y = 0
	}
	if e.Y+e.H > float64(l.Spec.Height*TileSize) {
		e.Y = float64(l.Spec.Height*TileSize) - e.H
	}
}

// stepAtirador: escolhe o alvo por regra determinística (mais próximo;
// empate desfeito pelo ID do jogador) e dispara quando o cooldown zera. O
// disparo é enfileirado e entregue ao hook OnShoot após o lock ser liberado.
func (s *EnemySystem) stepAtirador(e *Enemy, players []Player, dt float64, shots *[]EnemyShot) {
	e.t += dt
	if e.shootIn > 0 {
		e.shootIn--
		return
	}
	target := s.selectTarget(e, players)
	if target == nil {
		return
	}
	e.shootIn = s.cfg.AtiradorCooldownTicks
	tx := float64(target.X) + PlayerWidth/2
	ty := float64(target.Y) + PlayerHeight/2
	*shots = append(*shots, EnemyShot{
		EnemyID:  e.ID,
		X:        e.X + e.W/2,
		Y:        e.Y + e.H/2,
		TargetX:  tx,
		TargetY:  ty,
		Speed:    s.cfg.AtiradorShotSpeed,
		Lifetime: s.cfg.AtiradorShotLifetime,
	})
}

// selectTarget escolhe o jogador-alvo: o vivo mais próximo (distância
// euclidiana entre os centros), com empate desfeito pelo menor ID. A regra é
// total e determinística — todos os jogadores veem o mesmo alvo.
func (s *EnemySystem) selectTarget(e *Enemy, players []Player) *Player {
	var best *Player
	bestD := math.Inf(1)
	cx, cy := e.X+e.W/2, e.Y+e.H/2
	for i := range players {
		p := &players[i]
		if p.HP <= 0 {
			continue
		}
		pcx, pcy := float64(p.X)+PlayerWidth/2, float64(p.Y)+PlayerHeight/2
		dx, dy := pcx-cx, pcy-cy
		d := dx*dx + dy*dy
		if d < bestD || (d == bestD && (best == nil || p.ID < best.ID)) {
			best = p
			bestD = d
		}
	}
	return best
}

// ApplyDamage aplica dano a um inimigo (tiro de jogador). Se o HP zerar, o
// inimigo é destruído: sai do mundo e devolve o evento de drop com as moedas
// sorteadas do RNG da sala (determinístico). PlayerID é creditado com as
// moedas pela camada de simulação.
func (s *EnemySystem) ApplyDamage(id string, dmg int, shooterID string) []EnemyEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.enemies[id]
	if !ok {
		return nil
	}
	e.HP -= dmg
	if e.HP > 0 {
		return nil
	}
	delete(s.enemies, id)
	coins := s.cfg.CoinMin + int(math.Floor(s.rng()*float64(s.cfg.CoinMax-s.cfg.CoinMin+1)))
	return []EnemyEvent{{
		Type: EnemyEventDestroyed, EnemyID: id, PlayerID: shooterID,
		Coins: coins, X: e.X, Y: e.Y,
	}}
}

// Enemies devolve cópias do estado de todos os inimigos vivos (para a colisão
// de projéteis do jogador — ProjectileSystem.Update/StepWorld).
func (s *EnemySystem) Enemies() []Enemy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Enemy, 0, len(s.enemies))
	for _, e := range s.enemies {
		out = append(out, *e)
	}
	return out
}

// Snapshot devolve cópias ordenadas por ID do estado de todos os inimigos
// (para o broadcast). A ordem estável garante consistência entre ticks.
func (s *EnemySystem) Snapshot() []EnemyState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]EnemyState, 0, len(s.enemies))
	for _, e := range s.enemies {
		out = append(out, EnemyState{
			ID: e.ID, Type: e.Type.String(),
			X: int(math.Round(e.X)), Y: int(math.Round(e.Y)),
			HP: e.HP, Phase: e.Phase,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Count devolve o número de inimigos vivos.
func (s *EnemySystem) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.enemies)
}

// Clear remove todos os inimigos (ex.: reinício de fase). O sistema segue
// utilizável (novos spawns geram IDs sequenciais).
func (s *EnemySystem) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enemies = make(map[string]*Enemy)
}

// clampEnemyWorld mantém o inimigo dentro dos limites do mundo (e vira nas
// bordas, para o andador não ficar preso contra o limite).
func (s *EnemySystem) clampEnemyWorld(e *Enemy, l *Level) {
	if e.X < 0 {
		e.X = 0
		e.dir = 1
		return
	}
	maxX := float64(l.Spec.Width*TileSize) - e.W
	if e.X > maxX {
		e.X = maxX
		e.dir = -1
	}
	if e.Y < 0 {
		e.Y = 0
	}
	maxY := float64(l.Spec.Height*TileSize) - e.H
	if e.Y >= maxY {
		e.Y = maxY
		if e.VY > 0 {
			e.VY = 0
		}
		e.grounded = true
	}
}
