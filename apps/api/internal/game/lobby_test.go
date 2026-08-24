package game

import (
	"errors"
	"testing"
)

// fakeSession é um mock de conexão/sessão para os testes do lobby.
type fakeSession struct{ id string }

func (s fakeSession) ID() string { return s.id }

func TestLobbyCreateRoom(t *testing.T) {
	l := NewLobby()

	r, err := l.CreateRoom(RoomConfig{Name: "partida-1", Password: "abc", MaxPlayers: 4})
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if r == nil {
		t.Fatal("CreateRoom retornou sala nil")
	}
	if got, ok := l.GetRoom("partida-1"); !ok || got != r {
		t.Errorf("GetRoom após criar = (%v, %v), want (%v, true)", got, ok, r)
	}

	// nome duplicado
	if _, err := l.CreateRoom(RoomConfig{Name: "partida-1"}); !errors.Is(err, ErrRoomAlreadyExists) {
		t.Errorf("CreateRoom duplicado = %v, want ErrRoomAlreadyExists", err)
	}

	if got := len(l.Rooms()); got != 1 {
		t.Errorf("Rooms() len = %d, want 1", got)
	}
}

func TestLobbyJoinRoom(t *testing.T) {
	const roomPass = "segredo"

	l := NewLobby()
	if _, err := l.CreateRoom(RoomConfig{Name: "pub"}); err != nil {
		t.Fatalf("criar sala pública: %v", err)
	}
	if _, err := l.CreateRoom(RoomConfig{Name: "pvt", Password: roomPass}); err != nil {
		t.Fatalf("criar sala privada: %v", err)
	}

	tests := []struct {
		name       string
		room       string
		session    Session
		password   string
		wantPlayer bool
		wantErr    error
	}{
		{"sala inexistente", "nao-existe", fakeSession{"x"}, "", false, ErrRoomNotFound},
		{"sala pública entra sem senha", "pub", fakeSession{"alice"}, "", true, nil},
		{"sala privada senha correta", "pvt", fakeSession{"bob"}, roomPass, true, nil},
		{"sala privada senha incorreta", "pvt", fakeSession{"mallory"}, "errada", false, ErrWrongPassword},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := l.JoinRoom(tt.room, tt.session, tt.password)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("JoinRoom err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantPlayer {
				if p == nil {
					t.Fatal("JoinRoom retornou player nil")
				}
				if p.ID != tt.session.ID() {
					t.Errorf("player ID = %q, want %q", p.ID, tt.session.ID())
				}
				r, ok := l.GetRoom(tt.room)
				if !ok {
					t.Fatalf("GetRoom(%q) não achou sala", tt.room)
				}
				if _, ok := r.GetPlayer(tt.session.ID()); !ok {
					t.Errorf("jogador %q não está na sala %q", tt.session.ID(), tt.room)
				}
			} else {
				if p != nil {
					t.Errorf("JoinRoom retornou player %v, want nil", p)
				}
			}
		})
	}
}

func TestLobbySalaCheiaRecusaEntrada(t *testing.T) {
	l := NewLobby()
	if _, err := l.CreateRoom(RoomConfig{Name: "lotada"}); err != nil {
		t.Fatalf("criar sala: %v", err)
	}

	// enche até o limite (4)
	for i := 0; i < MaxPlayersPerRoom; i++ {
		if _, err := l.JoinRoom("lotada", fakeSession{playerID(i)}, ""); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}

	// 5º jogador é recusado
	if _, err := l.JoinRoom("lotada", fakeSession{"quinto"}, ""); !errors.Is(err, ErrRoomFull) {
		t.Errorf("JoinRoom cheia = %v, want ErrRoomFull", err)
	}

	// desconexão de um jogador libera a vaga
	l.LeaveRoom("lotada", playerID(0))
	p, err := l.JoinRoom("lotada", fakeSession{"quinto"}, "")
	if err != nil {
		t.Fatalf("JoinRoom após liberar vaga: %v", err)
	}
	if p == nil || p.ID != "quinto" {
		t.Errorf("JoinRoom após liberar vaga = %v, want quinto", p)
	}
}

func TestLobbyLeaveRoomLiberaVaga(t *testing.T) {
	l := NewLobby()
	if _, err := l.CreateRoom(RoomConfig{Name: "sala"}); err != nil {
		t.Fatalf("criar sala: %v", err)
	}
	if _, err := l.JoinRoom("sala", fakeSession{"alice"}, ""); err != nil {
		t.Fatalf("join alice: %v", err)
	}
	if _, err := l.JoinRoom("sala", fakeSession{"bob"}, ""); err != nil {
		t.Fatalf("join bob: %v", err)
	}

	l.LeaveRoom("sala", "alice") // alice desconecta
	r, _ := l.GetRoom("sala")
	if _, ok := r.GetPlayer("alice"); ok {
		t.Error("alice ainda na sala após LeaveRoom")
	}
	if got := r.Count(); got != 1 {
		t.Errorf("Count() = %d, want 1", got)
	}

	// alice pode reconectar (a vaga foi liberada)
	if _, err := l.JoinRoom("sala", fakeSession{"alice"}, ""); err != nil {
		t.Errorf("reconexão de alice: %v", err)
	}

	// sair de sala inexistente é no-op (sem panic)
	l.LeaveRoom("nao-existe", "alice")
}

func TestLobbySalasIndependentes(t *testing.T) {
	l := NewLobby()
	if _, err := l.CreateRoom(RoomConfig{Name: "a", Password: "pa"}); err != nil {
		t.Fatalf("criar sala a: %v", err)
	}
	if _, err := l.CreateRoom(RoomConfig{Name: "b", Password: "pb"}); err != nil {
		t.Fatalf("criar sala b: %v", err)
	}

	// senha da sala a não abre a sala b
	if _, err := l.JoinRoom("b", fakeSession{"x"}, "pa"); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("JoinRoom b com senha de a = %v, want ErrWrongPassword", err)
	}
	if _, err := l.JoinRoom("a", fakeSession{"x"}, "pa"); err != nil {
		t.Errorf("JoinRoom a com senha correta: %v", err)
	}

	ra, _ := l.GetRoom("a")
	rb, _ := l.GetRoom("b")
	if ra.Count() != 1 || rb.Count() != 0 {
		t.Errorf("salas não independentes: a=%d b=%d, want a=1 b=0", ra.Count(), rb.Count())
	}
}
