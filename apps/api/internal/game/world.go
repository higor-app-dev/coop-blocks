// Package game — núcleo de simulação autoritativa (World).
//
// World agrega as entidades do jogo (players com física, inimigos e moedas)
// e os sistemas que as movem (projéteis), expondo um único método
// Step(inputs, dt) que avança o mundo inteiro de forma determinística:
//
//  1. aplica os inputs dos jogadores (direção, pulo, tiro);
//  2. move os corpos dos players contra o grid da fase (colisão por eixo);
//  3. avança a IA dos inimigos (movimento + contato com jogadores);
//  4. avança os projéteis (colisão com parede/chão/inimigo/jogador);
//  5. coleta moedas por sobreposição (remove + contador do jogador).
//
// Os eventos do tick (tiros, hits de projétil, destruições de inimigos,
// dano por contato, coletas de moeda) são devolvidos para o chamador aplicar
// as consequências — dano no Sim (HP/respawn), drop de moedas na posição da
// destruição, crédito na carteira e broadcasts. O núcleo NÃO aplica dano a
// jogadores nem credita carteira: isso é da camada de HP/economia (Sim),
// mantida fora do World (o HP é lido via hpFrom, injetado na construção).
//
// Determinismo: timestep fixo (FixedDT = 50 ms), iteração em ordem de ID,
// RNG semeado pela fase (mulberry32) — mesmos inputs e mesma seed produzem
// exatamente o mesmo estado. O tiro usa cooldown por TICK (não wall-clock),
// então a cadência também é determinística.
//
// Fora do escopo do núcleo (extensões ligadas na camada do servidor): o boss
// (boss.go) e os power-ups (powerups.go) são avançados pelo loop do servidor
// com os próprios sistemas — o World cobre exatamente as entidades do núcleo
// (players, inimigos, moedas) e o tiro.
package game

import (
	"sort"
	"sync"
)

// WorldDefaultFireCooldownTicks é o cooldown padrão de tiro por jogador:
// 3 ticks @ 20 tps = 150 ms (base do servidor, antes do multiplicador de
// fire_rate da loja — que é aplicado na camada do servidor).
const WorldDefaultFireCooldownTicks = 3

// WorldConfig configura o núcleo de simulação. Campos <= 0 usam os defaults.
type WorldConfig struct {
	// FireCooldownTicks: ticks entre disparos de um mesmo jogador
	// (default WorldDefaultFireCooldownTicks).
	FireCooldownTicks int
}

func (c WorldConfig) withDefaults() WorldConfig {
	if c.FireCooldownTicks <= 0 {
		c.FireCooldownTicks = WorldDefaultFireCooldownTicks
	}
	return c
}

// WorldInputs mapeia o ID do jogador → intenção do tick. Jogador sem entrada
// fica parado (sem input = sem intenção de movimento/tiro).
type WorldInputs map[string]Input

// WorldEventType identifica um evento consolidado do tick do World.
type WorldEventType int

const (
	// WorldEventShot: jogador disparou — um projétil foi criado na frente
	// dele (X/Y = posição do corpo no momento do disparo).
	WorldEventShot WorldEventType = iota
	// WorldEventProjectileHit: projétil colidiu com parede/chão/borda e foi
	// removido (Damage = dano carregado; não aplicado pelo núcleo).
	WorldEventProjectileHit
	// WorldEventEnemyDestroyed: inimigo destruído por tiro — saiu do mundo;
	// Coins = moedas dropadas na posição X/Y (o chamador spawna/dá crédito).
	WorldEventEnemyDestroyed
	// WorldEventPlayerHit: jogador atingido — por contato com inimigo ou por
	// tiro hostil do atirador (Damage = dano; não aplicado pelo núcleo).
	WorldEventPlayerHit
	// WorldEventCoinCollected: moeda coletada — removida do mundo; CoinID
	// identifica a moeda (o chamador credita a carteira e broadcasta).
	WorldEventCoinCollected
)

// WorldEvent é um fato ocorrido na simulação, emitido pelo Step para o
// chamador aplicar as consequências. Campos não usados ficam zero.
type WorldEvent struct {
	Type     WorldEventType
	PlayerID string // atirador (shot/destroyed), vítima (player hit) ou coletor (coin)
	EnemyID  string // inimigo envolvido (destroyed / contato)
	CoinID   string // moeda coletada
	Damage   int    // dano carregado (projectile hit / player hit)
	Coins    int    // moedas do drop (enemy destroyed)
	X, Y     float64
}

// HPProvider resolve o HP atual de um jogador (camada de HP/respawn, ex.:
// Sim.GetPlayer). nil usa "sempre vivo" (DefaultMaxHP) — útil em testes de
// física pura.
type HPProvider func(id string) int

// World é o núcleo de simulação autoritativa: dono dos corpos físicos dos
// jogadores (PlayerBody) e agregador dos sistemas de inimigos, projéteis e
// moedas. Não é uma goroutine: o chamador invoca Step a cada tick (20 tps).
// Thread-safe: Step e as mutações (AddPlayer/RemovePlayer/StartLevel) são
// serializadas pelo lock interno.
type World struct {
	mu  sync.RWMutex
	cfg WorldConfig

	level  *Level
	bodies map[string]*PlayerBody
	fireCd map[string]int // ticks restantes de cooldown de tiro por jogador
	tick   int64

	enemies     *EnemySystem
	projectiles *ProjectileSystem
	coins       *CoinManager

	hpFrom HPProvider
}

// NewWorld cria um núcleo de simulação para a fase dada (l), com os sistemas
// de inimigos/moedas já populados a partir dos spawns do level (determinístico
// pela seed da fase) e o tiro dos atiradores conectado ao sistema de projéteis
// do próprio mundo (mesma fiação do servidor). hpFrom resolve o HP dos
// jogadores durante o Step.
func NewWorld(l *Level, hpFrom HPProvider) *World {
	return NewWorldWithConfig(l, hpFrom, WorldConfig{})
}

// NewWorldWithConfig cria um núcleo com configuração customizada.
func NewWorldWithConfig(l *Level, hpFrom HPProvider, cfg WorldConfig) *World {
	w := &World{
		cfg:         cfg.withDefaults(),
		level:       l,
		bodies:      make(map[string]*PlayerBody),
		fireCd:      make(map[string]int),
		enemies:     NewEnemySystemDefault(l.Spec.Seed),
		projectiles: NewProjectileSystemDefault(),
		coins:       NewCoinManagerDefault(),
		hpFrom:      hpFrom,
	}
	w.enemies.SetPhase(1)
	w.enemies.SpawnForLevel(l)
	w.coins.SpawnForLevel(l)
	// O tiro do atirador cai no sistema de projéteis do próprio mundo.
	w.enemies.OnShoot(func(sh EnemyShot) {
		w.projectiles.FireEnemyShot(sh)
	})
	return w
}

// AddPlayer cria o corpo físico do jogador no spawn da fase. Se o ID já
// existe (reconexão), é no-op idempotente. O HP do jogador vive na camada
// externa (hpFrom) — o núcleo só cuida da física.
func (w *World) AddPlayer(id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.bodies[id]; ok {
		return
	}
	b := NewPlayerBody(0, 0)
	b.SpawnAt(w.level)
	w.bodies[id] = b
}

// RemovePlayer tira o jogador do mundo de uma vez (corpo + cooldown de tiro):
// desconectou, some da simulação e dos próximos snapshots. Idempotente.
func (w *World) RemovePlayer(id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.bodies, id)
	delete(w.fireCd, id)
}

// Respawn reposiciona o corpo de um jogador no spawn da fase (respawn pós
// morte), zerando velocidade e marcando grounded. Devolve false se o jogador
// não existe no mundo.
func (w *World) Respawn(id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	b, ok := w.bodies[id]
	if !ok {
		return false
	}
	b.SpawnAt(w.level)
	return true
}

// StartLevel troca o mundo para uma nova fase: substitui o level, re-semeia
// o sistema de inimigos com a seed da nova fase (SetPhase controla o pool de
// tipos), regenera as moedas, limpa projéteis em voo e reposiciona todos os
// jogadores no spawn do novo mapa. Espelho do avanço de fase do servidor.
func (w *World) StartLevel(l *Level, phase int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if phase < 1 {
		phase = 1
	}
	w.level = l
	w.enemies.Reset(l.Spec.Seed)
	w.enemies.SetPhase(phase)
	w.enemies.SpawnForLevel(l)
	w.coins.Reset()
	w.coins.SpawnForLevel(l)
	w.projectiles.Clear()
	for _, b := range w.bodies {
		b.SpawnAt(l)
	}
}

// Step avança o mundo inteiro em dt segundos (default FixedDT = 50 ms) com os
// inputs do tick: aplica movimento/pulo/tiro nos jogadores, move inimigos,
// projéteis e resolve coletas — tudo em ordem determinística. Devolve os
// eventos do tick; jogadores com HP <= 0 (via hpFrom) não agem nem atiram.
func (w *World) Step(inputs WorldInputs, dt float64) []WorldEvent {
	if dt <= 0 {
		dt = FixedDT
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.tick++

	// Decai o cooldown de tiro de todos os jogadores ANTES de avaliar novos
	// tiros (cadência determinística por tick).
	for id, cd := range w.fireCd {
		if cd <= 1 {
			delete(w.fireCd, id)
		} else {
			w.fireCd[id] = cd - 1
		}
	}

	var events []WorldEvent

	// 1) Inputs dos jogadores (ordem de ID — determinismo dos IDs de projétil
	//    quando vários jogadores disparam no mesmo tick).
	ids := make([]string, 0, len(w.bodies))
	for id := range w.bodies {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		b := w.bodies[id]
		if w.hpFrom != nil && w.hpFrom(id) <= 0 {
			continue // morto não age nem atira
		}
		in := inputs[id]
		b.Update(in, w.level, dt)
		if in.Shoot && w.fireCd[id] <= 0 {
			w.fireCd[id] = w.cfg.FireCooldownTicks
			w.projectiles.Fire(id, b.X, b.Y, b.Facing)
			events = append(events, WorldEvent{Type: WorldEventShot, PlayerID: id, X: b.X, Y: b.Y})
		}
	}

	// Snapshot dos jogadores (posição dos corpos + HP externo) consumido pelos
	// subsistemas neste tick.
	players := w.playersLocked()

	// 2) Inimigos: IA determinística + contato com jogadores (dano reportado,
	//    não aplicado — o chamador decide na camada de HP).
	for _, ev := range w.enemies.Step(w.level, players) {
		if ev.Type == EnemyEventPlayerHit {
			events = append(events, WorldEvent{
				Type: WorldEventPlayerHit, PlayerID: ev.PlayerID, EnemyID: ev.EnemyID,
				Damage: ev.Damage, X: ev.X, Y: ev.Y,
			})
		}
	}

	// 3) Projéteis: colisão com grid/inimigos/jogadores; remoção no fim do
	//    tick. O núcleo aplica o dano ao inimigo (destruído → sai do mundo e
	//    devolve o drop); dano a jogador é reportado para a camada de HP.
	for _, h := range w.projectiles.UpdateWorld(w.level, w.enemies.Enemies(), players, dt) {
		switch h.Kind {
		case HitEnemy:
			for _, ev := range w.enemies.ApplyDamage(h.TargetID, h.Damage, h.OwnerID) {
				if ev.Type == EnemyEventDestroyed {
					events = append(events, WorldEvent{
						Type: WorldEventEnemyDestroyed, PlayerID: h.OwnerID, EnemyID: ev.EnemyID,
						Coins: ev.Coins, X: ev.X, Y: ev.Y,
					})
				}
			}
		case HitPlayer:
			events = append(events, WorldEvent{
				Type: WorldEventPlayerHit, PlayerID: h.TargetID, Damage: h.Damage, X: h.X, Y: h.Y,
			})
		default:
			events = append(events, WorldEvent{
				Type: WorldEventProjectileHit, PlayerID: h.OwnerID, Damage: h.Damage, X: h.X, Y: h.Y,
			})
		}
	}

	// 4) Moedas: coleta por sobreposição (remove + contador do jogador).
	for _, ev := range w.coins.Step(players) {
		if ev.Type == CoinEventCollected {
			events = append(events, WorldEvent{
				Type: WorldEventCoinCollected, PlayerID: ev.PlayerID, CoinID: ev.CoinID, X: ev.X, Y: ev.Y,
			})
		}
	}

	return events
}

// playersLocked monta o slice []Player consumido pelos subsistemas (inimigos,
// projéteis, moedas): posição dos corpos físicos + HP da camada externa,
// ordenado por ID (determinismo). Deve ser chamada com o lock held.
func (w *World) playersLocked() []Player {
	out := make([]Player, 0, len(w.bodies))
	for id, b := range w.bodies {
		hp := DefaultMaxHP
		if w.hpFrom != nil {
			hp = w.hpFrom(id)
		}
		st := b.State(hp)
		st.ID = id
		out = append(out, Player{ID: id, PlayerState: st})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Players devolve o snapshot dos jogadores (posição física + HP externo),
// ordenado por ID — para broadcast e consumo pelos subsistemas.
func (w *World) Players() []Player {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.playersLocked()
}

// PlayerStates devolve o snapshot dos jogadores sem o ID (wire PlayerState).
func (w *World) PlayerStates() []PlayerState {
	w.mu.RLock()
	defer w.mu.RUnlock()
	ps := w.playersLocked()
	out := make([]PlayerState, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.PlayerState)
	}
	return out
}

// TickCount devolve o número de ticks já avançados.
func (w *World) TickCount() int64 {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.tick
}

// Level devolve a fase atual do mundo.
func (w *World) Level() *Level {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.level
}

// Count devolve o número de jogadores no mundo.
func (w *World) Count() int {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return len(w.bodies)
}

// Enemies devolve o sistema de inimigos do mundo (para configurar, inspecionar
// ou aplicar dano externo).
func (w *World) Enemies() *EnemySystem { return w.enemies }

// Projectiles devolve o sistema de projéteis do mundo.
func (w *World) Projectiles() *ProjectileSystem { return w.projectiles }

// Coins devolve o gerenciador de moedas do mundo.
func (w *World) Coins() *CoinManager { return w.coins }
