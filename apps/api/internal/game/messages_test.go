package game

import (
	"encoding/json"
	"testing"
)

// TestPhaseMsgAbreLoja cobre o broadcast de abertura de loja: fase "shop",
// número, prontos por jogador e o estado individual de cada um (upgrades +
// saldo de moedas) — o que a tela de loja do client precisa para renderizar.
func TestPhaseMsgAbreLoja(t *testing.T) {
	msg := PhaseMsg(PhaseShop, 2, map[string]bool{"alice": true, "bob": false}, []PlayerRunState{
		{ID: "alice", Coins: 120, Stats: RunStats{MaxHP: 125, FireRateMultiplier: 1.2, ShieldCharges: 1}},
		{ID: "bob", Coins: 40, Stats: RunStats{MaxHP: 100, FireRateMultiplier: 1.0, ShieldCharges: 0}},
	})
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["type"] != "phase" {
		t.Errorf("type = %v, want phase", got["type"])
	}
	if got["phase"] != "shop" {
		t.Errorf("phase = %v, want shop", got["phase"])
	}
	if got["number"] != float64(2) {
		t.Errorf("number = %v, want 2", got["number"])
	}
	ready, ok := got["ready"].(map[string]any)
	if !ok || ready["alice"] != true || ready["bob"] != false {
		t.Errorf("ready = %v, want alice=true bob=false", got["ready"])
	}
	players, ok := got["players"].([]any)
	if !ok || len(players) != 2 {
		t.Fatalf("players = %v, want 2 entradas", got["players"])
	}
	p0, _ := players[0].(map[string]any)
	if p0["id"] != "alice" || p0["coins"] != float64(120) {
		t.Errorf("players[0] = %v, want alice com 120 moedas", players[0])
	}
	stats, _ := p0["stats"].(map[string]any)
	if stats["maxHp"] != float64(125) || stats["fireRate"] != 1.2 || stats["shield"] != float64(1) {
		t.Errorf("stats alice = %v, want maxHp 125 fireRate 1.2 shield 1", p0["stats"])
	}
}

// TestPhaseMsgPlayingSemReady garante que o broadcast de fase em andamento tem
// ready como objeto vazio (nunca null) — client trata {} como "ninguém na
// loja".
func TestPhaseMsgPlayingSemReady(t *testing.T) {
	msg := PhaseMsg(PhasePlaying, 3, nil, nil)
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(data) == `{"ready":null}` {
		t.Fatal("ready serializou como null, want {}")
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["phase"] != "playing" {
		t.Errorf("phase = %v, want playing", got["phase"])
	}
	if _, ok := got["ready"].(map[string]any); !ok {
		t.Errorf("ready = %v, want objeto vazio", got["ready"])
	}
	if got["players"] == nil {
		t.Error("players = null, want lista vazia")
	}
}

// TestShopReadyErrorMsgFormato cobre a resposta individual de erro de
// shop_ready (fora da loja / jogador desconhecido).
func TestShopReadyErrorMsgFormato(t *testing.T) {
	msg := ShopReadyErrorMsg("fora da loja")
	data, _ := json.Marshal(msg)
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["type"] != "shop_ready_result" || got["ok"] != false || got["error"] != "fora da loja" {
		t.Errorf("msg = %v, want shop_ready_result ok=false com erro", got)
	}
}
