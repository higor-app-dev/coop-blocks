package game

import (
	"errors"
	"testing"
)

// fakeWallet é uma carteira de teste que registra por jogador quanto foi
// gasto — permite asserir que a compra debita APENAS o comprador.
type fakeWallet struct {
	balances map[string]int
	spent    map[string]int
}

func newFakeWallet(balances map[string]int) *fakeWallet {
	w := &fakeWallet{balances: balances, spent: map[string]int{}}
	if w.balances == nil {
		w.balances = map[string]int{}
	}
	return w
}

func (w *fakeWallet) Balance(id string) (int, bool) {
	b, ok := w.balances[id]
	return b, ok
}

func (w *fakeWallet) Spend(id string, n int) error {
	b, ok := w.balances[id]
	if !ok {
		return ErrPlayerNotFound
	}
	if n <= 0 {
		return ErrNegativeAmount
	}
	if b < n {
		return ErrInsufficientCoins
	}
	w.balances[id] -= n
	w.spent[id] += n
	return nil
}

func TestShopCatalogDefault(t *testing.T) {
	s := NewShopDefault(newFakeWallet(nil))
	cat := s.Catalog()
	if len(cat) != 3 {
		t.Fatalf("catalog len = %d, want 3", len(cat))
	}
	byID := map[UpgradeID]Upgrade{}
	for _, u := range cat {
		byID[u.ID] = u
	}
	if u := byID[UpgradeMaxHP]; u.Cost != DefaultMaxHPCost || u.MaxLevel != DefaultMaxHPMaxLevel {
		t.Errorf("max_hp = %+v, want cost %d max %d", u, DefaultMaxHPCost, DefaultMaxHPMaxLevel)
	}
	if u := byID[UpgradeFireRate]; u.Cost != DefaultFireRateCost || u.MaxLevel != DefaultFireRateMaxLevel {
		t.Errorf("fire_rate = %+v, want cost %d max %d", u, DefaultFireRateCost, DefaultFireRateMaxLevel)
	}
	if u := byID[UpgradeShield]; u.Cost != DefaultShieldCost || u.MaxLevel != DefaultShieldMaxLevel {
		t.Errorf("shield = %+v, want cost %d max %d", u, DefaultShieldCost, DefaultShieldMaxLevel)
	}
}

func TestShopStatsSemUpgrade(t *testing.T) {
	s := NewShopDefault(newFakeWallet(nil))
	stats := s.Stats("alice")
	if stats.MaxHP != DefaultMaxHP {
		t.Errorf("MaxHP = %d, want %d", stats.MaxHP, DefaultMaxHP)
	}
	if stats.FireRateMultiplier != 1.0 {
		t.Errorf("FireRateMultiplier = %v, want 1.0", stats.FireRateMultiplier)
	}
	if stats.ShieldCharges != 0 {
		t.Errorf("ShieldCharges = %d, want 0", stats.ShieldCharges)
	}
}

func TestShopBuyMaxHPDebitaSaldoDoJogador(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 100})
	s := NewShopDefault(w)

	rc, err := s.Buy("alice", UpgradeMaxHP)
	if err != nil {
		t.Fatalf("Buy: %v", err)
	}
	if rc.UpgradeID != UpgradeMaxHP || rc.Level != 1 || rc.Cost != DefaultMaxHPCost {
		t.Errorf("receipt = %+v, want max_hp level 1 cost %d", rc, DefaultMaxHPCost)
	}
	if rc.Coins != 50 {
		t.Errorf("receipt.Coins = %d, want 50 (saldo restante)", rc.Coins)
	}
	if rc.Stats.MaxHP != DefaultMaxHP+DefaultMaxHPPerLevel {
		t.Errorf("stats.MaxHP = %d, want %d", rc.Stats.MaxHP, DefaultMaxHP+DefaultMaxHPPerLevel)
	}
	if w.spent["alice"] != DefaultMaxHPCost {
		t.Errorf("alice gastou %d, want %d", w.spent["alice"], DefaultMaxHPCost)
	}
}

func TestShopBuyDebitaApenasOComprador(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 100, "bob": 100})
	s := NewShopDefault(w)

	if _, err := s.Buy("alice", UpgradeMaxHP); err != nil {
		t.Fatalf("Buy alice: %v", err)
	}
	if w.balances["bob"] != 100 {
		t.Errorf("saldo do bob = %d, want 100 (não pode ser debitado)", w.balances["bob"])
	}
	if w.spent["bob"] != 0 {
		t.Errorf("bob gastou %d, want 0", w.spent["bob"])
	}
	if w.balances["alice"] != 50 {
		t.Errorf("saldo da alice = %d, want 50", w.balances["alice"])
	}
	// upgrade só existe no estado da alice
	if stats := s.Stats("bob"); stats.MaxHP != DefaultMaxHP {
		t.Errorf("bob.MaxHP = %d, want %d (estado individual)", stats.MaxHP, DefaultMaxHP)
	}
}

func TestShopBuyMoedasInsuficientes(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 10})
	s := NewShopDefault(w)

	_, err := s.Buy("alice", UpgradeMaxHP)
	if !errors.Is(err, ErrInsufficientCoins) {
		t.Fatalf("err = %v, want ErrInsufficientCoins", err)
	}
	if w.balances["alice"] != 10 {
		t.Errorf("saldo = %d, want 10 (nada debitado)", w.balances["alice"])
	}
	if w.spent["alice"] != 0 {
		t.Errorf("alice gastou %d, want 0", w.spent["alice"])
	}
	if stats := s.Stats("alice"); stats.MaxHP != DefaultMaxHP {
		t.Errorf("MaxHP = %d, want %d (upgrade não aplicado)", stats.MaxHP, DefaultMaxHP)
	}
}

func TestShopBuyUpgradeInvalido(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 100})
	s := NewShopDefault(w)

	_, err := s.Buy("alice", UpgradeID("invisivel"))
	if !errors.Is(err, ErrInvalidUpgrade) {
		t.Fatalf("err = %v, want ErrInvalidUpgrade", err)
	}
	if w.spent["alice"] != 0 {
		t.Errorf("alice gastou %d, want 0", w.spent["alice"])
	}
}

func TestShopBuyJogadorInexistente(t *testing.T) {
	s := NewShopDefault(newFakeWallet(nil))
	_, err := s.Buy("fantasma", UpgradeMaxHP)
	if !errors.Is(err, ErrPlayerNotFound) {
		t.Fatalf("err = %v, want ErrPlayerNotFound", err)
	}
}

func TestShopBuyNivelMaximo(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 500})
	s := NewShopDefault(w)

	for i := 1; i <= DefaultMaxHPMaxLevel; i++ {
		if _, err := s.Buy("alice", UpgradeMaxHP); err != nil {
			t.Fatalf("compra %d: %v", i, err)
		}
	}
	_, err := s.Buy("alice", UpgradeMaxHP)
	if !errors.Is(err, ErrUpgradeMaxed) {
		t.Fatalf("err = %v, want ErrUpgradeMaxed", err)
	}
	wantSpent := DefaultMaxHPCost * DefaultMaxHPMaxLevel
	if w.spent["alice"] != wantSpent {
		t.Errorf("alice gastou %d, want %d (compra acima do máx não debita)", w.spent["alice"], wantSpent)
	}
	if stats := s.Stats("alice"); stats.MaxHP != DefaultMaxHP+DefaultMaxHPPerLevel*DefaultMaxHPMaxLevel {
		t.Errorf("MaxHP = %d, want %d", stats.MaxHP, DefaultMaxHP+DefaultMaxHPPerLevel*DefaultMaxHPMaxLevel)
	}
}

func TestShopBuyShieldAbsorveUmHit(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 100})
	s := NewShopDefault(w)

	rc, err := s.Buy("alice", UpgradeShield)
	if err != nil {
		t.Fatalf("Buy shield: %v", err)
	}
	if rc.Stats.ShieldCharges != 1 {
		t.Errorf("ShieldCharges = %d, want 1", rc.Stats.ShieldCharges)
	}
	if !s.AbsorbShield("alice") {
		t.Error("primeiro hit deveria ser absorvido")
	}
	if s.AbsorbShield("alice") {
		t.Error("segundo hit não deveria ser absorvido (carga única)")
	}
	if stats := s.Stats("alice"); stats.ShieldCharges != 0 {
		t.Errorf("ShieldCharges = %d, want 0 após absorver", stats.ShieldCharges)
	}
}

func TestShopBuyFireRateAcumulaMultiplicador(t *testing.T) {
	w := newFakeWallet(map[string]int{"alice": 200})
	s := NewShopDefault(w)

	for i := 1; i <= 2; i++ {
		if _, err := s.Buy("alice", UpgradeFireRate); err != nil {
			t.Fatalf("compra %d: %v", i, err)
		}
	}
	want := 1.0 + DefaultFireRatePerLevel*2
	if stats := s.Stats("alice"); stats.FireRateMultiplier != want {
		t.Errorf("FireRateMultiplier = %v, want %v", stats.FireRateMultiplier, want)
	}
	if w.spent["alice"] != DefaultFireRateCost*2 {
		t.Errorf("alice gastou %d, want %d", w.spent["alice"], DefaultFireRateCost*2)
	}
}

// TestShopComSimRealCompraDebitaCarteiraEStatePersisteNaMorte é a integração
// com a carteira real (Sim): compra debita o saldo individual, o teto de HP
// sobe e sobrevive à morte/respawn (run state persiste).
func TestShopComSimRealCompraDebitaCarteiraEStatePersisteNaMorte(t *testing.T) {
	s := NewSimDefault(newScriptedRNG())
	s.AddPlayer("alice")
	s.AddPlayer("bob")
	if _, err := s.AddCoins("alice", 100); err != nil {
		t.Fatalf("AddCoins: %v", err)
	}
	if _, err := s.AddCoins("bob", 100); err != nil {
		t.Fatalf("AddCoins bob: %v", err)
	}

	shop := NewShopDefault(s)
	rc, err := shop.Buy("alice", UpgradeMaxHP)
	if err != nil {
		t.Fatalf("Buy: %v", err)
	}

	// alice pagou só com as moedas dela; bob intacto
	if got := simID(s, "alice").Coins; got != 50 {
		t.Errorf("alice.Coins = %d, want 50", got)
	}
	if got := simID(s, "bob").Coins; got != 100 {
		t.Errorf("bob.Coins = %d, want 100 (não debitado)", got)
	}

	// main.go aplica o efeito de max_hp no Sim (teto + cura do delta)
	if err := s.SetMaxHP("alice", rc.Stats.MaxHP); err != nil {
		t.Fatalf("SetMaxHP: %v", err)
	}
	if p := simID(s, "alice"); p.MaxHP != rc.Stats.MaxHP || p.HP != rc.Stats.MaxHP {
		t.Errorf("alice HP = %d/%d, want %d/%d (teto elevado e curado)", p.HP, p.MaxHP, rc.Stats.MaxHP, rc.Stats.MaxHP)
	}

	// morte e respawn: o teto elevado persiste (run state não reseta)
	if _, err := s.ApplyDamage("alice", 1000); err != nil {
		t.Fatalf("ApplyDamage: %v", err)
	}
	for i := 0; i <= s.cfg.RespawnTicks && !simID(s, "alice").Alive; i++ {
		s.Tick()
	}
	if p := simID(s, "alice"); !p.Alive || p.HP != rc.Stats.MaxHP || p.MaxHP != rc.Stats.MaxHP {
		t.Errorf("após respawn alice = %+v, want alive com %d/%d", p, rc.Stats.MaxHP, rc.Stats.MaxHP)
	}
}
