// Package game — testes dos power-ups coletáveis da fase (powerups.go).
//
// Cobre o manager espelhando o padrão de CoinManager (spawn por fase com IDs
// únicos, coleta por sobreposição AABB, snapshot ordenado, reset) e os
// efeitos ativos POR JOGADOR (vida acima do teto, tiro triplo com duração
// exata, escudo de 1 hit, limpeza na morte).
package game

import (
	"fmt"
	"testing"
)

// playerPowerUp monta um jogador para os testes de coleta (mesma convenção
// dos testes de moedas: X/Y do hitbox em pixels, HP > 0 = vivo).
func playerPowerUp(id string, x, y, hp int) Player {
	return Player{ID: id, PlayerState: PlayerState{X: x, Y: y, HP: hp}}
}

// TestPowerUpSpawnForLevel verifica que o manager registra exatamente os
// spawns do gerador: um power-up por PowerUpSpawns do level, com ID único
// sequencial (p1, p2, …), o tipo do spawn preservado e a conversão
// tile→pixels (centro da coluna, PowerUpFloatHeight acima do topo do tile).
func TestPowerUpSpawnForLevel(t *testing.T) {
	for _, spec := range testSpecs {
		for _, seed := range testSeeds {
			name := fmt.Sprintf("%s_seed_%d", spec.name, seed)
			t.Run(name, func(t *testing.T) {
				l := genLevel(t, spec.width, spec.height, seed)
				if len(l.PowerUpSpawns) == 0 {
					t.Fatal("fase sem PowerUpSpawns")
				}

				m := NewPowerUpManagerDefault()
				if got := m.SpawnForLevel(&l); got != len(l.PowerUpSpawns) {
					t.Fatalf("SpawnForLevel = %d, want %d power-ups", got, len(l.PowerUpSpawns))
				}

				// Uma entidade por spawn, com posição derivada do tile e o
				// tipo do spawn preservado.
				porPosicao := map[string]*PowerUpState{}
				for i := range m.Snapshot() {
					st := m.Snapshot()[i]
					porPosicao[fmt.Sprintf("%d,%d", st.X, st.Y)] = &st
				}
				for _, sp := range l.PowerUpSpawns {
					wantX := float64(sp.Tile.X*TileSize) + TileSize/2.0 - PowerUpDefaultWidth/2
					wantY := float64(sp.Tile.Y*TileSize) - PowerUpFloatHeight - PowerUpDefaultHeight/2
					st, ok := porPosicao[fmt.Sprintf("%d,%d", int(wantX), int(wantY))]
					if !ok {
						t.Fatalf("power-up %+v (%s) não registrado em (%d,%d)", sp.Tile, sp.Kind, int(wantX), int(wantY))
					}
					if st.Kind != sp.Kind.String() {
						t.Errorf("power-up em %v: tipo %s, want %s", sp.Tile, st.Kind, sp.Kind)
					}
				}
			})
		}
	}
}

// TestPowerUpIDsSequenciais verifica a numeração única p1..pN na ordem dos
// spawns (mesmo esquema de moedas/inimigos/projéteis).
func TestPowerUpIDsSequenciais(t *testing.T) {
	l := genLevel(t, 120, 12, 7)
	m := NewPowerUpManagerDefault()
	m.SpawnForLevel(&l)
	ids := map[string]bool{}
	for i, st := range m.Snapshot() {
		want := "p" + fmt.Sprint(i+1)
		if st.ID != want {
			t.Errorf("snapshot[%d].ID = %s, want %s", i, st.ID, want)
		}
		if ids[st.ID] {
			t.Errorf("ID duplicado %s", st.ID)
		}
		ids[st.ID] = true
	}
}

// TestPowerUpStepColeta verifica a coleta por sobreposição AABB: o jogador
// vivo que toca o power-up recebe o evento (tipo, jogador, posição), o
// power-up sai do mundo e jogador morto (HP <= 0) NÃO coleta.
func TestPowerUpStepColeta(t *testing.T) {
	l := genLevel(t, 120, 12, 42)
	m := NewPowerUpManagerDefault()
	m.SpawnForLevel(&l)
	antes := m.CountPowerUps()
	if antes == 0 {
		t.Fatal("fase sem power-ups para testar coleta")
	}

	// Jogador vivo posicionado sobre o PRIMEIRO power-up da snapshot (ordem
	// canônica por ID — posição conhecida).
	alvo := m.Snapshot()[0]
	jogador := playerPowerUp("p1", alvo.X, alvo.Y, 100)

	evs := m.Step([]Player{jogador})
	if len(evs) != 1 {
		t.Fatalf("Step = %d eventos, want 1 (coleta do power-up %s)", len(evs), alvo.ID)
	}
	ev := evs[0]
	if ev.PowerUpID != alvo.ID || ev.PlayerID != "p1" {
		t.Errorf("evento %+v, want coleta de %s por p1", ev, alvo.ID)
	}
	if ev.Kind.String() != alvo.Kind {
		t.Errorf("evento kind %s, want %s", ev.Kind, alvo.Kind)
	}
	if m.CountPowerUps() != antes-1 {
		t.Errorf("CountPowerUps = %d, want %d (coletado)", m.CountPowerUps(), antes-1)
	}
	for _, st := range m.Snapshot() {
		if st.ID == alvo.ID {
			t.Errorf("power-up %s ainda no mundo após a coleta", alvo.ID)
		}
	}

	// Jogador morto não coleta.
	m2 := NewPowerUpManagerDefault()
	m2.SpawnForLevel(&l)
	evs = m2.Step([]Player{playerPowerUp("morto", alvo.X, alvo.Y, 0)})
	if len(evs) != 0 {
		t.Errorf("jogador morto coletou: %d eventos", len(evs))
	}
}

// TestPowerUpStepDeterminismo verifica que mesmos estados produzem exatamente
// os mesmos eventos de coleta (ordem fixa: power-ups por ID, jogadores vivos
// por ID — empate decidido pelo menor ID, como nas moedas).
func TestPowerUpStepDeterminismo(t *testing.T) {
	l := genLevel(t, 120, 12, 42) // seed com 3 power-ups (verificado)
	m1 := NewPowerUpManagerDefault()
	m2 := NewPowerUpManagerDefault()
	m1.SpawnForLevel(&l)
	m2.SpawnForLevel(&l)

	st1 := m1.Snapshot()
	if len(st1) < 2 {
		t.Fatal("fase com poucos power-ups para o teste de determinismo")
	}
	// Dois jogadores sobre o MESMO power-up: o de menor ID coleta (ordem fixa).
	j1 := playerPowerUp("b", st1[0].X, st1[0].Y, 100)
	j2 := playerPowerUp("a", st1[0].X, st1[0].Y, 100)

	ev1 := m1.Step([]Player{j1, j2})
	ev2 := m2.Step([]Player{j2, j1}) // ordem dos jogadores invertida
	if len(ev1) != len(ev2) {
		t.Fatalf("eventos = %d vs %d (determinismo quebrado)", len(ev1), len(ev2))
	}
	// Dois jogadores sobre o MESMO power-up geram EXATAMENTE um evento: o de
	// menor ID coleta (delete+break — o power-up sai do mundo no 1º overlap).
	if len(ev1) != 1 {
		t.Fatalf("eventos = %d, want exatamente 1 (um power-up, dois jogadores)", len(ev1))
	}
	for i := range ev1 {
		if ev1[i] != ev2[i] {
			t.Errorf("evento %d: %+v vs %+v", i, ev1[i], ev2[i])
		}
	}
	if len(ev1) > 0 && ev1[0].PlayerID != "a" {
		t.Errorf("coletor = %s, want a (menor ID no empate)", ev1[0].PlayerID)
	}
}

// TestPowerUpSnapshotOrdenado verifica que a snapshot sai ordenada por ID
// (ordem estável para broadcast/renderização).
func TestPowerUpSnapshotOrdenado(t *testing.T) {
	l := genLevel(t, 120, 12, 2024)
	m := NewPowerUpManagerDefault()
	m.SpawnForLevel(&l)
	st := m.Snapshot()
	for i := 1; i < len(st); i++ {
		if st[i].ID < st[i-1].ID {
			t.Errorf("snapshot fora de ordem: %s depois de %s", st[i].ID, st[i-1].ID)
		}
	}
}

// TestPowerUpReset verifica que Reset limpa coletáveis E efeitos E o relógio
// interno — usado no avanço de fase (efeitos não vazam entre fases).
func TestPowerUpReset(t *testing.T) {
	l := genLevel(t, 120, 12, 1)
	m := NewPowerUpManagerDefault()
	m.SpawnForLevel(&l)
	m.ApplyCollected("jogador", PowerUpVida)
	m.ApplyCollected("jogador", PowerUpTiroTriplo)
	m.Step(nil) // avança o relógio
	m.Reset()

	if m.CountPowerUps() != 0 {
		t.Errorf("CountPowerUps = %d, want 0 após Reset", m.CountPowerUps())
	}
	if m.VidaBonusOf("jogador") != 0 {
		t.Errorf("VidaBonusOf = %d, want 0 após Reset", m.VidaBonusOf("jogador"))
	}
	if m.TripleShotActive("jogador") {
		t.Error("tiro triplo ainda ativo após Reset")
	}
	if m.ConsumeShield("jogador") {
		t.Error("escudo ainda disponível após Reset")
	}
	if len(m.EffectsSnapshot()) != 0 {
		t.Errorf("EffectsSnapshot = %v, want vazio após Reset", m.EffectsSnapshot())
	}
}

// TestPowerUpVidaBonus verifica o efeito VIDA: +PowerUpVidaBonus de HP acima
// do teto (constante — 25), aplicado ao coletar e zerado na limpeza.
func TestPowerUpVidaBonus(t *testing.T) {
	if PowerUpVidaBonus != 25 {
		t.Fatalf("PowerUpVidaBonus = %d, want 25 (especificação da task)", PowerUpVidaBonus)
	}
	m := NewPowerUpManagerDefault()
	m.ApplyCollected("alice", PowerUpVida)
	if got := m.VidaBonusOf("alice"); got != PowerUpVidaBonus {
		t.Errorf("VidaBonusOf(alice) = %d, want %d", got, PowerUpVidaBonus)
	}
	// Jogador que nunca coletou não tem bônus.
	if got := m.VidaBonusOf("bob"); got != 0 {
		t.Errorf("VidaBonusOf(bob) = %d, want 0", got)
	}
}

// TestPowerUpTiroTriploDuracaoExata verifica o efeito TIRO TRIPLO: dura
// EXATAMENTE PowerUpTiroTriploDurationTicks ticks (200 @ 20 tps = 10 s —
// especificação da task) a partir do tick da coleta.
func TestPowerUpTiroTriploDuracaoExata(t *testing.T) {
	if PowerUpTiroTriploDurationTicks != 10*TicksPerSecond {
		t.Fatalf("PowerUpTiroTriploDurationTicks = %d, want 10 s × %d tps = %d",
			PowerUpTiroTriploDurationTicks, TicksPerSecond, 10*TicksPerSecond)
	}
	m := NewPowerUpManagerDefault()

	// Relógio do manager avança a cada Step (uma chamada por tick do loop).
	m.Step(nil)
	m.Step(nil)
	m.Step(nil) // tick = 3
	m.ApplyCollected("alice", PowerUpTiroTriplo)
	if !m.TripleShotActive("alice") {
		t.Fatal("tiro triplo inativo imediatamente após coletar")
	}

	// No tick da expiração exata (tick 3 + 200) o efeito acaba.
	for i := 0; i < PowerUpTiroTriploDurationTicks; i++ {
		m.Step(nil)
	}
	if m.TripleShotActive("alice") {
		t.Error("tiro triplo ainda ativo após a duração exata (200 ticks = 10 s)")
	}

	// Re-coleta renova a partir do tick atual.
	m.ApplyCollected("alice", PowerUpTiroTriplo)
	if !m.TripleShotActive("alice") {
		t.Error("re-coleta não renovou o tiro triplo")
	}
}

// TestPowerUpEscudoUmHit verifica o efeito ESCUDO: absorve EXATAMENTE 1 dano
// e some ao ser atingido (segunda chamada devolve false).
func TestPowerUpEscudoUmHit(t *testing.T) {
	m := NewPowerUpManagerDefault()
	m.ApplyCollected("alice", PowerUpEscudo)
	if !m.ConsumeShield("alice") {
		t.Error("escudo não absorveu o primeiro hit")
	}
	if m.ConsumeShield("alice") {
		t.Error("escudo absorveu um segundo hit — deveria ter sumido")
	}
	// Jogador sem escudo nunca absorve.
	if m.ConsumeShield("bob") {
		t.Error("jogador sem escudo absorveu um hit")
	}
}

// TestPowerUpClearPlayerNaMorte verifica que TODOS os efeitos ativos somem
// quando o jogador morre (regra da task: efeito morre junto com o player) —
// sem afetar outros jogadores.
func TestPowerUpClearPlayerNaMorte(t *testing.T) {
	m := NewPowerUpManagerDefault()
	m.ApplyCollected("alice", PowerUpVida)
	m.ApplyCollected("alice", PowerUpTiroTriplo)
	m.ApplyCollected("alice", PowerUpEscudo)
	m.ApplyCollected("bob", PowerUpEscudo)

	m.ClearPlayer("alice")
	if m.VidaBonusOf("alice") != 0 {
		t.Errorf("vida de alice = %d, want 0 na morte", m.VidaBonusOf("alice"))
	}
	if m.TripleShotActive("alice") {
		t.Error("tiro triplo de alice ativo na morte")
	}
	if m.ConsumeShield("alice") {
		t.Error("escudo de alice disponível na morte")
	}
	// O efeito do outro jogador sobrevive.
	if !m.ConsumeShield("bob") {
		t.Error("escudo de bob foi limpo junto com o de alice")
	}
}

// TestPowerUpEffectsSnapshot verifica o estado wire dos efeitos ativos: mapa
// id → {vida, tripleShot (ticks RESTANTES, 0 = inativo), shield}.
func TestPowerUpEffectsSnapshot(t *testing.T) {
	m := NewPowerUpManagerDefault()
	m.Step(nil) // tick = 1
	m.ApplyCollected("alice", PowerUpVida)
	m.ApplyCollected("alice", PowerUpTiroTriplo)
	m.ApplyCollected("alice", PowerUpEscudo)

	// 10 ticks depois, restam 200-10 = 190 ticks de tiro triplo.
	for i := 0; i < 10; i++ {
		m.Step(nil)
	}
	eff := m.EffectsSnapshot()
	alice, ok := eff["alice"]
	if !ok {
		t.Fatalf("alice sem efeitos na snapshot: %v", eff)
	}
	if alice.Vida != PowerUpVidaBonus {
		t.Errorf("vida = %d, want %d", alice.Vida, PowerUpVidaBonus)
	}
	if alice.TripleShot != PowerUpTiroTriploDurationTicks-10 {
		t.Errorf("tripleShot = %d ticks restantes, want %d",
			alice.TripleShot, PowerUpTiroTriploDurationTicks-10)
	}
	if alice.Shield != 1 {
		t.Errorf("shield = %d, want 1", alice.Shield)
	}

	// Efeito expirado some da snapshot: só jogadores com ALGUM efeito ativo
	// aparecem (o client limpa o ícone do HUD quando o jogador some do mapa).
	m.Step(nil) // tick avança; tiro triplo ainda ativo (189 restantes)
	if _, ok := eff["bob"]; ok {
		t.Errorf("bob apareceu na snapshot sem efeitos")
	}
}
