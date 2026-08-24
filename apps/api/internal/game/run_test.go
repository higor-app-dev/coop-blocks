package game

import (
	"errors"
	"reflect"
	"testing"
)

func TestRunNovoComecaEmPlayingFase1(t *testing.T) {
	r := NewRun()
	if r.Phase() != PhasePlaying {
		t.Errorf("Phase() = %v, want PhasePlaying", r.Phase())
	}
	if r.Number() != 1 {
		t.Errorf("Number() = %d, want 1", r.Number())
	}
	if got := r.ReadyStatus(); len(got) != 0 {
		t.Errorf("ReadyStatus() = %v, want vazio", got)
	}
}

func TestRunEnterShopAbreLojaEResetaProntos(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.AddPlayer("bob")
	if !r.EnterShop() {
		t.Fatal("primeiro EnterShop deve transicionar playing→shop")
	}
	if r.Phase() != PhaseShop {
		t.Errorf("Phase() = %v, want PhaseShop", r.Phase())
	}
	if got := r.ReadyStatus(); !reflect.DeepEqual(got, map[string]bool{"alice": false, "bob": false}) {
		t.Errorf("ReadyStatus() = %v, want todos false", got)
	}
	if r.EnterShop() {
		t.Error("segundo EnterShop não deve transicionar (já está na loja)")
	}
}

func TestRunMarkReadyForaDaLojaErro(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	_, err := r.MarkReady("alice")
	if !errors.Is(err, ErrNotInShop) {
		t.Errorf("MarkReady em playing = %v, want ErrNotInShop", err)
	}
}

func TestRunMarkReadyJogadorDesconhecidoErro(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.EnterShop()
	_, err := r.MarkReady("carol")
	if !errors.Is(err, ErrNotInRun) {
		t.Errorf("MarkReady desconhecido = %v, want ErrNotInRun", err)
	}
}

func TestRunMarkReadySoAvisaTodosProntosQuandoTodosConfirmaram(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.AddPlayer("bob")
	r.EnterShop()

	allReady, err := r.MarkReady("alice")
	if err != nil {
		t.Fatalf("MarkReady(alice) err = %v", err)
	}
	if allReady {
		t.Error("allReady = true com bob ainda não pronto, want false")
	}
	if got := r.ReadyStatus(); !reflect.DeepEqual(got, map[string]bool{"alice": true, "bob": false}) {
		t.Errorf("ReadyStatus() = %v, want alice pronto", got)
	}

	allReady, err = r.MarkReady("bob")
	if err != nil {
		t.Fatalf("MarkReady(bob) err = %v", err)
	}
	if !allReady {
		t.Error("allReady = false com todos prontos, want true")
	}
}

func TestRunMarkReadyIdempotente(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.EnterShop()
	if _, err := r.MarkReady("alice"); err != nil {
		t.Fatalf("primeiro MarkReady err = %v", err)
	}
	allReady, err := r.MarkReady("alice") // repetido — client flaky re-envia
	if err != nil {
		t.Fatalf("MarkReady repetido err = %v", err)
	}
	if !allReady {
		t.Error("allReady = false com a única jogadora pronta, want true")
	}
}

func TestRunAdvanceIncrementaNumeroEVoltaParaPlaying(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.EnterShop()
	r.MarkReady("alice")
	r.Advance()
	if r.Phase() != PhasePlaying {
		t.Errorf("Phase() = %v, want PhasePlaying após Advance", r.Phase())
	}
	if r.Number() != 2 {
		t.Errorf("Number() = %d, want 2 após Advance", r.Number())
	}
	if got := r.ReadyStatus(); len(got) != 0 {
		t.Errorf("ReadyStatus() = %v, want vazio após Advance", got)
	}
}

func TestRunAdvanceForaDaLojaNaoMudaNada(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.Advance() // playing → Advance sem efeito
	if r.Phase() != PhasePlaying || r.Number() != 1 {
		t.Errorf("Advance em playing mudou estado: phase=%v number=%d", r.Phase(), r.Number())
	}
}

func TestRunRemovePlayerDuranteLojaPodeLiberarAvanco(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.AddPlayer("bob")
	r.EnterShop()
	r.MarkReady("alice")
	// bob desistiu da partida na loja — sobra só alice (pronta): avanço liberado.
	if !r.RemovePlayer("bob") {
		t.Error("RemovePlayer(bob) = false, want true (restantes todos prontos)")
	}
	if got := r.ReadyStatus(); !reflect.DeepEqual(got, map[string]bool{"alice": true}) {
		t.Errorf("ReadyStatus() = %v, want só alice pronta", got)
	}
}

func TestRunRemovePlayerForaDaLojaNaoLiberaAvanco(t *testing.T) {
	r := NewRun()
	r.AddPlayer("alice")
	r.AddPlayer("bob")
	if r.RemovePlayer("bob") {
		t.Error("RemovePlayer em playing = true, want false")
	}
}

func TestRunElencoVazioNuncaFicaAllReady(t *testing.T) {
	r := NewRun()
	r.EnterShop()
	// Sem elenco, nenhum jogador pode marcar pronto e o avanço nunca é liberado.
	if _, err := r.MarkReady("ghost"); !errors.Is(err, ErrNotInRun) {
		t.Errorf("MarkReady sem elenco = %v, want ErrNotInRun", err)
	}
}
