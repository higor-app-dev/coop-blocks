// Package game mantém o estado do mundo multiplayer (salas e jogadores).
package game

import "sync"

// PlayerState é o estado sincronizado de um jogador.
type PlayerState struct {
	X  int `json:"x"`
	Y  int `json:"y"`
	HP int `json:"hp"`
}

// Player representa um jogador conectado a uma sala.
type Player struct {
	ID string
	PlayerState
}

// Room agrega os jogadores de uma partida.
type Room struct {
	mu      sync.RWMutex
	name    string
	players map[string]*Player
}

func NewRoom(name string) *Room {
	return &Room{
		name:    name,
		players: make(map[string]*Player),
	}
}

// AddPlayer cria (ou retorna) um jogador na sala.
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

// Count retorna o número de jogadores na sala.
func (r *Room) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.players)
}
