// Package game — boss (chefe) simulado no servidor (autoritativo e determinístico).
//
// Este arquivo implementa o boss que aparece a cada fase múltipla de 5
// (BossPhaseStep) no MEIO do mapa, com uma máquina de estados de dois
// ataques periódicos:
//
//   - INVESTIDA: o boss acelera em linha reta na horizontal (em direção ao
//     jogador vivo mais próximo, regra determinística) por BossDashTicks,
//     causando dano por contato (BossDashDamage) a cada jogador que tocar a
//     hitbox gigante, respeitando a invulnerabilidade pós-contato por
//     jogador (mesma trilha dos inimigos).
//   - SALTO: o boss pula em arco parabólico (impulso BossJumpSpeedV,
//     gravidade BossGravity) na direção do alvo e, ao aterrissar, aplica
//     dano em área (BossJumpDamage) em todos os jogadores vivos dentro do
//     raio BossAoeRadius do ponto de aterrissagem. Durante o salto não há
//     dano de contato — o jogador pode passar por baixo.
//
// Os ataques são PERIÓDICOS e PREVISÍVEIS: o boss fica BossAttackIntervalTicks
// em idle entre ataques (relógio em ticks do servidor, 20 tps) e a escolha
// investida/salto e a direção usam o MESMO PRNG mulberry32 da fase
// (newMulberry32, level.go) — dois servidores com a mesma seed veem exatamente
// a mesma sequência de estados.
//
// O boss NUNCA é terreno: é uma entidade com hitbox AABB que não colide com o
// grid — o jogador pode passar por cima (salto) ou por baixo (durante o salto
// do boss) e, ao ser derrotado, é removido do mundo na hora. A derrota
// devolve o evento BossEventDefeated com a quantidade de moedas do drop gordo
// (BossCoinDrop) e a posição final — o servidor spawna as moedas coletáveis
// nessa posição (CoinManager.SpawnDrop, mesma trilha dos inimigos) e o
// avanço dos players continua normalmente (o fim de fase depende apenas de
// lvl.Finished, não do boss).
package game

import (
	"fmt"
	"math"
	"sync"
)

// BossPhaseStep: o boss aparece apenas nas fases múltiplas deste valor
// (5, 10, 15, …). Fases fora da régua não têm boss.
const BossPhaseStep = 5

// Dimensões e regras do boss (bloco gigante de 2×2 tiles).
const (
	// BossWidth / BossHeight: hitbox do boss em pixels (client: bloco 96×96).
	BossWidth  = 96.0
	BossHeight = 96.0
	// BossMaxHP: vida máxima padrão (tiro do player = 25 → 16 tiros).
	BossMaxHP = 400
	// BossCoinDrop: moedas do drop gordo ao derrotar o boss (20 moedas
	// coletáveis espalhadas no ponto da derrota — CoinManager.SpawnDrop).
	BossCoinDrop = 20
)

// Regras dos ataques.
const (
	// BossAttackIntervalTicks: ticks em idle entre ataques (90 @ 20 tps =
	// 4,5 s). É o que torna os ataques PERIÓDICOS e previsíveis.
	BossAttackIntervalTicks = 90
	// BossDashTicks: duração da investida em ticks (24 @ 20 tps = 1,2 s).
	BossDashTicks = 24
	// BossDashSpeed: velocidade horizontal da investida em px/s.
	BossDashSpeed = 460.0
	// BossDashDamage: dano de contato da investida.
	BossDashDamage = 20
	// BossJumpSpeedV: impulso vertical inicial do salto em px/s (com a
	// gravidade 980 o boss sobe ~196 px e fica ~1,26 s no ar).
	BossJumpSpeedV = 620.0
	// BossJumpSpeedH: deslocamento horizontal durante o salto em px/s.
	BossJumpSpeedH = 130.0
	// BossJumpDamage: dano em área ao aterrissar.
	BossJumpDamage = 25
	// BossAoeRadius: raio do dano em área em pixels, medido do CENTRO do
	// boss (pés) ao centro do jogador.
	BossAoeRadius = 120.0
	// BossGravity: gravidade do salto (mesma do player/inimigos).
	BossGravity = 980.0
	// BossContactCooldownTicks: invulnerabilidade pós-contato por jogador
	// (30 @ 20 tps = 1,5 s) — evita derreter o HP numa única investida.
	BossContactCooldownTicks = 30
)

// BossStateType identifica o estado atual da máquina de estados do boss.
type BossStateType int

const (
	// BossIdle: parado no ponto de spawn, esperando o próximo ataque.
	BossIdle BossStateType = iota
	// BossInvestida: investida horizontal em linha reta (dano por contato).
	BossInvestida
	// BossSalto: salto em arco — dano em área ao aterrissar.
	BossSalto
)

// String devolve o nome do estado como enviado ao client ("idle"/"investida"/
// "salto" — o client usa esses nomes para animar cada ataque).
func (s BossStateType) String() string {
	switch s {
	case BossInvestida:
		return "investida"
	case BossSalto:
		return "salto"
	}
	return "idle"
}

// Boss é a entidade do boss. Posição (X, Y) é o canto superior esquerdo da
// hitbox em pixels; Y cresce para baixo (mesma convenção do grid de Level).
// VX/VY são velocidades em px/s. HP/MaxHP são a vida atual e o teto. Phase é
// a fase em que o boss foi spawnado (sempre múltipla de BossPhaseStep).
type Boss struct {
	ID     string // "boss" (fixo — só existe um boss por vez)
	X, Y   float64
	W, H   float64
	VX, VY float64
	HP     int
	MaxHP  int
	Phase  int

	// Estado interno da máquina (não serializado).
	state     BossStateType
	t         float64        // relógio local (usado para física de salto)
	attackIn  int            // ticks restantes no idle até o próximo ataque
	dashIn    int            // ticks restantes da investida
	dir       int            // direção horizontal (1 = direita, -1 = esquerda)
	grounded  bool           // boss apoiado no chão
	landed    bool           // salto: true quando aterrissou e aplicou o dano em área
	contactCd map[string]int // invulnerabilidade pós-contato por jogador
}

// BossConfig configura o sistema do boss. Campos <= 0 usam os defaults
// (constantes do pacote).
type BossConfig struct {
	MaxHP                int
	Width                float64
	Height               float64
	DashSpeed            float64
	DashTicks            int
	DashDamage           int
	JumpSpeedV           float64
	JumpSpeedH           float64
	JumpDamage           int
	AoeRadius            float64
	Gravity              float64
	AttackIntervalTicks  int
	ContactCooldownTicks int
	CoinDrop             int
}

func (c BossConfig) withDefaults() BossConfig {
	if c.MaxHP <= 0 {
		c.MaxHP = BossMaxHP
	}
	if c.Width <= 0 {
		c.Width = BossWidth
	}
	if c.Height <= 0 {
		c.Height = BossHeight
	}
	if c.DashSpeed <= 0 {
		c.DashSpeed = BossDashSpeed
	}
	if c.DashTicks <= 0 {
		c.DashTicks = BossDashTicks
	}
	if c.DashDamage <= 0 {
		c.DashDamage = BossDashDamage
	}
	if c.JumpSpeedV <= 0 {
		c.JumpSpeedV = BossJumpSpeedV
	}
	// JumpSpeedH usa < 0 (não <= 0): 0 é um override válido — salto VERTICAL
	// no lugar (útil para testes do dano em área; nunca usado em produção).
	if c.JumpSpeedH < 0 {
		c.JumpSpeedH = BossJumpSpeedH
	}
	if c.JumpDamage <= 0 {
		c.JumpDamage = BossJumpDamage
	}
	if c.AoeRadius <= 0 {
		c.AoeRadius = BossAoeRadius
	}
	if c.Gravity <= 0 {
		c.Gravity = BossGravity
	}
	if c.AttackIntervalTicks <= 0 {
		c.AttackIntervalTicks = BossAttackIntervalTicks
	}
	if c.ContactCooldownTicks <= 0 {
		c.ContactCooldownTicks = BossContactCooldownTicks
	}
	if c.CoinDrop <= 0 {
		c.CoinDrop = BossCoinDrop
	}
	return c
}

// BossEventType identifica um evento emitido pelo sistema do boss.
type BossEventType int

const (
	// BossEventPlayerHit: dano a um jogador — por CONTATO (investida) ou
	// por ÁREA (aterrissagem do salto). PlayerID = vítima; Damage = dano.
	BossEventPlayerHit BossEventType = iota
	// BossEventDefeated: boss derrotado (HP zerou). Coins = moedas do drop
	// gordo; X/Y = posição final do boss para o drop.
	BossEventDefeated
)

// BossEvent é um fato ocorrido na simulação do boss, emitido para o servidor
// aplicar as consequências (dano ao jogador, drop de moedas na derrota).
type BossEvent struct {
	Type     BossEventType
	PlayerID string // vítima (PlayerHit)
	Damage   int    // dano (PlayerHit)
	Coins    int    // moedas do drop (Defeated)
	X, Y     float64
}

// BossState é o estado sincronizado do boss, enviado ao client via broadcast
// (campo "boss" do WorldMsg) para renderização e a barra de HP do HUD.
// X/Y são pixels (top-left da hitbox). State é "idle" | "investida" | "salto".
type BossState struct {
	ID    string `json:"id"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	HP    int    `json:"hp"`
	MaxHP int    `json:"maxHp"`
	State string `json:"state"`
	Phase int    `json:"phase"`
}

// BossSystem gerencia o boss do mundo: spawn por fase (múltipla de 5, no meio
// do mapa), máquina de estados (Step), destruição por tiro (ApplyDamage) e
// snapshot para o broadcast. É thread-safe: os métodos públicos usam
// sync.RWMutex, como os demais sistemas do pacote.
type BossSystem struct {
	mu    sync.RWMutex
	cfg   BossConfig
	rng   func() float64 // mulberry32 semeado pela fase (determinístico)
	phase int
	boss  *Boss
}

// NewBossSystem cria um sistema com a config dada e RNG semeado pela seed da
// sala/fase (mesmo PRNG do levelgen). A mesma seed produz a mesma sequência
// de estados para todos os jogadores da sala.
func NewBossSystem(seed uint32, cfg BossConfig) *BossSystem {
	return &BossSystem{
		cfg:   cfg.withDefaults(),
		rng:   newMulberry32(seed),
		phase: 1,
	}
}

// NewBossSystemDefault cria um sistema com as regras padrão e a seed dada.
func NewBossSystemDefault(seed uint32) *BossSystem {
	return NewBossSystem(seed, BossConfig{})
}

// Phase devolve a fase atual do sistema.
func (s *BossSystem) Phase() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.phase
}

// SetPhase define a fase atual (mínimo 1). Controla se o próximo
// SpawnForLevel cria o boss (fase múltipla de BossPhaseStep).
func (s *BossSystem) SetPhase(p int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p < 1 {
		p = 1
	}
	s.phase = p
}

// Reset limpa o campo para o início de uma nova fase: remove o boss e
// re-semeia o RNG com a seed da nova fase (determinismo por fase). Mantém a
// fase atual (SetPhase controla o spawn do próximo SpawnForLevel).
func (s *BossSystem) Reset(seed uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rng = newMulberry32(seed)
	s.boss = nil
}

// SpawnForLevel cria o boss no MEIO do mapa quando a fase atual é múltipla
// de BossPhaseStep (5, 10, 15, …); fora da régua não faz nada. O boss nasce
// no chão (pés na fileira GroundY), centralizado na coluna do meio do mundo,
// em idle com o relógio de ataque no intervalo cheio. Devolve true quando o
// boss foi criado.
func (s *BossSystem) SpawnForLevel(l *Level) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase < BossPhaseStep || s.phase%BossPhaseStep != 0 {
		return false
	}
	cx := float64(l.Spec.Width*TileSize)/2 - s.cfg.Width/2
	cy := float64(l.GroundY*TileSize) - s.cfg.Height
	s.boss = &Boss{
		ID:        "boss",
		X:         cx,
		Y:         cy,
		W:         s.cfg.Width,
		H:         s.cfg.Height,
		HP:        s.cfg.MaxHP,
		MaxHP:     s.cfg.MaxHP,
		Phase:     s.phase,
		state:     BossIdle,
		dir:       1,
		grounded:  true,
		attackIn:  s.cfg.AttackIntervalTicks,
		contactCd: make(map[string]int),
	}
	return true
}

// Step avança a máquina de estados do boss um tick (FixedDT = 50 ms). Sem
// boss no mundo devolve nil. Devolve os eventos deste tick: dano por contato
// (investida) e dano em área (aterrissagem do salto). O dano é aplicado pela
// camada de HP/simulação (o servidor conecta via BossEventPlayerHit).
func (s *BossSystem) Step(l *Level, players []Player) []BossEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.boss
	if b == nil {
		return nil
	}
	b.t += FixedDT

	// Decai a invulnerabilidade pós-contato de cada jogador.
	for id, cd := range b.contactCd {
		if cd <= 1 {
			delete(b.contactCd, id)
		} else {
			b.contactCd[id] = cd - 1
		}
	}

	switch b.state {
	case BossIdle:
		return s.stepIdleLocked(b, players, l)
	case BossInvestida:
		return s.stepInvestidaLocked(b, players, l)
	default: // BossSalto
		return s.stepSaltoLocked(b, players, l)
	}
}

// stepIdleLocked: parado no chão, conta os ticks até o próximo ataque. Ao
// zerar, escolhe o ataque pelo RNG da fase (investida < 0,5 ≤ salto) e a
// direção pelo jogador vivo mais próximo (regra determinística).
func (s *BossSystem) stepIdleLocked(b *Boss, players []Player, l *Level) []BossEvent {
	b.VX, b.VY = 0, 0
	b.grounded = true
	b.attackIn--
	if b.attackIn > 0 {
		return nil
	}
	target := s.selectTarget(b, players)
	if target != nil {
		// Aponta para o centro do alvo (determinístico como os inimigos).
		if float64(target.X)+PlayerWidth/2 < b.X+b.W/2 {
			b.dir = -1
		} else {
			b.dir = 1
		}
	}
	if s.rng() < 0.5 {
		b.state = BossInvestida
		b.dashIn = s.cfg.DashTicks
		b.VX = float64(b.dir) * s.cfg.DashSpeed
	} else {
		b.state = BossSalto
		b.grounded = false
		b.landed = false
		b.VX = float64(b.dir) * s.cfg.JumpSpeedH
		b.VY = -s.cfg.JumpSpeedV
	}
	return nil
}

// stepInvestidaLocked: movimento rápido em linha reta na horizontal (dano por
// contato). Quica nas bordas do mundo durante a investida (segue em linha
// reta por segmentos) e volta ao idle quando o dashIn zera.
func (s *BossSystem) stepInvestidaLocked(b *Boss, players []Player, l *Level) []BossEvent {
	b.VX = float64(b.dir) * s.cfg.DashSpeed
	b.X += b.VX * FixedDT
	maxX := float64(l.Spec.Width*TileSize) - b.W
	if b.X < 0 {
		b.X = 0
		b.dir = 1
	} else if b.X > maxX {
		b.X = maxX
		b.dir = -1
	}
	b.dashIn--
	if b.dashIn <= 0 {
		b.state = BossIdle
		b.attackIn = s.cfg.AttackIntervalTicks
		return nil
	}

	// Dano por contato (AABB player × boss), respeitando a
	// invulnerabilidade pós-contato por jogador.
	var events []BossEvent
	for i := range players {
		p := &players[i]
		if p.HP <= 0 {
			continue // morto não toma dano de contato
		}
		px, py := float64(p.X), float64(p.Y)
		if b.X < px+PlayerWidth && b.X+b.W > px &&
			b.Y < py+PlayerHeight && b.Y+b.H > py {
			if b.contactCd[p.ID] <= 0 {
				b.contactCd[p.ID] = s.cfg.ContactCooldownTicks
				events = append(events, BossEvent{
					Type: BossEventPlayerHit, PlayerID: p.ID,
					Damage: s.cfg.DashDamage, X: b.X, Y: b.Y,
				})
			}
		}
	}
	return events
}

// stepSaltoLocked: arco parabólico (impulso vertical + gravidade) na direção
// do alvo. Sem dano de contato no ar (dá pra passar por baixo). Ao tocar o
// chão, aplica UMA VEZ o dano em área (BossAoeRadius do centro dos pés) e
// volta ao idle.
func (s *BossSystem) stepSaltoLocked(b *Boss, players []Player, l *Level) []BossEvent {
	b.VY += s.cfg.Gravity * FixedDT
	if b.VY > 900 {
		b.VY = 900 // velocidade terminal (mesma ordem dos inimigos)
	}
	b.X += b.VX * FixedDT
	maxX := float64(l.Spec.Width*TileSize) - b.W
	if b.X < 0 {
		b.X = 0
		b.dir = 1
		b.VX = float64(b.dir) * s.cfg.JumpSpeedH
	} else if b.X > maxX {
		b.X = maxX
		b.dir = -1
		b.VX = float64(b.dir) * s.cfg.JumpSpeedH
	}
	b.Y += b.VY * FixedDT
	if b.Y < 0 {
		b.Y = 0
		b.VY = 0
	}

	groundY := float64(l.GroundY * TileSize)
	if b.Y+b.H >= groundY {
		// Aterrissou: assenta no chão e aplica o dano em área.
		b.Y = groundY - b.H
		b.VY = 0
		b.grounded = true
		b.state = BossIdle
		b.attackIn = s.cfg.AttackIntervalTicks
		if b.landed {
			return nil // AoE já aplicado nesta aterrissagem
		}
		b.landed = true

		var events []BossEvent
		cx, cy := b.X+b.W/2, b.Y+b.H // centro dos pés = ponto de impacto
		for i := range players {
			p := &players[i]
			if p.HP <= 0 {
				continue
			}
			pcx := float64(p.X) + PlayerWidth/2
			pcy := float64(p.Y) + PlayerHeight/2
			dx, dy := pcx-cx, pcy-cy
			if dx*dx+dy*dy <= s.cfg.AoeRadius*s.cfg.AoeRadius {
				events = append(events, BossEvent{
					Type: BossEventPlayerHit, PlayerID: p.ID,
					Damage: s.cfg.JumpDamage, X: b.X, Y: b.Y,
				})
			}
		}
		return events
	}
	return nil
}

// selectTarget escolhe o jogador-alvo: o vivo mais próximo (distância
// euclidiana entre os centros), com empate desfeito pelo menor ID — a mesma
// regra total e determinística dos inimigos (enemies.go).
func (s *BossSystem) selectTarget(b *Boss, players []Player) *Player {
	var best *Player
	bestD := math.Inf(1)
	cx, cy := b.X+b.W/2, b.Y+b.H/2
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

// ApplyDamage aplica dano ao boss (tiro de jogador). Se o HP zerar, o boss é
// derrotado: sai do mundo e devolve o evento do drop gordo (BossCoinDrop
// moedas na posição final). O servidor spawna as moedas coletáveis nessa
// posição e o avanço dos players continua normalmente.
func (s *BossSystem) ApplyDamage(id string, dmg int) []BossEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.boss
	if b == nil || b.ID != id {
		return nil
	}
	b.HP -= dmg
	if b.HP > 0 {
		return nil
	}
	s.boss = nil
	return []BossEvent{{
		Type: BossEventDefeated, Coins: s.cfg.CoinDrop, X: b.X, Y: b.Y,
	}}
}

// Boss devolve uma CÓPIA do boss atual (nil quando não há boss). Usado para
// a colisão de projéteis amigáveis (ProjectileSystem.StepWorldBoss) e pelos
// testes — a leitura é segura fora do lock.
func (s *BossSystem) Boss() *Boss {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.boss == nil {
		return nil
	}
	b := *s.boss
	b.contactCd = nil // estado interno; cópia rasa proposital
	return &b
}

// Active devolve true quando há boss vivo no mundo.
func (s *BossSystem) Active() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.boss != nil
}

// Snapshot devolve o estado serializável do boss para o broadcast (nil quando
// não há boss — o client usa a ausência para esconder a barra de HP).
func (s *BossSystem) Snapshot() *BossState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b := s.boss
	if b == nil {
		return nil
	}
	return &BossState{
		ID:    b.ID,
		X:     int(math.Round(b.X)),
		Y:     int(math.Round(b.Y)),
		HP:    b.HP,
		MaxHP: b.MaxHP,
		State: b.state.String(),
		Phase: b.Phase,
	}
}

// String é usado por fmt em logs de depuração (ID@X,Y estado).
func (b *Boss) String() string {
	return fmt.Sprintf("%s@%.0f,%.0f %s", b.ID, b.X, b.Y, b.state)
}
