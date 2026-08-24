package game

import (
	"errors"
	"testing"
)

func TestNewRoomDefaults(t *testing.T) {
	r := NewRoom("default")
	if r.name != "default" {
		t.Errorf("name = %q, want %q", r.name, "default")
	}
	if r.password != "" {
		t.Errorf("password = %q, want sala pública (vazio)", r.password)
	}
	if r.maxPlayers != MaxPlayersPerRoom {
		t.Errorf("maxPlayers = %d, want %d", r.maxPlayers, MaxPlayersPerRoom)
	}
	if r.Count() != 0 {
		t.Errorf("Count() = %d, want 0", r.Count())
	}
}

func TestNewRoomWithConfig(t *testing.T) {
	tests := []struct {
		name     string
		cfg      RoomConfig
		wantMax  int
		wantPass string
	}{
		{"senha + lotação custom", RoomConfig{Name: "pvt", Password: "segredo", MaxPlayers: 2}, 2, "segredo"},
		{"sem senha", RoomConfig{Name: "pub", MaxPlayers: 8}, 8, ""},
		{"max zero usa padrão", RoomConfig{Name: "padrao"}, MaxPlayersPerRoom, ""},
		{"max negativo usa padrão", RoomConfig{Name: "neg", MaxPlayers: -3}, MaxPlayersPerRoom, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewRoomWithConfig(tt.cfg)
			if r.maxPlayers != tt.wantMax {
				t.Errorf("maxPlayers = %d, want %d", r.maxPlayers, tt.wantMax)
			}
			if r.password != tt.wantPass {
				t.Errorf("password = %q, want %q", r.password, tt.wantPass)
			}
		})
	}
}

func TestRoomJoin(t *testing.T) {
	const (
		roomPass = "segredo"
		spawnX   = 96
		spawnY   = 480
		spawnHP  = 100
	)

	tests := []struct {
		name       string
		roomPass   string
		preFill    int // jogadores já na sala antes do join
		password   string
		wantPlayer bool
		wantErr    error
	}{
		{"sala pública sem senha", "", 0, "", true, nil},
		{"sala pública ignora senha qualquer", "", 0, "qualquer", true, nil},
		{"senha correta", roomPass, 0, roomPass, true, nil},
		{"senha incorreta", roomPass, 0, "errada", false, ErrWrongPassword},
		{"senha omitida em sala privada", roomPass, 0, "", false, ErrWrongPassword},
		{"sala cheia recusa entrada", "", 4, "", false, ErrRoomFull},
		{"sala cheia com senha correta também recusa", roomPass, 4, roomPass, false, ErrRoomFull},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewRoomWithConfig(RoomConfig{Name: "sala", Password: tt.roomPass})
			for i := 0; i < tt.preFill; i++ {
				p, err := r.Join(playerID(i), tt.roomPass)
				if err != nil || p == nil {
					t.Fatalf("prefill %d: Join = (%v, %v), want sucesso", i, p, err)
				}
			}

			p, err := r.Join("jogador-teste", tt.password)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Join() err = %v, want %v", err, tt.wantErr)
			}
			_, ok := r.GetPlayer("jogador-teste")
			if ok != tt.wantPlayer {
				t.Errorf("GetPlayer ok = %v, want %v", ok, tt.wantPlayer)
			}
			if p != nil {
				if p.X != spawnX || p.Y != spawnY || p.HP != spawnHP {
					t.Errorf("spawn = (%d,%d,hp %d), want (%d,%d,%d)", p.X, p.Y, p.HP, spawnX, spawnY, spawnHP)
				}
				if p.ID != "jogador-teste" {
					t.Errorf("ID = %q, want %q", p.ID, "jogador-teste")
				}
			}
		})
	}
}

func TestRoomJoinReconexaoEhIdempotente(t *testing.T) {
	r := NewRoomWithConfig(RoomConfig{Name: "sala", Password: "x"})
	p1, err := r.Join("alice", "x")
	if err != nil {
		t.Fatalf("primeiro Join: %v", err)
	}
	p2, err := r.Join("alice", "x")
	if err != nil {
		t.Fatalf("reconexão Join: %v", err)
	}
	if p1 != p2 {
		t.Error("reconexão retornou jogador diferente")
	}
	if r.Count() != 1 {
		t.Errorf("Count() = %d, want 1 (sem duplicar)", r.Count())
	}
}

func TestRoomFullLiberaVagaAoRemover(t *testing.T) {
	r := NewRoom("sala") // max = MaxPlayersPerRoom = 4
	for i := 0; i < MaxPlayersPerRoom; i++ {
		if _, err := r.Join(playerID(i), ""); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}
	if got := r.Count(); got != MaxPlayersPerRoom {
		t.Fatalf("Count() = %d, want %d", got, MaxPlayersPerRoom)
	}

	if _, err := r.Join("quinto", ""); !errors.Is(err, ErrRoomFull) {
		t.Fatalf("Join em sala cheia = %v, want ErrRoomFull", err)
	}

	r.RemovePlayer(playerID(0)) // jogador desconecta
	if _, ok := r.GetPlayer(playerID(0)); ok {
		t.Error("jogador removido ainda presente")
	}

	p, err := r.Join("quinto", "") // vaga liberada
	if err != nil {
		t.Fatalf("Join após remoção: %v", err)
	}
	if p == nil || p.ID != "quinto" {
		t.Errorf("Join após remoção = %v, want quinto", p)
	}
	if got := r.Count(); got != MaxPlayersPerRoom {
		t.Errorf("Count() = %d, want %d (vaga reocupada)", got, MaxPlayersPerRoom)
	}
}

func TestRoomRemovePlayerAoDesconectar(t *testing.T) {
	r := NewRoom("sala")
	for i := 0; i < 3; i++ {
		if _, err := r.Join(playerID(i), ""); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}

	r.RemovePlayer(playerID(1)) // desconexão
	if _, ok := r.GetPlayer(playerID(1)); ok {
		t.Error("GetPlayer retornou jogador desconectado")
	}
	if got := r.Count(); got != 2 {
		t.Errorf("Count() = %d, want 2", got)
	}
	// remover de novo é no-op (não quebra)
	r.RemovePlayer(playerID(1))
	if got := r.Count(); got != 2 {
		t.Errorf("Count() após remover 2x = %d, want 2", got)
	}
}

func TestRoomSnapshot(t *testing.T) {
	r := NewRoom("sala")
	for i := 0; i < 2; i++ {
		if _, err := r.Join(playerID(i), ""); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}
	got := r.Snapshot()
	if len(got) != 2 {
		t.Fatalf("Snapshot() len = %d, want 2", len(got))
	}
	for _, st := range got {
		if st.HP != 100 {
			t.Errorf("Snapshot HP = %d, want 100", st.HP)
		}
	}
}

func playerID(n int) string {
	return "p" + string(rune('0'+n))
}
