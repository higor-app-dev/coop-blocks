package game

import (
	"fmt"
	"sort"
	"testing"
)

// elencoFingerprint devolve uma representação ordenada e comparável do elenco
// de inimigos (tipo + posição) — ignora IDs/HP para focar na composição.
func elencoFingerprint(es []Enemy) string {
	type key struct {
		t EnemyType
		x int
		y int
	}
	keys := make([]key, 0, len(es))
	for _, e := range es {
		keys = append(keys, key{e.Type, int(e.X), int(e.Y)})
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].t != keys[j].t {
			return keys[i].t < keys[j].t
		}
		if keys[i].x != keys[j].x {
			return keys[i].x < keys[j].x
		}
		return keys[i].y < keys[j].y
	})
	out := ""
	for _, k := range keys {
		out += fmt.Sprintf("%d@%d,%d;", k.t, k.x, k.y)
	}
	return out
}

// TestEnemySystemResetLimpaCampoESemeiaDeterministico garante que Reset limpa
// todos os inimigos e re-semeia o RNG: o mesmo seed depois do Reset reproduz
// EXATAMENTE o mesmo elenco de um sistema novo com o mesmo seed — base do
// determinismo por fase (mesma fase → mesmo mapa de inimigos para todos).
func TestEnemySystemResetLimpaCampoESemeiaDeterministico(t *testing.T) {
	lvl := genLevel(t, 120, 12, 7)
	mk := func() *EnemySystem {
		s := NewEnemySystemDefault(42)
		s.SetPhase(2)
		s.SpawnForLevel(&lvl)
		return s
	}

	base := mk()
	if len(base.Enemies()) == 0 {
		t.Fatal("SpawnForLevel não criou inimigos")
	}
	baseFp := elencoFingerprint(base.Enemies())

	// Reset limpa o campo.
	base.Reset(42)
	if got := len(base.Enemies()); got != 0 {
		t.Fatalf("Enemies() após Reset = %d, want 0", got)
	}

	// Re-spawn com o MESMO seed reproduz o elenco original (determinismo).
	base.SetPhase(2)
	base.SpawnForLevel(&lvl)
	if got := elencoFingerprint(base.Enemies()); got != baseFp {
		t.Errorf("elenco após Reset+respawn = %q, want %q (determinismo por seed)", got, baseFp)
	}
}

// TestEnemySystemResetMantemHookOnShoot garante que Reset preserva o hook de
// disparo registrado (não precisa ser re-registrado a cada fase).
func TestEnemySystemResetMantemHookOnShoot(t *testing.T) {
	lvl := genLevel(t, 120, 12, 7)
	s := NewEnemySystemDefault(42)
	s.SetPhase(2)
	s.SpawnForLevel(&lvl)

	called := false
	s.OnShoot(func(EnemyShot) { called = true })
	s.Reset(43)

	if s.onShoot == nil {
		t.Fatal("OnShoot perdido após Reset")
	}
	// O hook continua vivo e disparável (via Update, fora do lock).
	s.Update(&lvl, nil, FixedDT)
	_ = called
}
