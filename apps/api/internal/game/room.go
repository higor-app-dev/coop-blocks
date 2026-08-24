// Package game mantém o estado do mundo multiplayer (salas e jogadores).
package game

import (
	"errors"
	"sync"
)

// MaxPlayersPerRoom é a lotação máxima padrão de uma sala.
const MaxPlayersPerRoom = 4

// Erros retornados pelas operações de lobby/salas.
var (
	ErrRoomNotFound      = errors.New("sala não encontrada")
	ErrRoomAlreadyExists = errors.New("sala já existe")
	ErrRoomFull          = errors.New("sala cheia")
	ErrWrongPassword     = errors.New("senha incorreta")
)

// PlayerState é o estado sincronizado de um jogador, enviado ao client via
// broadcast. X/Y são pixels (top-left do hitbox); VX/VY são velocidades em
// px/s; Grounded/Facing vêm da física do servidor (player.go).
type PlayerState struct {
	X        int     `json:"x"`
	Y        int     `json:"y"`
	VX       float64 `json:"vx"`
	VY       float64 `json:"vy"`
	HP       int     `json:"hp"`
	Grounded bool    `json:"grounded"`
	Facing   int     `json:"facing"`
}

// Player representa um jogador conectado a uma sala.
type Player struct {
	ID string
	PlayerState
}

// RoomConfig configura a criação de uma sala.
type RoomConfig struct {
	Name       string
	Password   string // vazio = sala pública (sem senha)
	MaxPlayers int    // 0 = usa MaxPlayersPerRoom
}

// Room agrega os jogadores de uma partida.
type Room struct {
	mu         sync.RWMutex
	name       string
	password   string
	maxPlayers int
	players    map[string]*Player
}

// NewRoom cria uma sala pública com a lotação padrão (MaxPlayersPerRoom).
func NewRoom(name string) *Room {
	return NewRoomWithConfig(RoomConfig{Name: name})
}

// NewRoomWithConfig cria uma sala com senha e/ou lotação customizadas.
// MaxPlayers <= 0 usa o padrão MaxPlayersPerRoom.
func NewRoomWithConfig(cfg RoomConfig) *Room {
	max := cfg.MaxPlayers
	if max <= 0 {
		max = MaxPlayersPerRoom
	}
	return &Room{
		name:       cfg.Name,
		password:   cfg.Password,
		maxPlayers: max,
		players:    make(map[string]*Player),
	}
}

// Join adiciona um jogador à sala validando senha e lotação máxima.
// Se o ID já está na sala (reconexão), retorna o jogador existente sem revalidar.
func (r *Room) Join(id, password string) (*Player, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.players[id]; ok {
		return p, nil
	}
	if r.password != "" && password != r.password {
		return nil, ErrWrongPassword
	}
	if len(r.players) >= r.maxPlayers {
		return nil, ErrRoomFull
	}
	p := &Player{
		ID: id,
		PlayerState: PlayerState{
			X:  96, // spawn inicial (2 tiles * 48)
			Y:  480,
			HP: 100,
		},
	}
	r.players[id] = p
	return p, nil
}

// AddPlayer cria (ou retorna) um jogador na sala sem checagens de senha/lotação.
// Mantido para o servidor atual (sala única pública); salas com regras usam Join.
func (r *Room) AddPlayer(id string) *Player {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.players[id]; ok {
		return p
	}
	p := &Player{
		ID: id,
		PlayerState: PlayerState{
			X:  96, // spawn inicial (2 tiles * 48)
			Y:  480,
			HP: 100,
		},
	}
	r.players[id] = p
	return p
}

// RemovePlayer remove um jogador da sala.
func (r *Room) RemovePlayer(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.players, id)
}

// GetPlayer retorna um jogador da sala.
func (r *Room) GetPlayer(id string) (*Player, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.players[id]
	return p, ok
}

// GetState devolve uma CÓPIA do estado do jogador. É a leitura segura para
// handlers fora do lock (OnShoot etc.): o ponteiro interno nunca escapa, então
// não há corrida com SetState/ResetToSpawn do loop/avanço de fase.
func (r *Room) GetState(id string) (PlayerState, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.players[id]
	if !ok {
		return PlayerState{}, false
	}
	return p.PlayerState, true
}

// SetState atualiza posição/HP/facing de um jogador de forma atômica sob o
// lock da sala — thread-safe contra o loop de simulação e o avanço de fase
// (ResetToSpawn). Facing só é gravado quando != 0 (0 = ausente/legado).
func (r *Room) SetState(id string, st PlayerState) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.players[id]
	if !ok {
		return
	}
	p.X, p.Y, p.HP = st.X, st.Y, st.HP
	if st.Facing != 0 {
		p.Facing = st.Facing
	}
}

// Players devolve cópias do estado de todos os jogadores COM ID (para a IA de
// inimigos: seleção determinística de alvo e dano de contato).
func (r *Room) Players() []Player {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Player, 0, len(r.players))
	for _, p := range r.players {
		out = append(out, *p)
	}
	return out
}

// Snapshot retorna o estado de todos os jogadores (para broadcast).
func (r *Room) Snapshot() []PlayerState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PlayerState, 0, len(r.players))
	for _, p := range r.players {
		out = append(out, p.PlayerState)
	}
	return out
}

// ResetToSpawn reposiciona TODOS os jogadores no spawn do próximo mapa (x, y
// em pixels), zera velocidades e facing, e aplica o HP individual do mapa hps
// (id → HP, ex.: teto com upgrades do Sim — cada jogador revive com o seu).
// Jogador sem entrada no mapa mantém o HP atual. Usado no avanço de fase.
func (r *Room) ResetToSpawn(x, y int, hps map[string]int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, p := range r.players {
		p.X, p.Y = x, y
		p.VX, p.VY = 0, 0
		p.Facing = 1
		if hp, ok := hps[id]; ok {
			p.HP = hp
		}
	}
}

// Count retorna o número de jogadores na sala.
func (r *Room) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.players)
}
