// Package game — projéteis (tiro) simulados no servidor (autoritativo).
//
// Este arquivo implementa o tiro no servidor: projéteis amigáveis (jogador)
// e hostis (inimigo atirador). Um projétil amigável é criado na frente do
// jogador, avança a cada tick com velocidade constante e some ao colidir com
// parede/chão do grid da fase, ao acertar um inimigo, ao sair dos limites do
// mundo ou ao expirar o tempo de vida. Projéteis hostis (FireEnemyShot,
// Hostile=true) colidem com jogadores (HitPlayer) em vez de inimigos.
//
// O servidor é dono do estado do projétil (posição, velocidade, dono) e o
// expõe via Snapshot (ProjectileState) para o broadcast — o client apenas
// renderiza. O movimento usa o mesmo timestep fixo da física do player
// (FixedDT = 50 ms), então é determinístico.
//
// Dano NÃO é aplicado aqui: o sistema reporta colisões via hook OnHit
// (ProjectileHit) e pelo retorno de Update/Step, e a camada de HP/respawn
// (kanban t_244f297c) conecta o dano real nesse hook. Expiração por lifetime
// NÃO gera hit (some silenciosamente — não é uma colisão).
package game

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// Constantes de regra do projétil (alinhadas ao client apps/web/src/player.ts:
// bullet com vel = facing*560, rect(12, 5), spawn em pos.x + facing*24,
// pos.y - 10, damage 25).
const (
	// ProjectileSpeed é a velocidade horizontal do projétil em px/s.
	ProjectileSpeed = 560.0
	// ProjectileWidth / ProjectileHeight: hitbox do projétil em pixels.
	ProjectileWidth  = 12.0
	ProjectileHeight = 5.0
	// ProjectileSpawnOffsetX: deslocamento horizontal do spawn em relação ao
	// canto superior esquerdo do jogador (client: pos.x + facing*24).
	ProjectileSpawnOffsetX = 24.0
	// ProjectileSpawnOffsetY: deslocamento vertical do spawn (client: pos.y - 10).
	ProjectileSpawnOffsetY = -10.0
	// ProjectileLifetime: tempo de vida padrão em segundos (~10 s). A 560 px/s
	// o alcance (5600 px) cobre a largura da fase (120 tiles = 5760 px), então
	// em jogo normal o projétil some antes por parede/inimigo/borda do mundo —
	// o lifetime é a rede de segurança (ex.: ângulos futuros que estacionem).
	ProjectileLifetime = 10.0
	// ProjectileDamage: dano informativo carregado no hit (client: damage 25).
	// O sistema NÃO aplica o dano — a camada de HP decide.
	ProjectileDamage = 25
)

// ProjectileConfig configura o sistema de projéteis. Campos <= 0 usam os
// defaults (constantes acima).
type ProjectileConfig struct {
	Speed        float64 // velocidade horizontal px/s (default ProjectileSpeed)
	Width        float64 // largura do hitbox px (default ProjectileWidth)
	Height       float64 // altura do hitbox px (default ProjectileHeight)
	Lifetime     float64 // tempo de vida em segundos (default ProjectileLifetime)
	Damage       int     // dano carregado no hit (default ProjectileDamage)
	SpawnOffsetX float64 // deslocamento horizontal do spawn px (default ProjectileSpawnOffsetX)
	SpawnOffsetY float64 // deslocamento vertical do spawn px (default ProjectileSpawnOffsetY)
}

func (c ProjectileConfig) withDefaults() ProjectileConfig {
	if c.Speed <= 0 {
		c.Speed = ProjectileSpeed
	}
	if c.Width <= 0 {
		c.Width = ProjectileWidth
	}
	if c.Height <= 0 {
		c.Height = ProjectileHeight
	}
	if c.Lifetime <= 0 {
		c.Lifetime = ProjectileLifetime
	}
	if c.Damage <= 0 {
		c.Damage = ProjectileDamage
	}
	// offsets usam == 0 (não <= 0) porque o default de Y é negativo.
	if c.SpawnOffsetX == 0 {
		c.SpawnOffsetX = ProjectileSpawnOffsetX
	}
	if c.SpawnOffsetY == 0 {
		c.SpawnOffsetY = ProjectileSpawnOffsetY
	}
	return c
}

// HitKind identifica o que um projétil atingiu.
type HitKind int

const (
	HitWall   HitKind = iota // tile sólido atingido na horizontal (parede)
	HitFloor                 // tile sólido atingido na vertical (chão/teto)
	HitEnemy                 // inimigo (AABB)
	HitBounds                // saiu dos limites do mundo
	HitPlayer                // jogador (AABB) — projétil hostil do atirador
	HitBoss                  // boss (AABB) — projétil amigável no bloco gigante
)

// String devolve o nome legível do tipo de impacto (útil em logs).
func (k HitKind) String() string {
	switch k {
	case HitWall:
		return "wall"
	case HitFloor:
		return "floor"
	case HitEnemy:
		return "enemy"
	case HitBounds:
		return "bounds"
	case HitPlayer:
		return "player"
	case HitBoss:
		return "boss"
	}
	return "unknown"
}

// ProjectileHit descreve uma colisão de projétil. O consumidor (camada de
// HP/respawn, t_244f297c) decide o que fazer — o sistema apenas reporta o
// fato, com o dano informativo do projétil pronto para ser aplicado.
type ProjectileHit struct {
	ProjectileID string
	OwnerID      string
	Kind         HitKind
	X, Y         float64 // posição do projétil no momento do impacto (top-left, px)
	TargetID     string  // id do alvo quando Kind == HitEnemy
	Damage       int     // dano informativo do projétil (não aplicado aqui)
}

// Projectile é o estado simulado de um projétil em voo. Posição (X, Y) é o
// canto superior esquerdo da hitbox em pixels; Y cresce para baixo (mesma
// convenção do grid de Level). VX/VY são velocidades em px/s (VY = 0 no tiro
// padrão; ângulos futuros podem setá-lo).
type Projectile struct {
	ID      string
	OwnerID string
	X, Y    float64
	VX, VY  float64
	Life    float64 // segundos restantes de voo (expira em 0)
	Damage  int
	W, H    float64 // hitbox (cópia da config, usada nas colisões)
	Hostile bool    // projétil do atirador: colide com jogadores, não inimigos

	dead bool // marcado no tick em que colidiu/expirou; removido no fim do Update
}

// ProjectileState é o estado sincronizado de um projétil, enviado ao client
// via broadcast para renderização. X/Y são pixels (top-left do hitbox).
type ProjectileState struct {
	ID      string  `json:"id"`
	OwnerID string  `json:"owner"`
	X       int     `json:"x"`
	Y       int     `json:"y"`
	VX      float64 `json:"vx"`
	VY      float64 `json:"vy"`
	Hostile bool    `json:"hostile"`
}

// ProjectileSystem gerencia todos os projéteis do mundo: cria (Fire), avança
// (Update/Step) e expõe o snapshot (Snapshot). É thread-safe: Fire é chamado
// de goroutines de conexão (WS) e Update do loop do servidor.
type ProjectileSystem struct {
	mu     sync.RWMutex
	cfg    ProjectileConfig
	nextID int
	projs  map[string]*Projectile
	onHit  func(ProjectileHit)
}

// NewProjectileSystem cria um sistema com a config dada (campos <= 0 usam os
// defaults das constantes do pacote).
func NewProjectileSystem(cfg ProjectileConfig) *ProjectileSystem {
	return &ProjectileSystem{
		cfg:   cfg.withDefaults(),
		projs: make(map[string]*Projectile),
	}
}

// NewProjectileSystemDefault cria um sistema com as regras padrão.
func NewProjectileSystemDefault() *ProjectileSystem {
	return NewProjectileSystem(ProjectileConfig{})
}

// OnHit registra o hook de colisão: chamado para cada colisão de projétil
// (parede, chão, inimigo, borda do mundo) — NÃO para expiração de lifetime.
// O dano real é aplicado aqui pela camada de HP/respawn. Pode ser trocado a
// qualquer momento; nil remove o hook.
func (s *ProjectileSystem) OnHit(fn func(ProjectileHit)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onHit = fn
}

// Fire cria um projétil na frente do jogador (x, y = canto superior esquerdo
// do hitbox do jogador), na direção do facing (1 = direita, -1 = esquerda;
// 0 é normalizado para direita). O spawn replica o client:
// (x + facing*SpawnOffsetX, y + SpawnOffsetY) com velocidade horizontal
// facing*Speed. Retorna o projétil criado.
func (s *ProjectileSystem) Fire(ownerID string, x, y float64, facing int) *Projectile {
	if facing == 0 {
		facing = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	p := &Projectile{
		ID:      fmt.Sprintf("p%d", s.nextID),
		OwnerID: ownerID,
		X:       x + float64(facing)*s.cfg.SpawnOffsetX,
		Y:       y + s.cfg.SpawnOffsetY,
		VX:      float64(facing) * s.cfg.Speed,
		VY:      0,
		Life:    s.cfg.Lifetime,
		Damage:  s.cfg.Damage,
		W:       s.cfg.Width,
		H:       s.cfg.Height,
	}
	s.projs[p.ID] = p
	return p
}

// Update avança todos os projéteis amigáveis (sem colisão com jogadores) em
// dt segundos contra o grid da fase (l) e os inimigos dados, removendo os que
// colidem ou expiram. É o mesmo que UpdateWorld com players = nil — mantido
// para compatibilidade com o loop antigo e testes existentes.
func (s *ProjectileSystem) Update(l *Level, enemies []Enemy, dt float64) []ProjectileHit {
	return s.UpdateWorld(l, enemies, nil, dt)
}

// UpdateWorld avança todos os projéteis em dt segundos contra o grid da fase
// (l), os inimigos e os jogadores dados, removendo os que colidem ou expiram.
// Projéteis amigáveis colidem com inimigos; projéteis hostis (do atirador,
// Hostile=true) colidem com jogadores (HitPlayer). Retorna os hits deste tick
// — também entregues ao hook OnHit, quando registrado. O hook é chamado SEM o
// lock held (pode chamar de volta o sistema sem deadlock).
func (s *ProjectileSystem) UpdateWorld(l *Level, enemies []Enemy, players []Player, dt float64) []ProjectileHit {
	if dt <= 0 {
		dt = FixedDT
	}
	s.mu.Lock()
	hits := s.stepLocked(l, enemies, players, nil, dt)
	onHit := s.onHit
	s.mu.Unlock()

	if onHit != nil {
		for _, h := range hits {
			onHit(h)
		}
	}
	return hits
}

// Step avança um tick com o timestep fixo (FixedDT = 50 ms). É o método do
// loop determinístico do servidor (20 tps).
func (s *ProjectileSystem) Step(l *Level, enemies []Enemy) []ProjectileHit {
	return s.Update(l, enemies, FixedDT)
}

// StepWorld avança um tick com o timestep fixo, incluindo colisão com
// jogadores (projéteis hostis). Use no loop do servidor quando houver inimigos
// e jogadores no mundo.
func (s *ProjectileSystem) StepWorld(l *Level, enemies []Enemy, players []Player) []ProjectileHit {
	return s.UpdateWorld(l, enemies, players, FixedDT)
}

// StepWorldBoss avança um tick com o timestep fixo como StepWorld, incluindo
// a colisão de projéteis amigáveis com o boss (HitBoss — o bloco gigante é
// verificado ANTES dos inimigos: tiros no boss acertam o boss, mesmo com um
// inimigo na frente). boss = nil desliga a colisão (fases sem boss).
func (s *ProjectileSystem) StepWorldBoss(l *Level, enemies []Enemy, players []Player, boss *Boss) []ProjectileHit {
	if dt := FixedDT; dt > 0 {
		s.mu.Lock()
		hits := s.stepLocked(l, enemies, players, boss, dt)
		onHit := s.onHit
		s.mu.Unlock()

		if onHit != nil {
			for _, h := range hits {
				onHit(h)
			}
		}
		return hits
	}
	return nil
}

// stepLocked avança um tick e devolve os hits. Deve ser chamada com o lock
// held. Um projétil reporta no máximo 1 hit por tick (a primeira colisão na
// ordem: parede → chão → borda → boss/inimigo → jogador) e é removido ao fim.
func (s *ProjectileSystem) stepLocked(l *Level, enemies []Enemy, players []Player, boss *Boss, dt float64) []ProjectileHit {
	var hits []ProjectileHit
	for _, p := range s.projs {
		if p.dead {
			continue
		}
		if h := s.stepProjectileLocked(p, l, enemies, players, boss, dt); h != nil {
			hits = append(hits, *h)
			p.dead = true
		}
	}
	// Remoção incondicional: projéteis mortos por colisão (hit) ou por
	// expiração de lifetime (sem hit) saem do mundo no fim do tick.
	for id, p := range s.projs {
		if p.dead {
			delete(s.projs, id)
		}
	}
	return hits
}

// stepProjectileLocked avança um projétil um tick. Devolve o hit se ele
// colidiu (parede/chão/borda/boss/inimigo/jogador) ou nil se seguiu em voo
// ou expirou.
func (s *ProjectileSystem) stepProjectileLocked(p *Projectile, l *Level, enemies []Enemy, players []Player, boss *Boss, dt float64) *ProjectileHit {
	// 1) Lifetime: expira sem colisão (some silenciosamente).
	p.Life -= dt
	if p.Life <= 0 {
		p.dead = true
		return nil
	}

	// 2) Eixo X: move e resolve colisão com paredes.
	p.X += p.VX * dt
	if p.collideGridX(l) {
		return &ProjectileHit{ProjectileID: p.ID, OwnerID: p.OwnerID, Kind: HitWall, X: p.X, Y: p.Y, Damage: p.Damage}
	}

	// 3) Eixo Y: move e resolve colisão com chão/teto.
	p.Y += p.VY * dt
	if p.collideGridY(l) {
		return &ProjectileHit{ProjectileID: p.ID, OwnerID: p.OwnerID, Kind: HitFloor, X: p.X, Y: p.Y, Damage: p.Damage}
	}

	// 4) Limites do mundo: nunca voa para fora do grid.
	if p.outOfBounds(l) {
		return &ProjectileHit{ProjectileID: p.ID, OwnerID: p.OwnerID, Kind: HitBounds, X: p.X, Y: p.Y, Damage: p.Damage}
	}

	// 5) Alvo por facção: amigável acerta boss (verificado PRIMEIRO — o
	//    bloco gigante está na frente) e depois inimigo; hostil (atirador)
	//    acerta jogador. AABB overlap com a hitbox do projétil.
	if !p.Hostile {
		if boss != nil && p.hitBoss(boss) {
			return &ProjectileHit{ProjectileID: p.ID, OwnerID: p.OwnerID, Kind: HitBoss, X: p.X, Y: p.Y, TargetID: boss.ID, Damage: p.Damage}
		}
		if id, ok := p.hitEnemy(enemies); ok {
			return &ProjectileHit{ProjectileID: p.ID, OwnerID: p.OwnerID, Kind: HitEnemy, X: p.X, Y: p.Y, TargetID: id, Damage: p.Damage}
		}
	} else if id, ok := p.hitPlayer(players); ok {
		return &ProjectileHit{ProjectileID: p.ID, OwnerID: p.OwnerID, Kind: HitPlayer, X: p.X, Y: p.Y, TargetID: id, Damage: p.Damage}
	}

	return nil
}

// collideGridX encosta o projétil na face da parede quando o movimento
// horizontal o empurra para dentro de um tile sólido (mesma técnica per-axis
// do PlayerBody). Devolve true se colidiu (e zerou VX). O passo por tick
// (speed*dt = 28 px) é menor que TileSize (48 px), então não há tunnelling.
func (p *Projectile) collideGridX(l *Level) bool {
	if p.VX == 0 {
		return false
	}
	var col int
	if p.VX > 0 {
		col = int(math.Floor((p.X + p.W - 1) / TileSize)) // borda direita
	} else {
		col = int(math.Floor(p.X / TileSize)) // borda esquerda
	}
	y0 := int(math.Floor(p.Y / TileSize))
	y1 := int(math.Floor((p.Y + p.H - 1) / TileSize))
	for ty := y0; ty <= y1; ty++ {
		if l.Solid(col, ty) {
			if p.VX > 0 {
				p.X = float64(col*TileSize) - p.W
			} else {
				p.X = float64((col + 1) * TileSize)
			}
			p.VX = 0
			return true
		}
	}
	return false
}

// collideGridY encosta o projétil no chão (descendo) ou teto (subindo) quando
// o movimento vertical o empurra para dentro de um tile sólido. Devolve true
// se colidiu (e zerou VY).
func (p *Projectile) collideGridY(l *Level) bool {
	if p.VY == 0 {
		return false
	}
	x0 := int(math.Floor(p.X / TileSize))
	x1 := int(math.Floor((p.X + p.W - 1) / TileSize))
	var row int
	if p.VY > 0 {
		row = int(math.Floor((p.Y + p.H - 1) / TileSize)) // borda inferior (pés)
	} else {
		row = int(math.Floor(p.Y / TileSize)) // borda superior (cabeça)
	}
	for tx := x0; tx <= x1; tx++ {
		if l.Solid(tx, row) {
			if p.VY > 0 {
				p.Y = float64(row*TileSize) - p.H
			} else {
				p.Y = float64((row + 1) * TileSize)
			}
			p.VY = 0
			return true
		}
	}
	return false
}

// outOfBounds devolve true quando o projétil saiu do retângulo do mundo.
func (p *Projectile) outOfBounds(l *Level) bool {
	w := float64(l.Spec.Width * TileSize)
	h := float64(l.Spec.Height * TileSize)
	return p.X < 0 || p.Y < 0 || p.X+p.W > w || p.Y+p.H > h
}

// hitEnemy devolve (id, true) quando a hitbox do projétil sobrepõe a AABB de
// algum inimigo.
func (p *Projectile) hitEnemy(enemies []Enemy) (string, bool) {
	for i := range enemies {
		e := &enemies[i]
		if p.X < e.X+e.W && p.X+p.W > e.X && p.Y < e.Y+e.H && p.Y+p.H > e.Y {
			return e.ID, true
		}
	}
	return "", false
}

// hitBoss devolve true quando a hitbox do projétil sobrepõe a AABB do boss
// (bloco gigante — o alvo mais fácil do jogo).
func (p *Projectile) hitBoss(b *Boss) bool {
	return p.X < b.X+b.W && p.X+p.W > b.X && p.Y < b.Y+b.H && p.Y+p.H > b.Y
}

// hitPlayer devolve (id, true) quando a hitbox do projétil sobrepõe a AABB de
// algum jogador (PlayerWidth x PlayerHeight, top-left em PlayerState).
func (p *Projectile) hitPlayer(players []Player) (string, bool) {
	for i := range players {
		pl := &players[i]
		px, py := float64(pl.X), float64(pl.Y)
		if p.X < px+PlayerWidth && p.X+p.W > px && p.Y < py+PlayerHeight && p.Y+p.H > py {
			return pl.ID, true
		}
	}
	return "", false
}

// FireEnemyShot cria um projétil hostil (do atirador) em direção ao alvo. A
// origem (X, Y) é o centro do atirador; a direção aponta para o centro do alvo
// (TargetX, TargetY) com velocidade Speed. A hitbox do projétil é centralizada
// na origem. Projéteis hostis colidem com jogadores (HitPlayer) em vez de
// inimigos.
func (s *ProjectileSystem) FireEnemyShot(sh EnemyShot) *Projectile {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	dx := sh.TargetX - sh.X
	dy := sh.TargetY - sh.Y
	speed := sh.Speed
	if speed <= 0 {
		speed = s.cfg.Speed
	}
	vx, vy := speed, 0.0
	if length := math.Hypot(dx, dy); length > 0 {
		vx = dx / length * speed
		vy = dy / length * speed
	}
	life := sh.Lifetime
	if life <= 0 {
		life = s.cfg.Lifetime
	}
	p := &Projectile{
		ID:      fmt.Sprintf("p%d", s.nextID),
		OwnerID: "enemy:" + sh.EnemyID,
		X:       sh.X - s.cfg.Width/2,
		Y:       sh.Y - s.cfg.Height/2,
		VX:      vx,
		VY:      vy,
		Life:    life,
		Damage:  s.cfg.Damage,
		W:       s.cfg.Width,
		H:       s.cfg.Height,
		Hostile: true,
	}
	s.projs[p.ID] = p
	return p
}

// Snapshot devolve cópias ordenadas por ID do estado de todos os projéteis em
// voo (para o broadcast). A ordem estável garante consistência entre ticks.
func (s *ProjectileSystem) Snapshot() []ProjectileState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ProjectileState, 0, len(s.projs))
	for _, p := range s.projs {
		if p.dead {
			continue
		}
		out = append(out, ProjectileState{
			ID:      p.ID,
			OwnerID: p.OwnerID,
			X:       int(math.Round(p.X)),
			Y:       int(math.Round(p.Y)),
			VX:      p.VX,
			VY:      p.VY,
			Hostile: p.Hostile,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Count devolve o número de projéteis em voo.
func (s *ProjectileSystem) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.projs)
}

// Clear remove todos os projéteis em voo (ex.: reinício de fase no squad
// wipe). O sistema segue utilizável (novos Fire geram IDs sequenciais).
func (s *ProjectileSystem) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.projs = make(map[string]*Projectile)
}
