package game

import (
	"math"
	"testing"
)

// worldHP é o provedor de HP dos testes: mapa id→HP com default 100 para IDs
// desconhecidos (jogador vivo). Use hp[id] = 0 para simular morto.
type worldHP struct{ m map[string]int }

func (h *worldHP) get(id string) int {
	if v, ok := h.m[id]; ok {
		return v
	}
	return DefaultMaxHP
}

// newTestWorld monta um mundo controlado sobre o level dado (que o teste já
// configurou com os spawns que quiser). Devolve o mundo e o mapa de HP.
func newTestWorld(l *Level) (*World, *worldHP) {
	hp := &worldHP{m: map[string]int{}}
	return NewWorld(l, hp.get), hp
}

// addPlayer insere um jogador vivo no mundo de teste.
func addPlayer(w *World, hp *worldHP, id string) {
	w.AddPlayer(id)
	hp.m[id] = DefaultMaxHP
}

// countEvents conta eventos do tipo dado.
func countEvents(evs []WorldEvent, typ WorldEventType) int {
	n := 0
	for _, e := range evs {
		if e.Type == typ {
			n++
		}
	}
	return n
}

// enemyLevel: chão contínuo 20x8 (solidLevel) + um andador no tile (5, 6).
func enemyLevel() *Level {
	lvl := solidLevel(-1, -1)
	lvl.EnemySpawns = []Tile{{X: 5, Y: 6}}
	return lvl
}

// coinLevel: chão contínuo + uma moeda no tile (6, 6).
func coinLevel() *Level {
	lvl := solidLevel(-1, -1)
	lvl.CoinSpawns = []Tile{{X: 6, Y: 6}}
	return lvl
}

// ===== Movimento =====

func TestWorldStepMovimentoDirecao(t *testing.T) {
	w, hp := newTestWorld(solidLevel(-1, -1))
	addPlayer(w, hp, "alice")

	// 10 ticks para a direita: 320 px/s * 10 * 0.05s = 160 px.
	for i := 0; i < 10; i++ {
		if evs := w.Step(WorldInputs{"alice": {Right: true}}, FixedDT); len(evs) != 0 {
			t.Fatalf("tick %d: eventos inesperados %+v", i, evs)
		}
	}
	p := w.Players()[0]
	if !almostEqual(float64(p.X), 96.0+160.0) {
		t.Errorf("X após 10 ticks direita = %d, want %.0f", p.X, 96.0+160.0)
	}
	if !p.Grounded {
		t.Error("player deve continuar grounded ao andar no chão")
	}

	// Sem input: para (VX = 0).
	for i := 0; i < 5; i++ {
		w.Step(nil, FixedDT)
	}
	p = w.Players()[0]
	if !almostEqual(float64(p.X), 96.0+160.0) {
		t.Errorf("X parado = %d, want 256 (sem input não anda)", p.X)
	}

	// 10 ticks para a esquerda: volta ao spawn.
	for i := 0; i < 10; i++ {
		w.Step(WorldInputs{"alice": {Left: true}}, FixedDT)
	}
	p = w.Players()[0]
	if !almostEqual(float64(p.X), 96.0) {
		t.Errorf("X após 10 ticks esquerda = %d, want 96", p.X)
	}
}

func TestWorldStepColisaoParede(t *testing.T) {
	w, hp := newTestWorld(wallLevel())
	addPlayer(w, hp, "alice")

	// Parede em x=8: borda esquerda do tile = 384; hitbox 28 px → X máx 356.
	for i := 0; i < 60; i++ {
		w.Step(WorldInputs{"alice": {Right: true}}, FixedDT)
	}
	p := w.Players()[0]
	if p.X != 356 {
		t.Errorf("X = %d, want 356 (encostado na parede)", p.X)
	}
	if !almostEqual(p.VX, 0) {
		t.Errorf("VX = %v, want 0 (parede trava o movimento)", p.VX)
	}
}

func TestWorldStepPulo(t *testing.T) {
	w, hp := newTestWorld(solidLevel(-1, -1))
	addPlayer(w, hp, "alice")

	startX := w.Players()[0].X
	startY := w.Players()[0].Y

	// Pulo: sai do chão (grounded false) e sobe (Y diminui). A gravidade age
	// no MESMO tick: VY = -JumpSpeed + Gravity*dt = -520 + 49 = -471.
	w.Step(WorldInputs{"alice": {Jump: true, Right: true}}, FixedDT)
	p := w.Players()[0]
	if p.Grounded {
		t.Error("após o pulo o player deve estar no ar")
	}
	if p.Y >= startY {
		t.Errorf("Y pós-pulo = %d, want < %d (subiu)", p.Y, startY)
	}
	if p.X <= startX {
		t.Errorf("X pós-pulo = %d, want > %d (segue andando)", p.X, startX)
	}
	wantVY := -PlayerJumpSpeed + PlayerGravity*FixedDT
	if !almostEqual(p.VY, wantVY) {
		t.Errorf("VY pós-pulo = %v, want %v", p.VY, wantVY)
	}

	// Pulo no ar é ignorado (só grounded pula): VY só recebe a gravidade.
	w.Step(WorldInputs{"alice": {Jump: true}}, FixedDT)
	p = w.Players()[0]
	if !almostEqual(p.VY, wantVY+PlayerGravity*FixedDT) {
		t.Errorf("VY pós-pulo no ar = %v, want %v (pulo duplo ignorado)", p.VY, wantVY+PlayerGravity*FixedDT)
	}
}

// ===== Tiro =====

func TestWorldStepTiroCriaProjetil(t *testing.T) {
	w, hp := newTestWorld(solidLevel(-1, -1))
	addPlayer(w, hp, "alice")

	// Tiro para a direita: projétil nasce na frente do player e avança.
	evs := w.Step(WorldInputs{"alice": {Shoot: true}}, FixedDT)
	if n := countEvents(evs, WorldEventShot); n != 1 {
		t.Fatalf("WorldEventShot = %d, want 1 (events=%+v)", n, evs)
	}
	if got := w.Projectiles().Count(); got != 1 {
		t.Fatalf("projéteis = %d, want 1", got)
	}
	// Spawn na frente do player (facing 1): (96+24, 248-10) = (120, 238). No
	// MESMO tick do disparo o projétil já avança 28 px (560 px/s * 0.05 s).
	p0 := w.Projectiles().Snapshot()[0]
	if p0.X != int(math.Round(96+ProjectileSpawnOffsetX))+28 {
		t.Errorf("projétil X = %d, want %d (avançou no tick do disparo)", p0.X, int(math.Round(96+ProjectileSpawnOffsetX))+28)
	}
	before := p0.X
	w.Step(nil, FixedDT)
	after := w.Projectiles().Snapshot()[0].X
	if after != before+28 {
		t.Errorf("projétil avanço = %d -> %d, want +28", before, after)
	}

	// Cooldown: o tick seguinte com Shoot NÃO cria projétil novo.
	w.Step(WorldInputs{"alice": {Left: true, Shoot: true}}, FixedDT)
	if got := w.Projectiles().Count(); got != 1 {
		t.Fatalf("cooldown não respeitado: %d projéteis, want 1", got)
	}

	// Após o cooldown (3 ticks), vira para a esquerda e dispara: o projétil
	// nasce atrás (facing -1) com VX negativo. O player anda para a direita
	// primeiro para o tiro não morrer na borda esquerda do mundo.
	for i := 0; i < 5; i++ {
		w.Step(WorldInputs{"alice": {Right: true}}, FixedDT) // ticks 3-7: 80 → 160
	}
	// tick 8: {Left, Shoot} → player 160→144; tiro da posição 144 → spawn
	// 144-24 = 120, que avança -28 px no mesmo tick → 92.
	w.Step(WorldInputs{"alice": {Left: true, Shoot: true}}, FixedDT)
	snap := w.Projectiles().Snapshot()
	if len(snap) != 2 {
		t.Fatalf("projéteis = %d, want 2 (p1 direita + p2 esquerda)", len(snap))
	}
	left := snap[1] // ordem por ID: p1 (direita) vem antes de p2 (esquerda)
	if left.VX >= 0 {
		t.Errorf("projétil da esquerda VX = %v, want < 0", left.VX)
	}
	if left.X != 92 {
		t.Errorf("projétil da esquerda X = %d, want 92", left.X)
	}
}

func TestWorldStepTiroCooldown(t *testing.T) {
	w, hp := newTestWorld(solidLevel(-1, -1))
	addPlayer(w, hp, "alice")

	// Disparando a cada tick com cooldown de 3 ticks: tiros nos ticks 1 e 4.
	shots := 0
	for i := 0; i < 6; i++ {
		shots += countEvents(w.Step(WorldInputs{"alice": {Shoot: true}}, FixedDT), WorldEventShot)
	}
	if shots != 2 {
		t.Errorf("tiros em 6 ticks = %d, want 2 (cooldown de 3 ticks)", shots)
	}
	if got := w.Projectiles().Count(); got != 2 {
		t.Errorf("projéteis em voo = %d, want 2 (não expiraram — mundo aberto)", got)
	}
}

func TestWorldStepTiroRemoveInimigo(t *testing.T) {
	w, hp := newTestWorld(enemyLevel())
	addPlayer(w, hp, "alice")

	// Andador em (5,6): X 240..270, Y 258..288 (topo 6*48-30 = 258).
	// Tiro manual na banda do inimigo: Fire(x, y=268) → projétil topo 258.
	w.Projectiles().Fire("alice", 0, 268, 1)
	if w.Enemies().Count() != 1 {
		t.Fatalf("inimigos no início = %d, want 1", w.Enemies().Count())
	}

	var destroyed int
	for i := 0; i < 12 && w.Enemies().Count() > 0; i++ {
		destroyed += countEvents(w.Step(nil, FixedDT), WorldEventEnemyDestroyed)
	}
	if destroyed != 1 {
		t.Fatalf("WorldEventEnemyDestroyed = %d, want 1", destroyed)
	}
	if w.Enemies().Count() != 0 {
		t.Errorf("inimigo não foi removido do mundo (Count = %d)", w.Enemies().Count())
	}
	if w.Projectiles().Count() != 0 {
		t.Errorf("projétil não foi removido após acertar (Count = %d)", w.Projectiles().Count())
	}
}

func TestWorldStepProjetilSomeNaParede(t *testing.T) {
	w, hp := newTestWorld(wallLevel())
	addPlayer(w, hp, "alice")

	// Tiro na altura da parede (x=8, y 3..5): projétil some no impacto.
	w.Step(WorldInputs{"alice": {Shoot: true}}, FixedDT) // tick 1: cria
	hits := 0
	for i := 0; i < 15 && w.Projectiles().Count() > 0; i++ {
		hits += countEvents(w.Step(nil, FixedDT), WorldEventProjectileHit)
	}
	if hits != 1 {
		t.Fatalf("WorldEventProjectileHit = %d, want 1", hits)
	}
	if w.Projectiles().Count() != 0 {
		t.Errorf("projétil não foi removido ao bater na parede (Count = %d)", w.Projectiles().Count())
	}
}

// ===== Colisão com inimigo e coleta de moedas =====

func TestWorldStepContatoInimigoDano(t *testing.T) {
	w, hp := newTestWorld(enemyLevel())
	addPlayer(w, hp, "alice")

	// Player anda para a direita e encontra o andador (que também anda).
	var hits []WorldEvent
	for i := 0; i < 15; i++ {
		evs := w.Step(WorldInputs{"alice": {Right: true}}, FixedDT)
		for _, e := range evs {
			if e.Type == WorldEventPlayerHit {
				hits = append(hits, e)
			}
		}
	}
	if len(hits) != 1 {
		t.Fatalf("WorldEventPlayerHit = %d, want 1 (cooldown de contato)", len(hits))
	}
	if hits[0].PlayerID != "alice" || hits[0].Damage != EnemyContactDamage {
		t.Errorf("hit = %+v, want alice com dano %d", hits[0], EnemyContactDamage)
	}
}

func TestWorldStepColetaMoeda(t *testing.T) {
	w, hp := newTestWorld(coinLevel())
	addPlayer(w, hp, "alice")

	// Moeda em (6,6): topo-esquerda (305, 251) 14x14. Player anda por cima.
	collected := 0
	var ev *WorldEvent
	for i := 0; i < 15; i++ {
		evs := w.Step(WorldInputs{"alice": {Right: true}}, FixedDT)
		for j := range evs {
			if evs[j].Type == WorldEventCoinCollected {
				collected++
				ev = &evs[j]
			}
		}
	}
	if collected != 1 {
		t.Fatalf("WorldEventCoinCollected = %d, want 1", collected)
	}
	if ev.PlayerID != "alice" || ev.CoinID == "" {
		t.Errorf("evento de coleta = %+v, want alice com CoinID", *ev)
	}
	if w.Coins().CountCoins() != 0 {
		t.Errorf("moeda não foi removida do mundo (CountCoins = %d)", w.Coins().CountCoins())
	}
	if w.Coins().Count("alice") != 1 {
		t.Errorf("contador da fase de alice = %d, want 1", w.Coins().Count("alice"))
	}
}

// ===== Remoção de entidades e estados especiais =====

func TestWorldStepMortoNaoAgeNemAtira(t *testing.T) {
	w, hp := newTestWorld(solidLevel(-1, -1))
	addPlayer(w, hp, "alice")
	hp.m["alice"] = 0 // morto

	for i := 0; i < 5; i++ {
		if evs := w.Step(WorldInputs{"alice": {Right: true, Shoot: true}}, FixedDT); len(evs) != 0 {
			t.Fatalf("morto gerou eventos %+v", evs)
		}
	}
	p := w.Players()[0]
	if p.X != 96 {
		t.Errorf("morto andou: X = %d, want 96", p.X)
	}
	if w.Projectiles().Count() != 0 {
		t.Errorf("morto atirou: %d projéteis", w.Projectiles().Count())
	}
}

func TestWorldRemovePlayer(t *testing.T) {
	w, hp := newTestWorld(solidLevel(-1, -1))
	addPlayer(w, hp, "alice")
	addPlayer(w, hp, "bob")

	w.RemovePlayer("alice")
	if w.Count() != 1 {
		t.Fatalf("Count = %d, want 1 após remover alice", w.Count())
	}
	players := w.Players()
	if len(players) != 1 || players[0].ID != "bob" {
		t.Fatalf("Players = %+v, want só bob", players)
	}
	// Input para a removida não tem efeito (corpo não existe mais).
	for i := 0; i < 5; i++ {
		w.Step(WorldInputs{"alice": {Right: true}}, FixedDT)
	}
	if got := w.Players()[0].X; got != 96 {
		t.Errorf("bob se moveu por input da alice removida: X = %d, want 96", got)
	}
}

func TestWorldStartLevelResetaFase(t *testing.T) {
	lvl1 := solidLevel(-1, -1)
	w, hp := newTestWorld(lvl1)
	addPlayer(w, hp, "alice")

	// Anda um pouco no mapa 1.
	for i := 0; i < 5; i++ {
		w.Step(WorldInputs{"alice": {Right: true}}, FixedDT)
	}
	if x := w.Players()[0].X; x != 96+80 {
		t.Fatalf("X pré-avanço = %d, want %d", x, 96+80)
	}

	// Mapa 2: parede (sem inimigos/moedas) + inimigo/moeda para verificar reset.
	lvl2 := wallLevel()
	lvl2.EnemySpawns = []Tile{{X: 10, Y: 6}}
	lvl2.CoinSpawns = []Tile{{X: 12, Y: 6}}
	w.StartLevel(lvl2, 2)

	if w.Enemies().Count() != 1 {
		t.Errorf("inimigos pós-StartLevel = %d, want 1 (regenerado)", w.Enemies().Count())
	}
	if w.Coins().CountCoins() != 1 {
		t.Errorf("moedas pós-StartLevel = %d, want 1 (regenerado)", w.Coins().CountCoins())
	}
	p := w.Players()[0]
	if p.X != 96 || p.Y != 288-PlayerHeight {
		t.Errorf("player pós-StartLevel = (%d, %d), want spawn (%d, %d)", p.X, p.Y, 96, 288-int(PlayerHeight))
	}
	if !p.Grounded {
		t.Error("player pós-StartLevel deve nascer grounded")
	}

	// Mapa 2 não tem moeda na trajetória do spawn: andar não coleta nada.
	collected := 0
	for i := 0; i < 5; i++ {
		collected += countEvents(w.Step(WorldInputs{"alice": {Right: true}}, FixedDT), WorldEventCoinCollected)
	}
	if collected != 0 {
		t.Errorf("coletou %d no mapa 2 (moeda está em x=12, longe)", collected)
	}
}

// ===== Determinismo =====

func TestWorldStepDeterministico(t *testing.T) {
	// Fase real do gerador (tem inimigos E moedas) com seed fixa.
	lvl, err := GenerateLevel(LevelSpec{Width: 60, Height: 12, Seed: 42})
	if err != nil {
		t.Fatalf("GenerateLevel: %v", err)
	}

	run := func() ([]WorldEvent, []Player) {
		w, hp := newTestWorld(&lvl)
		addPlayer(w, hp, "alice")
		addPlayer(w, hp, "bob")
		var all []WorldEvent
		for i := 0; i < 30; i++ {
			in := WorldInputs{"alice": {Right: true}, "bob": {Left: true}}
			if i == 10 {
				in["alice"] = Input{Jump: true, Right: true}
			}
			all = append(all, w.Step(in, FixedDT)...)
		}
		return all, w.Players()
	}

	evs1, ps1 := run()
	evs2, ps2 := run()
	if len(evs1) != len(evs2) {
		t.Fatalf("len eventos = %d vs %d — seeds idênticas divergiram", len(evs1), len(evs2))
	}
	for i := range evs1 {
		a, b := evs1[i], evs2[i]
		if a.Type != b.Type || a.PlayerID != b.PlayerID || a.EnemyID != b.EnemyID ||
			a.CoinID != b.CoinID || a.Damage != b.Damage || a.Coins != b.Coins ||
			a.X != b.X || a.Y != b.Y {
			t.Fatalf("evento %d divergiu: %+v vs %+v", i, a, b)
		}
	}
	for i := range ps1 {
		a, b := ps1[i], ps2[i]
		if a.ID != b.ID || a.X != b.X || a.Y != b.Y || a.HP != b.HP ||
			a.Grounded != b.Grounded || a.Facing != b.Facing {
			t.Fatalf("player %d divergiu: %+v vs %+v", i, a, b)
		}
	}
}

// TestWorldStepEventosDoTickConsistentes garante que o Step não emite eventos
// contraditórios: cada coleta remove UMA moeda, cada tiro cria UM projétil, e
// o tick avança o relógio.
func TestWorldStepEventosDoTickConsistentes(t *testing.T) {
	w, hp := newTestWorld(coinLevel())
	addPlayer(w, hp, "alice")
	addPlayer(w, hp, "bob")

	// Os dois andam para a moeda (x=6): quem chega primeiro coleta.
	var collected int
	for i := 0; i < 15; i++ {
		evs := w.Step(WorldInputs{"alice": {Right: true}, "bob": {Right: true}}, FixedDT)
		collected += countEvents(evs, WorldEventCoinCollected)
	}
	if collected != 1 {
		t.Fatalf("coletas = %d, want 1 (moeda única coletada uma vez)", collected)
	}
	if w.TickCount() != 15 {
		t.Errorf("TickCount = %d, want 15", w.TickCount())
	}
}
