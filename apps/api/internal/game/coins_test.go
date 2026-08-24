package game

import (
	"encoding/json"
	"testing"
)

// playerTest monta um Player com ID, posição (top-left, px) e HP para os
// testes de coleta (a física completa está em player_test.go).
func playerTest(id string, x, y, hp int) Player {
	return Player{ID: id, PlayerState: PlayerState{X: x, Y: y, HP: hp}}
}

func TestCoinConfigDefaults(t *testing.T) {
	m := NewCoinManagerDefault()
	if m.cfg.Width != CoinDefaultWidth || m.cfg.Height != CoinDefaultHeight {
		t.Errorf("hitbox = %vx%v, want %vx%v", m.cfg.Width, m.cfg.Height, CoinDefaultWidth, CoinDefaultHeight)
	}
	if m.CountCoins() != 0 {
		t.Errorf("CountCoins = %d, want 0", m.CountCoins())
	}
}

func TestCoinSpawnAtIDUnico(t *testing.T) {
	m := NewCoinManagerDefault()
	c1 := m.SpawnAt(100, 100)
	c2 := m.SpawnAt(200, 100)
	c3 := m.SpawnAt(300, 100)
	if c1.ID != "c1" || c2.ID != "c2" || c3.ID != "c3" {
		t.Errorf("IDs = %q,%q,%q, want c1,c2,c3", c1.ID, c2.ID, c3.ID)
	}
	if c1.X != 100 || c1.Y != 100 || c1.W != CoinDefaultWidth || c1.H != CoinDefaultHeight {
		t.Errorf("c1 = %+v, want pos (100,100) 14x14", c1)
	}
	if m.CountCoins() != 3 {
		t.Errorf("CountCoins = %d, want 3", m.CountCoins())
	}
}

func TestCoinSpawnForLevelEspelhaClient(t *testing.T) {
	l, err := GenerateLevel(LevelSpec{Width: 120, Height: 12, Seed: 1})
	if err != nil {
		t.Fatalf("GenerateLevel: %v", err)
	}

	// Esperado: uma moeda por posição de Level.CoinSpawns (chão + topos de
	// plataforma decididos pelo gerador). A fase seed 1 precisa ter moedas.
	want := len(l.CoinSpawns)
	if want == 0 {
		t.Fatalf("fase seed 1 não tem moedas")
	}

	m := NewCoinManagerDefault()
	if got := m.SpawnForLevel(&l); got != want {
		t.Fatalf("SpawnForLevel = %d, want %d moedas", got, want)
	}
	if m.CountCoins() != want {
		t.Fatalf("CountCoins = %d, want %d", m.CountCoins(), want)
	}

	snap := m.Snapshot()
	if len(snap) != want {
		t.Fatalf("snapshot len = %d, want %d", len(snap), want)
	}

	// Posições esperadas (uma por CoinSpawns): centro da coluna e
	// CoinFloatHeight acima do topo do tile, menos metade da hitbox (top-left).
	expected := make(map[[2]int]bool, want)
	for _, t := range l.CoinSpawns {
		expected[[2]int{
			t.X*TileSize + TileSize/2 - CoinDefaultWidth/2,
			t.Y*TileSize - CoinFloatHeight - CoinDefaultHeight/2,
		}] = true
	}
	if len(expected) != want {
		t.Fatalf("posições esperadas com colisão: %d de %d", len(expected), want)
	}

	// Cada moeda: posição dentro do conjunto esperado, tile sólido abaixo e
	// espaço livre acima (nunca dentro de parede nem sobre lacuna). ID único
	// e snapshot ordenado.
	seen := map[string]bool{}
	for i, cs := range snap {
		if seen[cs.ID] {
			t.Fatalf("ID %q duplicado no snapshot", cs.ID)
		}
		seen[cs.ID] = true
		if i > 0 && !(snap[i-1].ID < cs.ID) {
			t.Errorf("snapshot fora de ordem em %d (%q >= %q)", i, snap[i-1].ID, cs.ID)
		}
		if !expected[[2]int{cs.X, cs.Y}] {
			t.Errorf("moeda %s em (%d,%d) fora do conjunto esperado de CoinSpawns", cs.ID, cs.X, cs.Y)
		}
		// tile da moeda (coluna do centro, fileira do topo do tile de apoio)
		col := (cs.X + CoinDefaultWidth/2 - TileSize/2) / TileSize
		row := (cs.Y + CoinDefaultHeight/2 + CoinFloatHeight) / TileSize
		if !l.Solid(col, row) {
			t.Errorf("moeda %s em coluna %d sem tile sólido abaixo (dentro de parede/lacuna)", cs.ID, col)
		}
		if l.Solid(col, row-1) {
			t.Errorf("moeda %s enterrada (tile sólido acima em (%d,%d))", cs.ID, col, row-1)
		}
	}

	// Determinismo: mesma fase → mesmo conjunto de moedas.
	m2 := NewCoinManagerDefault()
	m2.SpawnForLevel(&l)
	snap2 := m2.Snapshot()
	if len(snap2) != len(snap) {
		t.Fatalf("segunda geração = %d moedas, want %d", len(snap2), len(snap))
	}
	for i := range snap {
		if snap[i].ID != snap2[i].ID || snap[i].X != snap2[i].X || snap[i].Y != snap2[i].Y {
			t.Errorf("moeda %d difere entre gerações: %+v vs %+v", i, snap[i], snap2[i])
		}
	}
}

func TestCoinStepColetaIndividual(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100) // alice
	m.SpawnAt(300, 300) // bob

	alice := playerTest("alice", 100, 100, 100)
	bob := playerTest("bob", 300, 300, 100)

	evs := m.Step([]Player{alice, bob})
	if len(evs) != 2 {
		t.Fatalf("events = %+v, want 2 coletas", evs)
	}
	if m.Count("alice") != 1 || m.Count("bob") != 1 {
		t.Errorf("contadores = alice:%d bob:%d, want 1 e 1", m.Count("alice"), m.Count("bob"))
	}
	if m.CountCoins() != 0 {
		t.Errorf("CountCoins = %d, want 0 (todas coletadas)", m.CountCoins())
	}

	// Sem caixa comum: contadores são individuais.
	counts := m.Counts()
	if counts["alice"] != 1 || counts["bob"] != 1 {
		t.Errorf("Counts = %+v, want alice:1 bob:1", counts)
	}
}

func TestCoinStepRemoveMoedaNaoReColeta(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100)

	alice := playerTest("alice", 100, 100, 100)
	evs := m.Step([]Player{alice})
	if len(evs) != 1 || evs[0].CoinID != "c1" || evs[0].PlayerID != "alice" {
		t.Fatalf("events = %+v, want [c1 coletada por alice]", evs)
	}
	if evs[0].X != 100 || evs[0].Y != 100 {
		t.Errorf("evento X/Y = (%v,%v), want (100,100)", evs[0].X, evs[0].Y)
	}

	// Segundo Step (mesmo jogador parado): moeda já removida → nada.
	if evs := m.Step([]Player{alice}); len(evs) != 0 {
		t.Fatalf("segundo step = %+v, want nenhum evento (moeda removida)", evs)
	}
	if m.Count("alice") != 1 {
		t.Errorf("Count alice = %d, want 1 (uma única coleta)", m.Count("alice"))
	}
}

func TestCoinStepMesmaMoedaTickSoUmColeta(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100) // única moeda tocada pelos dois

	// alice (menor ID) e bob se sobrepõem à mesma moeda no mesmo tick.
	alice := playerTest("alice", 100, 100, 100)
	bob := playerTest("bob", 110, 100, 100)

	evs := m.Step([]Player{alice, bob})
	if len(evs) != 1 || evs[0].PlayerID != "alice" {
		t.Fatalf("events = %+v, want [alice] (menor ID leva a moeda)", evs)
	}
	if m.Count("alice") != 1 || m.Count("bob") != 0 {
		t.Errorf("contadores = alice:%d bob:%d, want 1 e 0", m.Count("alice"), m.Count("bob"))
	}
	if m.CountCoins() != 0 {
		t.Errorf("CountCoins = %d, want 0", m.CountCoins())
	}
}

func TestCoinStepDeterministico(t *testing.T) {
	run := func() []CoinEvent {
		m := NewCoinManagerDefault()
		m.SpawnAt(100, 100)
		m.SpawnAt(200, 100)
		m.SpawnAt(300, 100)
		players := []Player{
			playerTest("bob", 110, 100, 100),
			playerTest("alice", 100, 100, 100),
		}
		return m.Step(players)
	}

	first := run()
	second := run()
	if len(first) != len(second) {
		t.Fatalf("eventos divergem: %+v vs %+v", first, second)
	}
	for i := range first {
		if first[i] != second[i] {
			t.Errorf("evento %d difere: %+v vs %+v", i, first[i], second[i])
		}
	}
}

func TestCoinMortoNaoColeta(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100)

	dead := playerTest("bob", 100, 100, 0) // HP 0
	if evs := m.Step([]Player{dead}); len(evs) != 0 {
		t.Fatalf("morto coletou: %+v", evs)
	}
	if m.Count("bob") != 0 {
		t.Errorf("Count bob = %d, want 0", m.Count("bob"))
	}
	if m.CountCoins() != 1 {
		t.Errorf("CountCoins = %d, want 1 (moeda intacta)", m.CountCoins())
	}
}

func TestCoinMorteZeraSoContadorDoMorto(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100) // alice
	m.SpawnAt(115, 100) // alice (adjacente — mesma varredura do tick)
	m.SpawnAt(300, 300) // bob

	evs := m.Step([]Player{
		playerTest("alice", 100, 100, 100),
		playerTest("bob", 300, 300, 100),
	})
	if len(evs) != 3 {
		t.Fatalf("events = %+v, want 3", evs)
	}
	if m.Count("alice") != 2 || m.Count("bob") != 1 {
		t.Fatalf("pré-morte: alice:%d bob:%d, want 2 e 1", m.Count("alice"), m.Count("bob"))
	}
	if m.CountCoins() != 0 {
		t.Fatalf("CountCoins = %d, want 0 (todas coletadas)", m.CountCoins())
	}

	// Alice morre no mapa atual → zera SÓ o contador dela.
	m.ResetPlayer("alice")
	if m.Count("alice") != 0 {
		t.Errorf("Count alice pós-morte = %d, want 0", m.Count("alice"))
	}
	if m.Count("bob") != 1 {
		t.Errorf("Count bob pós-morte = %d, want 1 (intocado)", m.Count("bob"))
	}
	if m.CountCoins() != 0 {
		t.Errorf("CountCoins = %d, want 0 (moedas coletadas não voltam)", m.CountCoins())
	}
}

func TestCoinMorteNaoTocaCarteiraPersistente(t *testing.T) {
	// Carteira persistente (Sim.Coins) e contador da fase (CoinManager) são
	// camadas separadas: a morte zera só a da fase.
	sim := NewSimDefault(NewRandomSource(1))
	sim.AddPlayer("alice")
	if _, err := sim.AddCoins("alice", 5); err != nil {
		t.Fatalf("AddCoins: %v", err)
	}

	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100)
	if evs := m.Step([]Player{playerTest("alice", 100, 100, 100)}); len(evs) != 1 {
		t.Fatalf("step = %+v, want 1 coleta", evs)
	}
	if m.Count("alice") != 1 {
		t.Fatalf("contador da fase = %d, want 1", m.Count("alice"))
	}

	m.ResetPlayer("alice") // morte no mapa atual
	if m.Count("alice") != 0 {
		t.Errorf("contador da fase pós-morte = %d, want 0", m.Count("alice"))
	}
	if p, ok := sim.GetPlayer("alice"); !ok || p.Coins != 5 {
		t.Errorf("carteira persistente = %+v, want Coins=5 (morte não toca)", p)
	}
}

func TestCoinSnapshotOrdenado(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(300, 100)
	m.SpawnAt(100, 100)
	m.SpawnAt(200, 100)

	snap := m.Snapshot()
	if len(snap) != 3 {
		t.Fatalf("snapshot len = %d, want 3", len(snap))
	}
	// ordem estável por ID (c1, c2, c3) — independente da ordem de criação
	for i, want := range []string{"c1", "c2", "c3"} {
		if snap[i].ID != want {
			t.Errorf("snapshot[%d].ID = %q, want %q", i, snap[i].ID, want)
		}
	}
	// posições preservadas na ordem de criação: c1@300, c2@100, c3@200
	wantX := []int{300, 100, 200}
	for i, x := range wantX {
		if snap[i].X != x {
			t.Errorf("snapshot[%d].X = %d, want %d", i, snap[i].X, x)
		}
	}
	if snap[0].Y != 100 || snap[0].W != 14 || snap[0].H != 14 {
		t.Errorf("snapshot[0] = %+v, want pos (300,100) 14x14", snap[0])
	}
}

func TestCoinReset(t *testing.T) {
	m := NewCoinManagerDefault()
	m.SpawnAt(100, 100)
	m.Step([]Player{playerTest("alice", 100, 100, 100)})
	if m.Count("alice") != 1 || m.CountCoins() != 0 {
		t.Fatalf("pré-reset: count=%d coins=%d", m.Count("alice"), m.CountCoins())
	}

	m.Reset() // novo ciclo de fase
	if m.CountCoins() != 0 {
		t.Errorf("CountCoins pós-reset = %d, want 0", m.CountCoins())
	}
	if m.Count("alice") != 0 {
		t.Errorf("Count alice pós-reset = %d, want 0", m.Count("alice"))
	}
	// sistema segue utilizável após reset
	m.SpawnAt(50, 50)
	if m.CountCoins() != 1 || m.Snapshot()[0].ID != "c2" {
		t.Errorf("pós-reset spawn: %+v, want 1 moeda c2", m.Snapshot())
	}
}

func TestCoinsMsgShape(t *testing.T) {
	coins := []CoinState{{ID: "c2", X: 12, Y: 34, W: 14, H: 14}}
	removed := []CoinRemoved{{ID: "c1", X: 100, Y: 100}}
	counts := map[string]int{"alice": 3, "bob": 0}

	msg := CoinsMsg(coins, removed, counts)
	if msg["type"] != "coins" {
		t.Errorf("type = %v, want coins", msg["type"])
	}
	if got := msg["coins"]; len(got.([]CoinState)) != 1 {
		t.Errorf("coins = %+v, want 1", got)
	}
	if got := msg["removed"]; len(got.([]CoinRemoved)) != 1 || got.([]CoinRemoved)[0].ID != "c1" {
		t.Errorf("removed = %+v, want [c1]", got)
	}
	if got := msg["counts"].(map[string]int); got["alice"] != 3 || got["bob"] != 0 {
		t.Errorf("counts = %+v, want alice:3 bob:0", got)
	}

	// Serializa como JSON sem campos nil (client faz JSON.parse direto).
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	for _, field := range []string{"type", "coins", "removed", "counts"} {
		if _, ok := parsed[field]; !ok {
			t.Errorf("campo %q ausente no JSON: %s", field, raw)
		}
	}

	// counts nil → objeto vazio (nunca null no JSON).
	msgNil := CoinsMsg(nil, nil, nil)
	rawNil, _ := json.Marshal(msgNil)
	if string(rawNil) == `{"counts":null}` {
		t.Errorf("counts nil serializou como null: %s", rawNil)
	}
	if got := msgNil["counts"].(map[string]int); len(got) != 0 {
		t.Errorf("counts nil = %+v, want vazio", got)
	}
	// removed nil → array vazio (nunca null no JSON).
	if got := msgNil["removed"].([]CoinRemoved); len(got) != 0 {
		t.Errorf("removed nil = %+v, want vazio", got)
	}
}

func TestWorldMsgCarregaMoedas(t *testing.T) {
	coins := []CoinState{{ID: "c1", X: 10, Y: 20, W: 14, H: 14}}
	counts := map[string]int{"alice": 2}

	msg := WorldMsg(nil, nil, nil, coins, counts)
	if got := msg["coins"].([]CoinState); len(got) != 1 || got[0].ID != "c1" {
		t.Errorf("coins = %+v, want [c1]", got)
	}
	if got := msg["coinCounts"].(map[string]int); got["alice"] != 2 {
		t.Errorf("coinCounts = %+v, want alice:2", got)
	}
	// type preservado (compatibilidade com o client atual)
	if msg["type"] != "players" {
		t.Errorf("type = %v, want players", msg["type"])
	}

	// coinCounts nil → objeto vazio (nunca null)
	msgNil := WorldMsg(nil, nil, nil, nil, nil)
	if got := msgNil["coinCounts"].(map[string]int); len(got) != 0 {
		t.Errorf("coinCounts nil = %+v, want vazio", got)
	}
}
