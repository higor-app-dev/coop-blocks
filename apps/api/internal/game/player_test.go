package game

import (
	"math"
	"testing"
)

// almostEqual compara floats com tolerância (0.05s de tick não é exato em
// binário; usamos 1e-6 px de folga).
func almostEqual(a, b float64) bool {
	return math.Abs(a-b) < 1e-6
}

// solidLevel monta uma fase 20x8 com chão em y=6 (2 tiles de espessura),
// parede vertical de 3 tiles em x=8 e, opcionalmente, uma plataforma solta
// em (platX, platY). Chão é contínuo (sem lacunas) — cenário controlado.
func solidLevel(platX, platY int) *Level {
	lvl := &Level{Spec: LevelSpec{Width: 20, Height: 8}}
	lvl.GroundY = 6
	lvl.PlayerSpawn = Tile{X: 2, Y: 6}
	lvl.solid = make(map[Tile]bool)
	for x := 0; x < 20; x++ {
		for d := 0; d < 2; d++ {
			lvl.solid[Tile{X: x, Y: 6 + d}] = true
		}
	}
	if platX >= 0 && platY >= 0 {
		lvl.solid[Tile{X: platX, Y: platY}] = true
	}
	return lvl
}

// groundLevel com parede: chão contínuo + parede em x=8 (y 3..5).
func wallLevel() *Level {
	lvl := solidLevel(-1, -1)
	for y := 3; y <= 5; y++ {
		lvl.solid[Tile{X: 8, Y: y}] = true
	}
	return lvl
}

// ledgeLevel: chão sólido apenas nas colunas 0..5; colunas 6+ são vazio
// (borda de plataforma -> queda até o fundo do mundo).
func ledgeLevel() *Level {
	lvl := &Level{Spec: LevelSpec{Width: 20, Height: 8}}
	lvl.GroundY = 6
	lvl.PlayerSpawn = Tile{X: 2, Y: 6}
	lvl.solid = make(map[Tile]bool)
	for x := 0; x <= 5; x++ {
		for d := 0; d < 2; d++ {
			lvl.solid[Tile{X: x, Y: 6 + d}] = true
		}
	}
	return lvl
}

func TestPlayerSpawnsStandingOnGround(t *testing.T) {
	lvl := solidLevel(-1, -1)
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)

	// Spawn: tile (2, 6) -> topo do chão em y = 6*48 = 288; pés = 288.
	wantX, wantY := 96.0, 288.0-PlayerHeight
	if !almostEqual(p.X, wantX) || !almostEqual(p.Y, wantY) {
		t.Fatalf("spawn = (%.2f, %.2f), want (%.2f, %.2f)", p.X, p.Y, wantX, wantY)
	}
	if !p.Grounded {
		t.Fatal("jogador deve nascer no chão (grounded)")
	}
}

func TestPlayerMovesLeftRightOnGround(t *testing.T) {
	lvl := solidLevel(-1, -1)
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)
	startY := p.Y

	// 10 ticks para a direita: 320 px/s * 10 * 0.05s = 160 px.
	for i := 0; i < 10; i++ {
		p.Step(Input{Right: true}, lvl)
	}
	if !almostEqual(p.X, 96.0+160.0) {
		t.Errorf("X após 10 ticks direita = %.2f, want %.2f", p.X, 96.0+160.0)
	}
	if !almostEqual(p.Y, startY) {
		t.Errorf("Y mudou no chão: %.2f -> %.2f", startY, p.Y)
	}
	if !p.Grounded {
		t.Error("player deve continuar grounded ao andar no chão")
	}

	// 10 ticks para a esquerda: volta ao spawn.
	for i := 0; i < 10; i++ {
		p.Step(Input{Left: true}, lvl)
	}
	if !almostEqual(p.X, 96.0) {
		t.Errorf("X após 10 ticks esquerda = %.2f, want 96.00", p.X)
	}
}

func TestPlayerStopsAtWall(t *testing.T) {
	lvl := wallLevel()
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)

	// Parede em x=8 -> borda esquerda do tile = 384. Hitbox 28 px:
	// X max = 384 - 28 = 356.
	for i := 0; i < 60; i++ {
		p.Step(Input{Right: true}, lvl)
	}
	if !almostEqual(p.X, 356.0) {
		t.Errorf("X na parede = %.2f, want 356.00", p.X)
	}
	if p.VX != 0 {
		t.Errorf("VX deve zerar na parede, got %.2f", p.VX)
	}
	// Continua empurrando: não avança.
	for i := 0; i < 10; i++ {
		p.Step(Input{Right: true}, lvl)
	}
	if !almostEqual(p.X, 356.0) {
		t.Errorf("X atravessou parede = %.2f, want 356.00", p.X)
	}
}

func TestPlayerNeverLeavesWorldHorizontally(t *testing.T) {
	lvl := solidLevel(-1, -1)
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)

	maxX := float64(lvl.Spec.Width*TileSize) - PlayerWidth // 960 - 28 = 932
	for i := 0; i < 200; i++ {
		p.Step(Input{Right: true}, lvl)
		if p.X > maxX+1e-6 {
			t.Fatalf("tick %d: X = %.2f saiu do mundo (max %.2f)", i, p.X, maxX)
		}
	}
	if !almostEqual(p.X, maxX) {
		t.Errorf("X na borda direita = %.2f, want %.2f", p.X, maxX)
	}

	// E para a esquerda: nunca fica negativo.
	for i := 0; i < 400; i++ {
		p.Step(Input{Left: true}, lvl)
		if p.X < -1e-6 {
			t.Fatalf("tick %d: X = %.2f saiu pela esquerda", i, p.X)
		}
	}
	if !almostEqual(p.X, 0.0) {
		t.Errorf("X na borda esquerda = %.2f, want 0.00", p.X)
	}
}

func TestPlayerJumpsOnlyWhenGrounded(t *testing.T) {
	lvl := solidLevel(-1, -1)

	// No ar: pulo é ignorado.
	air := NewPlayerBody(0, 0)
	air.SpawnAt(lvl)
	air.Grounded = false
	air.VY = 0
	air.Step(Input{Jump: true}, lvl)
	if air.VY != 0 {
		t.Errorf("pulo no ar deve ser ignorado, VY = %.2f", air.VY)
	}

	// No chão: pulo dá velocidade vertical negativa e tira do chão.
	g := NewPlayerBody(0, 0)
	g.SpawnAt(lvl)
	startY := g.Y
	g.Step(Input{Jump: true}, lvl)
	if g.VY >= 0 {
		t.Errorf("VY após pulo = %.2f, esperado negativo", g.VY)
	}
	if g.Grounded {
		t.Error("após pulo o player não deve estar grounded")
	}
	// O pulo sobe (Y diminui) ao longo do arco.
	rose := false
	for i := 0; i < 8; i++ {
		g.Step(Input{}, lvl)
		if g.Y < startY-1 {
			rose = true
		}
	}
	if !rose {
		t.Error("o pulo deve elevar o jogador (Y < spawn)")
	}
}

func TestPlayerLandsBackOnGround(t *testing.T) {
	lvl := solidLevel(-1, -1)
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)
	startY := p.Y

	p.Step(Input{Jump: true}, lvl)
	for i := 0; i < 60; i++ {
		p.Step(Input{}, lvl)
		if i > 5 && p.Grounded {
			break
		}
	}
	if !p.Grounded {
		t.Fatal("player deve aterrissar de volta no chão")
	}
	if !almostEqual(p.Y, startY) {
		t.Errorf("Y após pouso = %.2f, want %.2f (pés no topo do tile)", p.Y, startY)
	}
	if p.VY != 0 {
		t.Errorf("VY após pouso = %.2f, want 0", p.VY)
	}
}

func TestPlayerFallsWithGravity(t *testing.T) {
	lvl := &Level{Spec: LevelSpec{Width: 20, Height: 8}}
	lvl.solid = make(map[Tile]bool) // mundo vazio: queda livre
	p := NewPlayerBody(50, 10)
	p.Grounded = false
	p.VY = 0

	firstY := p.Y
	p.Step(Input{}, lvl)
	if p.Y <= firstY {
		t.Errorf("gravidade deve aumentar Y, got Y %.2f -> %.2f", firstY, p.Y)
	}
	// Queda livre acelera até o teto MaxFallSpeed.
	for i := 0; i < 200; i++ {
		p.Step(Input{}, lvl)
	}
	if p.VY > PlayerMaxFallSpeed+1e-6 {
		t.Errorf("VY = %.2f excede teto %.2f", p.VY, PlayerMaxFallSpeed)
	}
}

func TestPlayerCannotFallThroughFloor(t *testing.T) {
	lvl := solidLevel(-1, -1)
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)

	// Empurra o player para dentro do chão: a resolução Y deve expulsá-lo
	// para o topo do tile, nunca deixá-lo afundar.
	p.Y = 288.0 - PlayerHeight + 5 // 5 px dentro do chão
	p.VY = 50
	p.Step(Input{}, lvl)
	if !almostEqual(p.Y, 288.0-PlayerHeight) {
		t.Errorf("Y após resolução = %.2f, want %.2f (expulso para o topo)", p.Y, 288.0-PlayerHeight)
	}
	if !p.Grounded {
		t.Error("em cima do chão deve estar grounded")
	}
}

func TestPlayerCannotTunnelThroughThinPlatform(t *testing.T) {
	// Plataforma de 1 tile em (10, 4), flutuando no vazio.
	lvl := &Level{Spec: LevelSpec{Width: 20, Height: 8}}
	lvl.solid = make(map[Tile]bool)
	lvl.solid[Tile{X: 10, Y: 4}] = true

	// Player caindo rápido alinhado à plataforma (hitbox 28 px cruza o tile).
	p := NewPlayerBody(480-14, 0)
	p.Grounded = false
	p.VY = PlayerMaxFallSpeed // velocidade terminal: 45 px/tick < 48 px (sem tunnelling)
	minY := float64(4*TileSize) - PlayerHeight

	// Roda a queda até assentar; a cada tick verifica que os pés nunca
	// ultrapassam o topo do tile da plataforma (y=4*48=192).
	for i := 0; i < 60; i++ {
		p.Step(Input{}, lvl)
		if p.Y+p.Height() > float64(4*TileSize)+1e-6 && p.VY >= 0 {
			t.Fatalf("tick %d: player atravessou a plataforma (Y=%.2f, pés=%.2f)", i, p.Y, p.Y+p.Height())
		}
		if p.Grounded {
			break
		}
	}
	if !almostEqual(p.Y, minY) {
		t.Errorf("Y sobre plataforma = %.2f, want %.2f", p.Y, minY)
	}
	if !p.Grounded {
		t.Error("sobre a plataforma deve estar grounded")
	}
}

func TestPlayerNeverLeavesWorldVertically(t *testing.T) {
	lvl := ledgeLevel()
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)

	// Anda para a direita: sai da borda da plataforma (colunas 6+) e cai.
	for i := 0; i < 60; i++ {
		p.Step(Input{Right: true}, lvl)
	}
	// Cai até o fundo do mundo (height*TileSize - hitbox = 384 - 40 = 344).
	maxY := float64(lvl.Spec.Height*TileSize) - PlayerHeight
	for i := 0; i < 500; i++ {
		p.Step(Input{}, lvl)
		if p.Y > maxY+1e-6 {
			t.Fatalf("tick %d: Y = %.2f saiu do mundo (max %.2f)", i, p.Y, maxY)
		}
	}
	if !almostEqual(p.Y, maxY) {
		t.Errorf("Y no fundo = %.2f, want %.2f", p.Y, maxY)
	}
	if !p.Grounded {
		t.Error("no fundo do mundo deve estar grounded (não cai no vazio)")
	}

	// Pulo no fundo do mundo: teto em y=0 nunca é atravessado.
	p.Step(Input{Jump: true}, lvl)
	for i := 0; i < 200; i++ {
		p.Step(Input{}, lvl)
		if p.Y < -1e-6 {
			t.Fatalf("tick %d: Y = %.2f saiu pelo topo", i, p.Y)
		}
	}
}

func TestPlayerStopsOnHeadBump(t *testing.T) {
	// Plataforma acima do spawn: pulo bate a cabeça e não atravessa.
	lvl := solidLevel(-1, -1)
	for y := 2; y <= 5; y++ {
		lvl.solid[Tile{X: 2, Y: y}] = true
	}
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)

	for i := 0; i < 30; i++ {
		p.Step(Input{Jump: true}, lvl)
		if p.Y < float64(2*TileSize) { // topo do player nunca entra na coluna 2
			t.Fatalf("tick %d: cabeça atravessou o teto (Y=%.2f)", i, p.Y)
		}
	}
}

func TestPlayerDeterministicFixedTimestep(t *testing.T) {
	lvl := wallLevel()
	a := NewPlayerBody(0, 0)
	b := NewPlayerBody(0, 0)
	a.SpawnAt(lvl)
	b.SpawnAt(lvl)

	// Mesma sequência de input, duas instâncias: posição/velocidade idênticas
	// a cada tick (determinismo).
	inputs := []Input{
		{Right: true}, {Right: true}, {Jump: true}, {}, {Right: true},
		{Right: true}, {}, {Left: true}, {Left: true}, {Jump: true},
		{Left: true}, {}, {Right: true}, {Right: true}, {Right: true},
	}
	for i := 0; i < 120; i++ {
		in := inputs[i%len(inputs)]
		a.Step(in, lvl)
		b.Step(in, lvl)
		if !almostEqual(a.X, b.X) || !almostEqual(a.Y, b.Y) ||
			!almostEqual(a.VX, b.VX) || !almostEqual(a.VY, b.VY) || a.Grounded != b.Grounded {
			t.Fatalf("tick %d: instâncias divergiram (a=(%.3f,%.3f,%.3f,%.3f,%v) b=(%.3f,%.3f,%.3f,%.3f,%v))",
				i, a.X, a.Y, a.VX, a.VY, a.Grounded, b.X, b.Y, b.VX, b.VY, b.Grounded)
		}
	}
}

func TestPlayerStateExposesPhysics(t *testing.T) {
	lvl := solidLevel(-1, -1)
	p := NewPlayerBody(0, 0)
	p.SpawnAt(lvl)
	p.Step(Input{Right: true}, lvl)

	st := p.State(100)
	if st.X != int(math.Round(p.X)) || st.Y != int(math.Round(p.Y)) {
		t.Errorf("State X/Y = (%d,%d), want (%d,%d)", st.X, st.Y, int(math.Round(p.X)), int(math.Round(p.Y)))
	}
	if !almostEqual(st.VX, p.VX) || !almostEqual(st.VY, p.VY) {
		t.Errorf("State VX/VY = (%.2f,%.2f), want (%.2f,%.2f)", st.VX, st.VY, p.VX, p.VY)
	}
	if st.Grounded != p.Grounded {
		t.Errorf("State.Grounded = %v, want %v", st.Grounded, p.Grounded)
	}
	if st.Facing != 1 {
		t.Errorf("State.Facing = %d, want 1 (direita)", st.Facing)
	}
	if st.HP != 100 {
		t.Errorf("State.HP = %d, want 100", st.HP)
	}
}

func TestPlayerOutOfBoundsFuzz(t *testing.T) {
	// Fase real (gerada, com lacunas e plataformas) + sequências de input
	// determinísticas: o player NUNCA sai dos limites do mundo.
	lvl, err := GenerateLevel(LevelSpec{Width: 120, Height: 12, Seed: 42})
	if err != nil {
		t.Fatal(err)
	}
	maxX := float64(lvl.Spec.Width*TileSize) - PlayerWidth
	maxY := float64(lvl.Spec.Height*TileSize) - PlayerHeight

	p := NewPlayerBody(0, 0)
	p.SpawnAt(&lvl)
	for i := 0; i < 2000; i++ {
		// Padrão determinístico baseado no tick (sem RNG).
		var in Input
		switch i % 7 {
		case 0, 1:
			in.Right = true
		case 2, 3:
			in.Left = true
		case 4:
			in.Jump = true
		}
		p.Step(in, &lvl)
		if p.X < -1e-6 || p.X > maxX+1e-6 || p.Y < -1e-6 || p.Y > maxY+1e-6 {
			t.Fatalf("tick %d: fora dos limites (X=%.2f Y=%.2f, mundo %.0fx%.0f)", i, p.X, p.Y, maxX, maxY)
		}
	}
}
