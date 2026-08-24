// Package game — lobby: gerencia as salas do servidor multiplayer.
package game

import "sync"

// Session identifica uma conexão/sessão de jogador no lobby.
// Permite que testes injetem mocks no lugar de conexões reais (websocket).
type Session interface {
	ID() string
}

// Lobby agrega as salas e roteia a entrada/saída de jogadores.
type Lobby struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

// NewLobby cria um lobby vazio.
func NewLobby() *Lobby {
	return &Lobby{rooms: make(map[string]*Room)}
}

// CreateRoom cria uma sala a partir da config.
// Retorna ErrRoomAlreadyExists se já existir sala com o mesmo nome.
func (l *Lobby) CreateRoom(cfg RoomConfig) (*Room, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.rooms[cfg.Name]; ok {
		return nil, ErrRoomAlreadyExists
	}
	r := NewRoomWithConfig(cfg)
	l.rooms[cfg.Name] = r
	return r, nil
}

// GetRoom retorna uma sala pelo nome.
func (l *Lobby) GetRoom(name string) (*Room, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	r, ok := l.rooms[name]
	return r, ok
}

// Rooms lista todas as salas existentes (ordem não garantida).
func (l *Lobby) Rooms() []*Room {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]*Room, 0, len(l.rooms))
	for _, r := range l.rooms {
		out = append(out, r)
	}
	return out
}

// JoinRoom conecta a sessão de um jogador a uma sala pelo nome,
// validando senha e lotação máxima. Retorna ErrRoomNotFound se a sala
// não existir, ErrWrongPassword se a senha estiver incorreta e
// ErrRoomFull se a sala estiver cheia.
func (l *Lobby) JoinRoom(name string, s Session, password string) (*Player, error) {
	l.mu.RLock()
	r, ok := l.rooms[name]
	l.mu.RUnlock()
	if !ok {
		return nil, ErrRoomNotFound
	}
	return r.Join(s.ID(), password)
}

// LeaveRoom remove um jogador da sala ao desconectar (no-op se a sala não existir),
// liberando a vaga para novos jogadores.
func (l *Lobby) LeaveRoom(name, playerID string) {
	l.mu.RLock()
	r, ok := l.rooms[name]
	l.mu.RUnlock()
	if ok {
		r.RemovePlayer(playerID)
	}
}
