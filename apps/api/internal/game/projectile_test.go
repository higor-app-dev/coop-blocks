package game

import (
	"math"
	"testing"
)

// testLevel monta um Level determinístico com os tiles sólidos dados (não
// passa pelo gerador procedural — ideal para colisões com posições exatas).
func testLevel(w, h int, solids ...Tile) *Level {
	solid := make(map[Tile]bool)
	for _, t := range solids {
		solid[t] = true
	}
	return &Level{
		Spec:    LevelSpec{Width: w, Height: h},
		GroundY: h - 2,
		solid:   solid,
	}
}

// quaseIgual compara floats com tolerância (FixedDT não é exatamente 0.05).
func quaseIgual(a, b float64) bool {
	return math.Abs(a-b) < 1e-6
}

func TestProjectileConfigDefaults(t *testing.T) {
	s := NewProjectileSystemDefault()
	if s.cfg.Speed != ProjectileSpeed {
		t.Errorf("Speed = %v, want %v", s.cfg.Speed, ProjectileSpeed)
	}
	if s.cfg.Width != ProjectileWidth || s.cfg.Height != ProjectileHeight {
		t.Errorf("hitbox = %vx%v, want %vx%v", s.cfg.Width, s.cfg.Height, ProjectileWidth, ProjectileHeight)
	}
	if s.cfg.Lifetime != ProjectileLifetime {
		t.Errorf("Lifetime = %v, want %v", s.cfg.Lifetime, ProjectileLifetime)
	}
	if s.cfg.Damage != ProjectileDamage {
		t.Errorf("Damage = %d, want %d", s.cfg.Damage, ProjectileDamage)
	}
	if s.cfg.SpawnOffsetX != ProjectileSpawnOffsetX || s.cfg.SpawnOffsetY != ProjectileSpawnOffsetY {
		t.Errorf("spawn offset = (%v,%v), want (%v,%v)", s.cfg.SpawnOffsetX, s.cfg.SpawnOffsetY, ProjectileSpawnOffsetX, ProjectileSpawnOffsetY)
	}
	if s.Count() != 0 {
		t.Errorf("Count = %d, want 0", s.Count())
	}
}

func TestProjectileFireCriaProjetilNaDirecao(t *testing.T) {
	s := NewProjectileSystemDefault()

	// facing direita: spawn em (x+24, y-10), velocidade +560
	p := s.Fire("alice", 96, 248, 1)
	if p.ID != "p1" {
		t.Errorf("ID = %q, want p1", p.ID)
	}
	if p.OwnerID != "alice" {
		t.Errorf("OwnerID = %q, want alice", p.OwnerID)
	}
	if !quaseIgual(p.X, 120) || !quaseIgual(p.Y, 238) {
		t.Errorf("spawn = (%v,%v), want (120,238)", p.X, p.Y)
	}
	if !quaseIgual(p.VX, ProjectileSpeed) || p.VY != 0 {
		t.Errorf("velocidade = (%v,%v), want (%v,0)", p.VX, p.VY, ProjectileSpeed)
	}
	if !quaseIgual(p.Life, ProjectileLifetime) {
		t.Errorf("Life = %v, want %v", p.Life, ProjectileLifetime)
	}
	if p.Damage != ProjectileDamage {
		t.Errorf("Damage = %d, want %d", p.Damage, ProjectileDamage)
	}
	if p.W != ProjectileWidth || p.H != ProjectileHeight {
		t.Errorf("hitbox = %vx%v, want %vx%v", p.W, p.H, ProjectileWidth, ProjectileHeight)
	}
	if s.Count() != 1 {
		t.Errorf("Count = %d, want 1", s.Count())
	}

	// facing esquerda: spawn em (x-24, y-10), velocidade -560
	p2 := s.Fire("bob", 96, 248, -1)
	if !quaseIgual(p2.X, 72) || !quaseIgual(p2.Y, 238) {
		t.Errorf("spawn esquerda = (%v,%v), want (72,238)", p2.X, p2.Y)
	}
	if !quaseIgual(p2.VX, -ProjectileSpeed) {
		t.Errorf("velocidade esquerda = %v, want %v", p2.VX, -ProjectileSpeed)
	}

	// facing 0 é normalizado para direita (nunca trava parado)
	p3 := s.Fire("carol", 96, 248, 0)
	if !quaseIgual(p3.VX, ProjectileSpeed) {
		t.Errorf("facing 0: VX = %v, want %v (normalizado para direita)", p3.VX, ProjectileSpeed)
	}

	if s.Count() != 3 {
		t.Errorf("Count = %d, want 3", s.Count())
	}
}

func TestProjectileMovesEachTick(t *testing.T) {
	l := testLevel(20, 8) // sem tiles sólidos no caminho
	s := NewProjectileSystemDefault()
	s.Fire("alice", 96, 248, 1) // spawn (120, 238), VX 560 → 28 px/tick

	hits := s.Step(l, nil)
	if len(hits) != 0 {
		t.Fatalf("hits = %+v, want nenhum em campo aberto", hits)
	}
	p := s.Snapshot()
	if len(p) != 1 {
		t.Fatalf("snapshot len = %d, want 1", len(p))
	}
	if p[0].X != 148 || p[0].Y != 238 {
		t.Errorf("após 1 tick: pos = (%d,%d), want (148,238)", p[0].X, p[0].Y)
	}
	if p[0].VX != ProjectileSpeed || p[0].OwnerID != "alice" || p[0].ID != "p1" {
		t.Errorf("snapshot = %+v", p[0])
	}

	// mais 2 ticks → 204
	s.Step(l, nil)
	s.Step(l, nil)
	p = s.Snapshot()
	if len(p) != 1 || p[0].X != 204 {
		t.Errorf("após 3 ticks: pos = %+v, want x=204", p)
	}
}

func TestProjectileSomeNaParede(t *testing.T) {
	// parede vertical na coluna 10 (x 480..528), fileiras 0..7
	l := testLevel(20, 8)
	for row := 0; row < 8; row++ {
		l.solid[Tile{X: 10, Y: row}] = true
	}
	s := NewProjectileSystemDefault()
	s.Fire("alice", 0, 100, 1) // spawn (24, 90), fileira 1

	// ~16 ticks até a parede; no 17º o projétil entra no tile e colide
	var hits []ProjectileHit
	for i := 0; i < 20 && s.Count() > 0; i++ {
		hits = append(hits, s.Step(l, nil)...)
	}

	if s.Count() != 0 {
		t.Fatalf("projétil não foi removido após colidir (Count = %d)", s.Count())
	}
	if len(hits) != 1 {
		t.Fatalf("hits = %+v, want exatamente 1", hits)
	}
	h := hits[0]
	if h.Kind != HitWall {
		t.Errorf("Kind = %v, want HitWall", h.Kind)
	}
	if h.OwnerID != "alice" || h.ProjectileID != "p1" {
		t.Errorf("hit = %+v, want owner alice / projectile p1", h)
	}
	// encosta na face esquerda da parede: x = 480 - 12 = 468
	if !quaseIgual(h.X, 468) {
		t.Errorf("impacto X = %v, want 468", h.X)
	}
}

func TestProjectileSomeNoChao(t *testing.T) {
	// chão contínuo na fileira 6 (y 288..336)
	l := testLevel(20, 8)
	for x := 0; x < 20; x++ {
		l.solid[Tile{X: x, Y: 6}] = true
	}
	s := NewProjectileSystemDefault()
	p := s.Fire("alice", 0, 248, 1) // spawn (24, 238), fileira 5
	p.VY = 500                      // componente vertical (teste de impacto no chão)

	var hits []ProjectileHit
	for i := 0; i < 5 && s.Count() > 0; i++ {
		hits = append(hits, s.Step(l, nil)...)
	}

	if s.Count() != 0 {
		t.Fatalf("projétil não foi removido após tocar o chão (Count = %d)", s.Count())
	}
	if len(hits) != 1 {
		t.Fatalf("hits = %+v, want exatamente 1", hits)
	}
	h := hits[0]
	if h.Kind != HitFloor {
		t.Errorf("Kind = %v, want HitFloor", h.Kind)
	}
	// assenta em cima do chão: y = 288 - 5 = 283
	if !quaseIgual(h.Y, 283) {
		t.Errorf("impacto Y = %v, want 283", h.Y)
	}
}

func TestProjectileAcertaInimigo(t *testing.T) {
	l := testLevel(20, 8) // campo aberto
	s := NewProjectileSystemDefault()
	s.Fire("alice", 0, 248, 1) // spawn (24, 238)

	enemies := []Enemy{{ID: "e1", X: 300, Y: 230, W: 50, H: 50}}

	var hits []ProjectileHit
	for i := 0; i < 15 && s.Count() > 0; i++ {
		hits = append(hits, s.Step(l, enemies)...)
	}

	if s.Count() != 0 {
		t.Fatalf("projétil não foi removido após acertar o inimigo (Count = %d)", s.Count())
	}
	if len(hits) != 1 {
		t.Fatalf("hits = %+v, want exatamente 1", hits)
	}
	h := hits[0]
	if h.Kind != HitEnemy {
		t.Errorf("Kind = %v, want HitEnemy", h.Kind)
	}
	if h.TargetID != "e1" {
		t.Errorf("TargetID = %q, want e1", h.TargetID)
	}
	if h.OwnerID != "alice" || h.Damage != ProjectileDamage {
		t.Errorf("hit = %+v, want owner alice com damage %d", h, ProjectileDamage)
	}
}

func TestProjectileExpiraPorLifetime(t *testing.T) {
	l := testLevel(20, 8)
	s := NewProjectileSystem(ProjectileConfig{Lifetime: 0.1}) // 2 ticks de vida
	s.Fire("alice", 0, 100, 1)

	// tick 1: ainda vivo (Life 0.05)
	if hits := s.Step(l, nil); len(hits) != 0 {
		t.Fatalf("tick 1: hits = %+v, want nenhum", hits)
	}
	if s.Count() != 1 {
		t.Fatalf("tick 1: Count = %d, want 1 (vivo)", s.Count())
	}

	// tick 2: expira — some SEM hit (expiração não é colisão)
	if hits := s.Step(l, nil); len(hits) != 0 {
		t.Fatalf("tick 2: hits = %+v, want nenhum (expiração é silenciosa)", hits)
	}
	if s.Count() != 0 {
		t.Errorf("Count = %d, want 0 (expirou)", s.Count())
	}
}

func TestProjectileSomeNosLimitesDoMundo(t *testing.T) {
	l := testLevel(20, 8) // mundo 960 x 384 px

	// tiro para a esquerda saindo do mundo
	s := NewProjectileSystemDefault()
	s.Fire("alice", 0, 100, -1) // spawn (-24, 90) — já fora; 1 tick confirma
	hits := s.Step(l, nil)
	if len(hits) != 1 || hits[0].Kind != HitBounds {
		t.Fatalf("esquerda: hits = %+v, want [HitBounds]", hits)
	}
	if s.Count() != 0 {
		t.Errorf("esquerda: Count = %d, want 0", s.Count())
	}

	// tiro para a direita além da borda (x+w > 960)
	s2 := NewProjectileSystemDefault()
	s2.Fire("bob", 1000, 100, 1) // spawn (1024, 90)
	hits = s2.Step(l, nil)
	if len(hits) != 1 || hits[0].Kind != HitBounds {
		t.Fatalf("direita: hits = %+v, want [HitBounds]", hits)
	}
	if s2.Count() != 0 {
		t.Errorf("direita: Count = %d, want 0", s2.Count())
	}
}

func TestProjectileOnHitHook(t *testing.T) {
	l := testLevel(20, 8)
	for row := 0; row < 8; row++ {
		l.solid[Tile{X: 10, Y: row}] = true
	}
	s := NewProjectileSystemDefault()

	var got []ProjectileHit
	s.OnHit(func(h ProjectileHit) { got = append(got, h) })
	s.Fire("alice", 0, 100, 1)

	for i := 0; i < 20 && s.Count() > 0; i++ {
		s.Step(l, nil)
	}
	if len(got) != 1 || got[0].Kind != HitWall || got[0].OwnerID != "alice" {
		t.Fatalf("hook = %+v, want [wall alice]", got)
	}

	// sem hook registrado: Update continua retornando os hits diretamente
	s2 := NewProjectileSystemDefault()
	s2.Fire("bob", 0, 100, 1)
	var direct []ProjectileHit
	for i := 0; i < 20 && s2.Count() > 0; i++ {
		direct = append(direct, s2.Step(l, nil)...)
	}
	if len(direct) != 1 || direct[0].Kind != HitWall {
		t.Fatalf("hits diretos = %+v, want [wall]", direct)
	}
}

func TestProjectileSnapshotOrdenado(t *testing.T) {
	s := NewProjectileSystemDefault()
	s.Fire("carol", 100, 200, 1)
	s.Fire("alice", 300, 200, -1)
	s.Fire("bob", 500, 200, 1)

	snap := s.Snapshot()
	if len(snap) != 3 {
		t.Fatalf("snapshot len = %d, want 3", len(snap))
	}
	// ordem estável por ID (p1, p2, p3) — independente da ordem de criação
	for i, want := range []string{"p1", "p2", "p3"} {
		if snap[i].ID != want {
			t.Errorf("snapshot[%d].ID = %q, want %q (ordem estável)", i, snap[i].ID, want)
		}
	}
	// campos serializados: X/Y arredondados, velocidade e dono preservados
	if snap[0].OwnerID != "carol" || snap[0].X != 124 || snap[0].Y != 190 || snap[0].VX != ProjectileSpeed {
		t.Errorf("snapshot[0] = %+v, want carol em (124,190) vx=%v", snap[0], ProjectileSpeed)
	}
	if snap[1].OwnerID != "alice" || snap[1].X != 276 || snap[1].VX != -ProjectileSpeed {
		t.Errorf("snapshot[1] = %+v, want alice em 276 vx=%v", snap[1], -ProjectileSpeed)
	}
}

func TestProjectileClear(t *testing.T) {
	s := NewProjectileSystemDefault()
	s.Fire("alice", 0, 100, 1)
	s.Fire("bob", 0, 100, -1)
	if s.Count() != 2 {
		t.Fatalf("Count = %d, want 2", s.Count())
	}
	s.Clear()
	if s.Count() != 0 {
		t.Errorf("Count após Clear = %d, want 0", s.Count())
	}
	// sistema segue utilizável após Clear (reinício de fase)
	s.Fire("carol", 0, 100, 1)
	if s.Count() != 1 {
		t.Errorf("Count após refire = %d, want 1", s.Count())
	}
}

func TestProjectileNaoAtravessaParedeFina(t *testing.T) {
	// parede de 1 tile (48 px) — passo de 28 px/tick não pode atravessá-la
	l := testLevel(20, 8)
	for row := 0; row < 8; row++ {
		l.solid[Tile{X: 10, Y: row}] = true
	}
	s := NewProjectileSystemDefault()
	s.Fire("alice", 0, 100, 1) // spawn (24, 90)

	for i := 0; i < 20 && s.Count() > 0; i++ {
		s.Step(l, nil)
	}
	if s.Count() != 0 {
		t.Fatalf("projétil atravessou a parede (Count = %d)", s.Count())
	}
	// o projétil nunca ultrapassa a face esquerda da parede (x >= 468)
	snap := s.Snapshot()
	if len(snap) != 0 {
		t.Errorf("snapshot = %+v, want vazio", snap)
	}
}
