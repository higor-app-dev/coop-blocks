package game

import (
	"errors"
	"testing"
)

// scriptedRNG devolve valores fixos de Intn em sequência (com wrap),
// permitindo asserções exatas sobre mecânicas que usam aleatoriedade.
type scriptedRNG struct {
	values []int
	i      int
}

func (r *scriptedRNG) Intn(n int) int {
	v := r.values[r.i%len(r.values)]
	r.i++
	if n <= 0 {
		return 0
	}
	return v % n
}

func newScriptedRNG(values ...int) *scriptedRNG {
	return &scriptedRNG{values: values}
}

func simID(s *Sim, id string) *SimPlayer {
	p, ok := s.GetPlayer(id)
	if !ok {
		panic("jogador não existe: " + id)
	}
	return p
}

func TestSimDefaults(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	if s.cfg.MaxHP != DefaultMaxHP {
		t.Errorf("MaxHP = %d, want %d", s.cfg.MaxHP, DefaultMaxHP)
	}
	if s.cfg.ContactDamage != DefaultContactDamage {
		t.Errorf("ContactDamage = %d, want %d", s.cfg.ContactDamage, DefaultContactDamage)
	}
	if s.cfg.RespawnTicks != DefaultRespawnTicks {
		t.Errorf("RespawnTicks = %d, want %d", s.cfg.RespawnTicks, DefaultRespawnTicks)
	}
	if s.cfg.MinCoinDrop != DefaultMinCoinDrop || s.cfg.MaxCoinDrop != DefaultMaxCoinDrop {
		t.Errorf("coin drop = [%d,%d], want [%d,%d]", s.cfg.MinCoinDrop, s.cfg.MaxCoinDrop, DefaultMinCoinDrop, DefaultMaxCoinDrop)
	}
	if s.TickCount() != 0 {
		t.Errorf("TickCount = %d, want 0", s.TickCount())
	}
	if s.IsWiped() {
		t.Error("sim vazio não deve estar em wipe")
	}
	if s.WipeCount() != 0 {
		t.Errorf("WipeCount = %d, want 0", s.WipeCount())
	}
	if got := s.Snapshot(); len(got) != 0 {
		t.Errorf("Snapshot len = %d, want 0", len(got))
	}
}

func TestSimAddPlayer(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	p := s.AddPlayer("alice")
	if !p.Alive {
		t.Error("jogador novo deve nascer vivo")
	}
	if p.HP != DefaultMaxHP || p.MaxHP != DefaultMaxHP {
		t.Errorf("HP = %d/%d, want %d/%d", p.HP, p.MaxHP, DefaultMaxHP, DefaultMaxHP)
	}
	if p.Coins != 0 || p.RespawnIn != 0 || p.Deaths != 0 {
		t.Errorf("estado inicial = coins %d, respawn %d, deaths %d; want 0/0/0", p.Coins, p.RespawnIn, p.Deaths)
	}

	// reconexão é idempotente: mesmo ponteiro, sem duplicar
	p2 := s.AddPlayer("alice")
	if p2 != p {
		t.Error("AddPlayer de ID existente retornou jogador diferente")
	}
	if got := len(s.Snapshot()); got != 1 {
		t.Errorf("Snapshot len = %d, want 1 (sem duplicar)", got)
	}

	// custom MaxHP via config
	s2 := NewSim(newScriptedRNG(), SimConfig{MaxHP: 50})
	if got := s2.AddPlayer("bob").HP; got != 50 {
		t.Errorf("HP custom = %d, want 50", got)
	}
}

func TestSimTickAvancoDeTickComEstadoConsistente(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	for _, id := range []string{"bob", "alice", "carol"} {
		s.AddPlayer(id)
	}

	for i := 1; i <= 10; i++ {
		events := s.Tick()
		if len(events) != 0 {
			t.Fatalf("tick %d: eventos inesperados %+v", i, events)
		}
		if got := s.TickCount(); got != int64(i) {
			t.Fatalf("tick %d: TickCount = %d", i, got)
		}

		// estado consistente: ordem estável (ID), todos vivos, HP cheio,
		// sem respawn pendente, sem moedas
		snap := s.Snapshot()
		if len(snap) != 3 {
			t.Fatalf("tick %d: Snapshot len = %d, want 3", i, len(snap))
		}
		wantOrder := []string{"alice", "bob", "carol"}
		for j, st := range snap {
			if st.ID != wantOrder[j] {
				t.Errorf("tick %d: snapshot[%d].ID = %q, want %q (ordem estável)", i, j, st.ID, wantOrder[j])
			}
			if !st.Alive || st.HP != DefaultMaxHP || st.RespawnIn != 0 || st.Coins != 0 || st.Deaths != 0 {
				t.Errorf("tick %d: %s estado inconsistente = %+v", i, st.ID, st)
			}
		}
		if s.IsWiped() {
			t.Fatalf("tick %d: squad viva não deve estar em wipe", i)
		}
	}
}

func TestSimApplyDamage(t *testing.T) {
	tests := []struct {
		name         string
		amount       int
		wantHP       int
		wantAlive    bool
		wantDeathEvt bool
	}{
		{"dano parcial mantém vivo", 10, 90, true, false},
		{"dano exato mata", 100, 0, false, true},
		{"dano excedente limita HP a 0", 150, 0, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewSimDefault(newScriptedRNG())
			s.AddPlayer("alice")
			events, err := s.ApplyDamage("alice", tt.amount)
			if err != nil {
				t.Fatalf("ApplyDamage: %v", err)
			}
			p := simID(s, "alice")
			if p.HP != tt.wantHP {
				t.Errorf("HP = %d, want %d", p.HP, tt.wantHP)
			}
			if p.Alive != tt.wantAlive {
				t.Errorf("Alive = %v, want %v", p.Alive, tt.wantAlive)
			}
			gotDeath := false
			for _, e := range events {
				if e.Type == EventDeath {
					gotDeath = true
					if e.PlayerID != "alice" {
						t.Errorf("evento de morte PlayerID = %q, want alice", e.PlayerID)
					}
				}
			}
			if gotDeath != tt.wantDeathEvt {
				t.Errorf("evento de morte presente = %v, want %v (events=%+v)", gotDeath, tt.wantDeathEvt, events)
			}
			if !tt.wantAlive {
				if p.Deaths != 1 || p.RespawnIn != DefaultRespawnTicks {
					t.Errorf("morto: deaths = %d, respawnIn = %d; want 1/%d", p.Deaths, p.RespawnIn, DefaultRespawnTicks)
				}
			}
		})
	}
}

func TestSimApplyDamageErros(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	s.AddPlayer("alice")

	if _, err := s.ApplyDamage("alice", 0); !errors.Is(err, ErrNegativeAmount) {
		t.Errorf("dano 0 = %v, want ErrNegativeAmount", err)
	}
	if _, err := s.ApplyDamage("alice", -5); !errors.Is(err, ErrNegativeAmount) {
		t.Errorf("dano negativo = %v, want ErrNegativeAmount", err)
	}
	if _, err := s.ApplyDamage("ghost", 10); !errors.Is(err, ErrPlayerNotFound) {
		t.Errorf("jogador inexistente = %v, want ErrPlayerNotFound", err)
	}

	// mata e depois tenta dano em morto
	if _, err := s.ApplyDamage("alice", 100); err != nil {
		t.Fatalf("dano fatal: %v", err)
	}
	if _, err := s.ApplyDamage("alice", 10); !errors.Is(err, ErrPlayerDead) {
		t.Errorf("dano em morto = %v, want ErrPlayerDead", err)
	}
}

func TestSimApplyContactDamage(t *testing.T) {
	s := NewSim(newScriptedRNG(), SimConfig{ContactDamage: 25})
	s.AddPlayer("alice")

	// 1 contato: 100 - 25 = 75, sem evento
	events, err := s.ApplyContactDamage("alice")
	if err != nil {
		t.Fatalf("ApplyContactDamage: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("events = %+v, want vazio após dano não-fatal", events)
	}
	if got := simID(s, "alice").HP; got != 75 {
		t.Errorf("HP após 1 contato = %d, want 75", got)
	}

	// 3 contatos a mais matam (4 × 25 = 100)
	for i := 0; i < 3; i++ {
		if _, err := s.ApplyContactDamage("alice"); err != nil {
			t.Fatalf("contato %d: %v", i+2, err)
		}
	}
	p := simID(s, "alice")
	if p.Alive || p.HP != 0 {
		t.Errorf("após 4 contatos: alive = %v, hp = %d; want morto com 0", p.Alive, p.HP)
	}
}

func TestSimMorteERespawn(t *testing.T) {
	const respawnTicks = 5
	s := NewSim(newScriptedRNG(), SimConfig{RespawnTicks: respawnTicks})
	s.AddPlayer("alice")

	events, err := s.ApplyDamage("alice", 100)
	if err != nil {
		t.Fatalf("ApplyDamage: %v", err)
	}
	// morte em squad de 1 = wipe também
	if len(events) != 2 || events[0].Type != EventDeath || events[1].Type != EventWipe {
		t.Fatalf("events = %+v, want [death, wipe]", events)
	}
	p := simID(s, "alice")
	if p.Alive || p.HP != 0 || p.Deaths != 1 || p.RespawnIn != respawnTicks {
		t.Fatalf("pós-morte = %+v", p)
	}
	if !s.IsWiped() || s.WipeCount() != 1 {
		t.Errorf("squad de 1 morto: IsWiped = %v, WipeCount = %d; want true/1", s.IsWiped(), s.WipeCount())
	}

	// morto não recebe dano nem coleta
	if _, err := s.ApplyDamage("alice", 10); !errors.Is(err, ErrPlayerDead) {
		t.Errorf("dano em morto = %v, want ErrPlayerDead", err)
	}
	if _, _, err := s.CollectCoin("alice"); !errors.Is(err, ErrPlayerDead) {
		t.Errorf("coleta de morto = %v, want ErrPlayerDead", err)
	}

	// contagem regressiva: um tick por vez
	for i := 1; i <= respawnTicks-1; i++ {
		if ev := s.Tick(); len(ev) != 0 {
			t.Fatalf("tick %d: eventos %+v, want nenhum antes do respawn", i, ev)
		}
		p = simID(s, "alice")
		if p.Alive {
			t.Fatalf("tick %d: respawn antecipado", i)
		}
		if p.RespawnIn != respawnTicks-i {
			t.Errorf("tick %d: RespawnIn = %d, want %d", i, p.RespawnIn, respawnTicks-i)
		}
	}

	// último tick: respawn com HP cheio
	ev := s.Tick()
	if len(ev) != 1 || ev[0].Type != EventRespawn || ev[0].PlayerID != "alice" {
		t.Fatalf("events = %+v, want [respawn alice]", ev)
	}
	p = simID(s, "alice")
	if !p.Alive || p.HP != DefaultMaxHP || p.RespawnIn != 0 {
		t.Errorf("pós-respawn = %+v, want vivo com HP %d e sem contagem", p, DefaultMaxHP)
	}
	if p.Deaths != 1 {
		t.Errorf("Deaths = %d, want 1 (mortes acumulam)", p.Deaths)
	}
	if s.IsWiped() {
		t.Error("após respawn a squad não está mais em wipe")
	}
}

func TestSimSquadWipe(t *testing.T) {
	const respawnTicks = 3
	s := NewSim(newScriptedRNG(), SimConfig{RespawnTicks: respawnTicks})
	for _, id := range []string{"alice", "bob", "carol"} {
		s.AddPlayer(id)
	}

	// matar 2 dos 3: ainda não é wipe
	for _, id := range []string{"alice", "bob"} {
		events, err := s.ApplyDamage(id, 100)
		if err != nil {
			t.Fatalf("matar %s: %v", id, err)
		}
		if len(events) != 1 || events[0].Type != EventDeath {
			t.Fatalf("matar %s: events = %+v, want [death]", id, events)
		}
		if s.IsWiped() || s.WipeCount() != 0 {
			t.Fatalf("após matar %s: IsWiped = %v, WipeCount = %d; want false/0", id, s.IsWiped(), s.WipeCount())
		}
	}

	// matar a última: wipe na mesma chamada
	events, err := s.ApplyDamage("carol", 100)
	if err != nil {
		t.Fatalf("matar carol: %v", err)
	}
	var sawDeath, sawWipe bool
	for _, e := range events {
		switch e.Type {
		case EventDeath:
			sawDeath = true
		case EventWipe:
			sawWipe = true
		}
	}
	if !sawDeath || !sawWipe {
		t.Errorf("events = %+v, want death + wipe", events)
	}
	if !s.IsWiped() || s.WipeCount() != 1 {
		t.Errorf("squad morta: IsWiped = %v, WipeCount = %d; want true/1", s.IsWiped(), s.WipeCount())
	}

	// ticks seguintes não re-emitem wipe (latched até respawn)
	for i := 0; i < respawnTicks; i++ {
		for _, e := range s.Tick() {
			if e.Type == EventWipe {
				t.Fatalf("tick %d: wipe re-emitido sem transição", i+1)
			}
		}
	}
	// todos respawnaram no último tick → wipe liberado
	if s.IsWiped() {
		t.Error("IsWiped = true após todos respawnarem")
	}

	// segunda eliminação conta novo wipe
	for _, id := range []string{"alice", "bob", "carol"} {
		if _, err := s.ApplyDamage(id, 100); err != nil {
			t.Fatalf("matar %s (2ª vez): %v", id, err)
		}
	}
	if s.WipeCount() != 2 {
		t.Errorf("WipeCount = %d, want 2", s.WipeCount())
	}
}

func TestSimSquadWipeSemJogadores(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	// squad vazia nunca conta como wipe (checkWipeLocked exige len > 0)
	if ev := s.Tick(); len(ev) != 0 {
		t.Errorf("tick em sim vazio emitiu eventos %+v", ev)
	}
	if s.IsWiped() || s.WipeCount() != 0 {
		t.Errorf("sim vazio: IsWiped = %v, WipeCount = %d; want false/0", s.IsWiped(), s.WipeCount())
	}
}

func TestSimCoinsColetaComRNG(t *testing.T) {
	// faixa [1,3]: Intn(3) devolve 2, 0, 1 → coletas 3, 1, 2
	rng := newScriptedRNG(2, 0, 1)
	s := NewSim(rng, SimConfig{MinCoinDrop: 1, MaxCoinDrop: 3})
	s.AddPlayer("alice")

	for i, want := range []int{3, 1, 2} {
		amount, events, err := s.CollectCoin("alice")
		if err != nil {
			t.Fatalf("coleta %d: %v", i, err)
		}
		if amount != want {
			t.Errorf("coleta %d: amount = %d, want %d", i, amount, want)
		}
		if len(events) != 1 || events[0].Type != EventCoinGain || events[0].Amount != want || events[0].PlayerID != "alice" {
			t.Errorf("coleta %d: events = %+v, want [coin_gain %d alice]", i, events, want)
		}
	}
	if got := simID(s, "alice").Coins; got != 6 {
		t.Errorf("saldo = %d, want 6", got)
	}
}

func TestSimCoinsDeterministicos(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	s.AddPlayer("alice")

	// AddCoins não depende do rng
	events, err := s.AddCoins("alice", 10)
	if err != nil {
		t.Fatalf("AddCoins: %v", err)
	}
	if len(events) != 1 || events[0].Type != EventCoinGain || events[0].Amount != 10 {
		t.Fatalf("AddCoins events = %+v", events)
	}
	if got := simID(s, "alice").Coins; got != 10 {
		t.Fatalf("saldo após AddCoins = %d, want 10", got)
	}

	// SpendCoins ok
	events, err = s.SpendCoins("alice", 4)
	if err != nil {
		t.Fatalf("SpendCoins: %v", err)
	}
	if len(events) != 1 || events[0].Type != EventCoinSpend || events[0].Amount != 4 {
		t.Fatalf("SpendCoins events = %+v", events)
	}
	if got := simID(s, "alice").Coins; got != 6 {
		t.Fatalf("saldo após gasto = %d, want 6", got)
	}

	// gastar mais que o saldo: erro e saldo intacto
	if _, err := s.SpendCoins("alice", 7); !errors.Is(err, ErrInsufficientCoins) {
		t.Errorf("gasto excessivo = %v, want ErrInsufficientCoins", err)
	}
	if got := simID(s, "alice").Coins; got != 6 {
		t.Errorf("saldo após gasto recusado = %d, want 6 (inalterado)", got)
	}

	// quantidades inválidas
	if _, err := s.AddCoins("alice", 0); !errors.Is(err, ErrNegativeAmount) {
		t.Errorf("AddCoins(0) = %v, want ErrNegativeAmount", err)
	}
	if _, err := s.SpendCoins("alice", -1); !errors.Is(err, ErrNegativeAmount) {
		t.Errorf("SpendCoins(-1) = %v, want ErrNegativeAmount", err)
	}

	// jogador inexistente
	if _, err := s.AddCoins("ghost", 1); !errors.Is(err, ErrPlayerNotFound) {
		t.Errorf("AddCoins ghost = %v, want ErrPlayerNotFound", err)
	}
	if _, err := s.SpendCoins("ghost", 1); !errors.Is(err, ErrPlayerNotFound) {
		t.Errorf("SpendCoins ghost = %v, want ErrPlayerNotFound", err)
	}
	if _, _, err := s.CollectCoin("ghost"); !errors.Is(err, ErrPlayerNotFound) {
		t.Errorf("CollectCoin ghost = %v, want ErrPlayerNotFound", err)
	}
}

func TestSimCoinsPersistemAposMorteERespawn(t *testing.T) {
	s := NewSim(newScriptedRNG(), SimConfig{RespawnTicks: 2})
	s.AddPlayer("alice")
	if _, err := s.AddCoins("alice", 5); err != nil {
		t.Fatalf("AddCoins: %v", err)
	}

	if _, err := s.ApplyDamage("alice", 100); err != nil {
		t.Fatalf("ApplyDamage: %v", err)
	}
	if _, _, err := s.CollectCoin("alice"); !errors.Is(err, ErrPlayerDead) {
		t.Fatalf("coleta de morto = %v, want ErrPlayerDead", err)
	}

	// respawn: economia da sessão preservada
	s.Tick()
	s.Tick()
	p := simID(s, "alice")
	if !p.Alive {
		t.Fatal("alice deveria ter respawnado")
	}
	if p.Coins != 5 {
		t.Errorf("moedas após respawn = %d, want 5 (economia persiste)", p.Coins)
	}
}

func TestSimDeterminismoPorSeed(t *testing.T) {
	// mesma seed → mesma sequência de coletas (determinismo)
	s1 := NewSim(NewRandomSource(42), SimConfig{MinCoinDrop: 1, MaxCoinDrop: 5})
	s2 := NewSim(NewRandomSource(42), SimConfig{MinCoinDrop: 1, MaxCoinDrop: 5})
	s1.AddPlayer("a")
	s2.AddPlayer("a")
	var seq1, seq2 []int
	for i := 0; i < 20; i++ {
		a1, _, err1 := s1.CollectCoin("a")
		a2, _, err2 := s2.CollectCoin("a")
		if err1 != nil || err2 != nil {
			t.Fatalf("coleta: %v / %v", err1, err2)
		}
		seq1 = append(seq1, a1)
		seq2 = append(seq2, a2)
	}
	for i := range seq1 {
		if seq1[i] != seq2[i] {
			t.Fatalf("mesma seed divergiu na coleta %d: %d vs %d", i, seq1[i], seq2[i])
		}
	}

	// seeds diferentes → sequências diferentes (20 amostras; colisão é
	// desprezível com faixa [1,5])
	s3 := NewSim(NewRandomSource(43), SimConfig{MinCoinDrop: 1, MaxCoinDrop: 5})
	s3.AddPlayer("a")
	same := true
	for i := 0; i < 20; i++ {
		a, _, err := s3.CollectCoin("a")
		if err != nil {
			t.Fatalf("coleta s3: %v", err)
		}
		if a != seq1[i] {
			same = false
		}
	}
	if same {
		t.Error("seeds diferentes (42 vs 43) produziram sequências idênticas")
	}
}
