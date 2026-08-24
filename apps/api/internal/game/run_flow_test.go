package game

import (
	"encoding/json"
	"testing"
)

// TestFluxoLojaProntoEAvancoIntegrado espelha o acceptance do fluxo de loja:
// com dois jogadores, a fase só avança depois que AMBOS confirmam pronto, e o
// broadcast do avanço contém as estatísticas atualizadas (upgrade comprado) e
// o saldo INDIVIDUAL de moedas de cada jogador — o débito da compra de um não
// toca o saldo do outro.
//
// É o mesmo caminho que cmd/server/main.go executa (Run + Shop + Sim + Room +
// PhaseMsg), sem o transporte WebSocket.
func TestFluxoLojaProntoEAvancoIntegrado(t *testing.T) {
	sim := NewSimDefault(newScriptedRNG())
	room := NewRoom("default")
	shop := NewShopDefault(sim)
	run := NewRun()

	// Dois jogadores entram na run (sala + simulação + elenco da run).
	for _, id := range []string{"alice", "bob"} {
		room.AddPlayer(id)
		sim.AddPlayer(id)
		run.AddPlayer(id)
		sim.AddCoins(id, 100) // mesma carteira inicial para os dois
	}
	// Fim da fase 1: a loja abre.
	if !run.EnterShop() {
		t.Fatal("EnterShop não abriu a loja")
	}

	// Alice compra max_hp (50 moedas): o teto sobe no Sim e o saldo dela cai.
	rc, err := shop.Buy("alice", UpgradeMaxHP)
	if err != nil {
		t.Fatalf("Buy(alice, max_hp): %v", err)
	}
	if err := sim.SetMaxHP("alice", rc.Stats.MaxHP); err != nil {
		t.Fatalf("SetMaxHP: %v", err)
	}

	// Bob ainda não está pronto → a fase NÃO pode avançar (gate).
	allReady, err := run.MarkReady("alice")
	if err != nil || allReady {
		t.Fatalf("MarkReady(alice) = %v/%v, want false sem bob", allReady, err)
	}
	if run.Phase() != PhaseShop {
		t.Fatal("fase avançou antes de todos confirmarem pronto")
	}

	// Bob confirma pronto → todos prontos → avanço autorizado.
	allReady, err = run.MarkReady("bob")
	if err != nil || !allReady {
		t.Fatalf("MarkReady(bob) = %v/%v, want allReady=true", allReady, err)
	}

	// Avanço: o servidor reconstrói o próximo mapa (revive + respawn com o
	// teto individual) e fecha a loja.
	sim.ReviveAll()
	hps := map[string]int{}
	for _, sp := range sim.Snapshot() {
		hps[sp.ID] = sp.MaxHP
	}
	room.ResetToSpawn(96, 480, hps)
	run.Advance()

	if run.Phase() != PhasePlaying || run.Number() != 2 {
		t.Fatalf("após avanço: phase=%v number=%d, want playing/2", run.Phase(), run.Number())
	}

	// Broadcast do avanço: stats atualizados + saldo individual por jogador.
	msg := PhaseMsg(run.Phase(), run.Number(), run.ReadyStatus(), runPlayersLike(run, shop, sim))
	data, _ := json.Marshal(msg)
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal phase: %v", err)
	}
	if got["phase"] != "playing" || got["number"] != float64(2) {
		t.Errorf("phase msg = %v/%v, want playing/2", got["phase"], got["number"])
	}
	players, _ := got["players"].([]any)
	if len(players) != 2 {
		t.Fatalf("players = %d entradas, want 2", len(players))
	}
	byID := map[string]map[string]any{}
	for _, p := range players {
		m, _ := p.(map[string]any)
		byID[m["id"].(string)] = m
	}
	alice, ok := byID["alice"]
	if !ok {
		t.Fatal("alice ausente no broadcast de fase")
	}
	// 100 iniciais − 50 da compra = 50; stats com maxHp 125 (upgrade aplicado).
	if alice["coins"] != float64(50) {
		t.Errorf("alice coins = %v, want 50 (100 − 50 da compra)", alice["coins"])
	}
	astats, _ := alice["stats"].(map[string]any)
	if astats["maxHp"] != float64(125) {
		t.Errorf("alice stats.maxHp = %v, want 125 (upgrade aplicado)", astats["maxHp"])
	}
	bob, ok := byID["bob"]
	if !ok {
		t.Fatal("bob ausente no broadcast de fase")
	}
	// Bob não comprou nada: saldo intacto, stats base.
	if bob["coins"] != float64(100) {
		t.Errorf("bob coins = %v, want 100 (compra de alice não o afeta)", bob["coins"])
	}
	bstats, _ := bob["stats"].(map[string]any)
	if bstats["maxHp"] != float64(DefaultMaxHP) {
		t.Errorf("bob stats.maxHp = %v, want %d", bstats["maxHp"], DefaultMaxHP)
	}
}

// runPlayersLike espelha o helper do servidor (main.go): estado individual de
// cada jogador — upgrades efetivos (loja) + saldo individual (Sim).
func runPlayersLike(run *Run, shop *Shop, sim *Sim) []PlayerRunState {
	out := make([]PlayerRunState, 0)
	for _, sp := range sim.Snapshot() {
		out = append(out, PlayerRunState{ID: sp.ID, Coins: sp.Coins, Stats: shop.Stats(sp.ID)})
	}
	return out
}
