package game

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// jogadorDeTeste monta um jogador vivo (HP > 0) na posição dada (top-left do
// hitbox, px). O ID é informativo — a ordem de avaliação do alvo é por ID.
func jogadorDeTeste(id string, x, y int) Player {
	return Player{
		ID: id,
		PlayerState: PlayerState{
			X: x, Y: y, HP: 100,
		},
	}
}

// bossSpawnado monta um sistema com boss spawnado na fase dada (múltipla de
// 5), garantindo o estado de partida dos testes.
func bossSpawnado(t *testing.T, seed uint32, phase int, cfg BossConfig) (*BossSystem, *Level) {
	t.Helper()
	lvl := genLevel(t, 120, 12, 7)
	s := NewBossSystem(seed, cfg)
	s.SetPhase(phase)
	if !s.SpawnForLevel(&lvl) {
		t.Fatalf("SpawnForLevel(fase %d) não criou o boss", phase)
	}
	return s, &lvl
}

// TestBossSpawnaApenasEmFasesMultiplasDe5 garante a régua de aparição: boss
// na 5ª, 10ª, 15ª… fase; NUNCA fora dela (1, 4, 6, 11…). É o gate que o
// client usa para decidir a barra de HP no HUD.
func TestBossSpawnaApenasEmFasesMultiplasDe5(t *testing.T) {
	lvl := genLevel(t, 120, 12, 7)
	for _, phase := range []int{1, 2, 4, 6, 7, 11} {
		s := NewBossSystemDefault(42)
		s.SetPhase(phase)
		if s.SpawnForLevel(&lvl) {
			t.Errorf("fase %d: boss NÃO deveria aparecer (régua %d)", phase, BossPhaseStep)
		}
		if s.Active() {
			t.Errorf("fase %d: Active() = true, want false", phase)
		}
		if got := s.Snapshot(); got != nil {
			t.Errorf("fase %d: Snapshot() = %+v, want nil", phase, got)
		}
	}
	for _, phase := range []int{5, 10, 15, 20} {
		s := NewBossSystemDefault(42)
		s.SetPhase(phase)
		if !s.SpawnForLevel(&lvl) {
			t.Errorf("fase %d: boss deveria aparecer (régua %d)", phase, BossPhaseStep)
		}
	}
}

// TestBossSpawnaNoMeioDoMapaNoChao verifica o posicionamento do spawn: bloco
// gigante centralizado na coluna do meio do mundo, pés na fileira do chão
// (GroundY), HP cheio, estado idle e fase registrada.
func TestBossSpawnaNoMeioDoMapaNoChao(t *testing.T) {
	s, lvl := bossSpawnado(t, 42, 5, BossConfig{})
	st := s.Snapshot()
	if st == nil {
		t.Fatal("Snapshot() = nil, want boss")
	}
	wantX := (lvl.Spec.Width*TileSize)/2 - BossWidth/2
	wantY := lvl.GroundY*TileSize - BossHeight
	if st.X != wantX || st.Y != wantY {
		t.Errorf("spawn = (%d, %d), want (%d, %d) (meio do mapa, chão)", st.X, st.Y, wantX, wantY)
	}
	if st.HP != BossMaxHP || st.MaxHP != BossMaxHP {
		t.Errorf("HP = %d/%d, want %d", st.HP, st.MaxHP, BossMaxHP)
	}
	if st.State != BossIdle.String() {
		t.Errorf("state = %q, want %q", st.State, BossIdle.String())
	}
	if st.Phase != 5 {
		t.Errorf("phase = %d, want 5", st.Phase)
	}
	if st.ID != "boss" {
		t.Errorf("ID = %q, want \"boss\"", st.ID)
	}
}

// TestBossAtaquesSaoPeriodicos garante a periodicidade: o boss fica em idle
// EXATAMENTE AttackIntervalTicks ticks entre ataques e então entra num dos
// dois ataques (investida ou salto) — previsível no relógio do servidor.
func TestBossAtaquesSaoPeriodicos(t *testing.T) {
	s, lvl := bossSpawnado(t, 0, 5, BossConfig{})
	players := []Player{jogadorDeTeste("p1", 96, 480)}

	// Tick 1..AttackIntervalTicks-1: ainda idle.
	for i := 0; i < BossAttackIntervalTicks-1; i++ {
		s.Step(lvl, players)
		if st := s.Snapshot(); st.State != "idle" {
			t.Fatalf("tick %d: state = %q, want idle (intervalo ainda não zerou)", i+1, st.State)
		}
	}
	// Tick AttackIntervalTicks: o ataque dispara.
	s.Step(lvl, players)
	st := s.Snapshot()
	if st.State != "investida" && st.State != "salto" {
		t.Fatalf("tick %d: state = %q, want investida ou salto", BossAttackIntervalTicks, st.State)
	}
}

// TestBossInvestidaMoveEmLinhaReta verifica a INVESTIDA: com a seed 0 o
// primeiro ataque é uma investida (primeiro draw do mulberry32 = 0,2664 <
// 0,5); sem alvo o boss mantém a direção e avança BossDashTicks em linha
// reta (X cresce em passos fixos), depois volta ao idle.
func TestBossInvestidaMoveEmLinhaReta(t *testing.T) {
	s, lvl := bossSpawnado(t, 0, 5, BossConfig{})

	// Chega ao primeiro ataque (90 ticks de idle).
	for i := 0; i < BossAttackIntervalTicks; i++ {
		s.Step(lvl, nil)
	}
	if st := s.Snapshot(); st.State != "investida" {
		t.Fatalf("seed 0: primeiro ataque = %q, want investida", st.State)
	}

	before := s.Snapshot().X
	var lastX int
	for i := 0; i < BossDashTicks; i++ {
		s.Step(lvl, nil)
		lastX = s.Snapshot().X
	}
	delta := lastX - before
	want := int(BossDashSpeed * FixedDT * BossDashTicks) // 23 px/tick * 24
	if delta != want {
		t.Errorf("deslocamento da investida = %d px, want %d (linha reta a %v px/s)", delta, want, BossDashSpeed)
	}
	if st := s.Snapshot(); st.State != "idle" {
		t.Errorf("state após a investida = %q, want idle", st.State)
	}
}

// TestBossInvestidaCausaDanoPorContatoComCooldown verifica o dano de
// contato: um jogador sobreposto à hitbox durante a investida recebe
// BossDashDamage UMA vez (invulnerabilidade pós-contato de
// ContactCooldownTicks — a investida inteira dura menos que o cooldown,
// então é exatamente 1 hit).
func TestBossInvestidaCausaDanoPorContatoComCooldown(t *testing.T) {
	s, lvl := bossSpawnado(t, 0, 5, BossConfig{})
	b := s.Boss()
	// Jogador parado DENTRO da hitbox do boss (centro).
	player := jogadorDeTeste("p1", int(b.X)+int(BossWidth/2)-PlayerWidth/2, int(b.Y)+int(BossHeight/2)-PlayerHeight/2)
	players := []Player{player}

	var hits int
	for i := 0; i < BossAttackIntervalTicks+BossDashTicks; i++ {
		for _, ev := range s.Step(lvl, players) {
			if ev.Type == BossEventPlayerHit {
				hits++
				if ev.PlayerID != "p1" || ev.Damage != BossDashDamage {
					t.Errorf("hit = %+v, want PlayerID=p1 Damage=%d", ev, BossDashDamage)
				}
			}
		}
	}
	if hits != 1 {
		t.Errorf("hits de contato = %d, want 1 (cooldown pós-contato ativo durante a investida)", hits)
	}
}

// TestBossSaltoPulaAterrissaECausaDanoEmArea verifica o SALTO: o boss sobe
// (Y diminui), não causa dano no ar e, ao aterrissar, aplica BossJumpDamage
// UMA vez em todos os jogadores vivos dentro de BossAoeRadius do ponto de
// impacto — e só neles. Usa JumpSpeedH=0 (salto vertical no lugar) para o
// ponto de aterrissagem ser o próprio spawn.
func TestBossSaltoPulaAterrissaECausaDanoEmArea(t *testing.T) {
	cfg := BossConfig{JumpSpeedH: 0} // salto vertical: aterrissa no mesmo lugar
	s, lvl := bossSpawnado(t, 42, 5, cfg)
	b := s.Boss()
	// Dentro do raio: jogador sobreposto ao centro do boss.
	dentro := jogadorDeTeste("dentro", int(b.X)+int(BossWidth/2)-int(PlayerWidth/2), int(b.Y)+int(BossHeight/2)-int(PlayerHeight/2))
	// Fora do raio: jogador a ~300 px do centro (BossAoeRadius = 120).
	fora := jogadorDeTeste("fora", int(b.X)-300, int(b.Y)+int(BossHeight)-int(PlayerHeight))
	players := []Player{dentro, fora}

	// Sobe (fase inicial do salto): Y deve diminuir (boss sai do chão).
	var subiu bool
	var hits int
	maxTicks := BossAttackIntervalTicks + 200
	for i := 0; i < maxTicks; i++ {
		for _, ev := range s.Step(lvl, players) {
			if ev.Type == BossEventPlayerHit {
				hits++
				if ev.PlayerID != "dentro" {
					t.Errorf("hit de área em %q, want apenas \"dentro\"", ev.PlayerID)
				}
			}
		}
		st := s.Snapshot()
		if st == nil {
			t.Fatal("boss sumiu durante o salto")
		}
		if st.State == "salto" && st.Y < int(b.Y) {
			subiu = true
		}
		if st.State == "idle" && i > BossAttackIntervalTicks {
			break // aterrissou e voltou ao idle
		}
	}
	if !subiu {
		t.Error("boss nunca subiu (Y não diminuiu durante o salto)")
	}
	if hits != 1 {
		t.Errorf("hits de área = %d, want 1 (só o jogador dentro do raio, uma vez por aterrissagem)", hits)
	}
}

// TestBossDerrotadoSoltaDropGordoENaoTrava verifica a derrota: HP zerado →
// evento BossEventDefeated com BossCoinDrop moedas na posição final, boss
// removido do mundo (Snapshot nil) e o sistema segue utilizável (Step sem
// boss devolve nil e não panica — o avanço dos players continua).
func TestBossDerrotadoSoltaDropGordoENaoTrava(t *testing.T) {
	s, lvl := bossSpawnado(t, 42, 5, BossConfig{})
	b := s.Boss()
	wantX, wantY := int(b.X), int(b.Y)

	evs := s.ApplyDamage("boss", BossMaxHP)
	if len(evs) != 1 {
		t.Fatalf("ApplyDamage(derrota) = %d eventos, want 1", len(evs))
	}
	ev := evs[0]
	if ev.Type != BossEventDefeated {
		t.Errorf("evento = %v, want BossEventDefeated", ev)
	}
	if ev.Coins != BossCoinDrop {
		t.Errorf("drop de moedas = %d, want %d (drop gordo)", ev.Coins, BossCoinDrop)
	}
	if int(ev.X) != wantX || int(ev.Y) != wantY {
		t.Errorf("posição do drop = (%d, %d), want (%d, %d)", int(ev.X), int(ev.Y), wantX, wantY)
	}
	if s.Active() {
		t.Error("Active() = true após a derrota, want false")
	}
	if st := s.Snapshot(); st != nil {
		t.Errorf("Snapshot() = %+v após a derrota, want nil", st)
	}
	// O sistema continua utilizável: sem boss, Step é no-op (sem panic) e
	// dano a um ID desconhecido é ignorado.
	if evs := s.Step(lvl, nil); len(evs) != 0 {
		t.Errorf("Step pós-derrota = %v, want nil", evs)
	}
	if evs := s.ApplyDamage("boss", 10); len(evs) != 0 {
		t.Errorf("ApplyDamage pós-derrota = %v, want nil", evs)
	}
}

// TestBossApplyDamageParcialNaoMata verifica que dano abaixo do HP total
// apenas reduz a vida (sem evento) e o boss continua no mundo.
func TestBossApplyDamageParcialNaoMata(t *testing.T) {
	s, _ := bossSpawnado(t, 42, 5, BossConfig{})
	if evs := s.ApplyDamage("boss", 25); len(evs) != 0 {
		t.Fatalf("ApplyDamage(25) = %v, want nil (ainda vivo)", evs)
	}
	st := s.Snapshot()
	if st.HP != BossMaxHP-25 {
		t.Errorf("HP = %d, want %d", st.HP, BossMaxHP-25)
	}
	if !s.Active() {
		t.Error("Active() = false após dano parcial, want true")
	}
	// ID errado é no-op.
	if evs := s.ApplyDamage("outro", 999); len(evs) != 0 {
		t.Errorf("ApplyDamage(id errado) = %v, want nil", evs)
	}
}

// TestBossDeterminismoMesmaSeed verifica que dois sistemas com a MESMA seed
// produzem EXATAMENTE a mesma sequência de estados (posição, HP, estado) ao
// longo de vários ataques — a base do comportamento previsível no servidor.
func TestBossDeterminismoMesmaSeed(t *testing.T) {
	players := []Player{jogadorDeTeste("p1", 200, 400), jogadorDeTeste("p2", 3000, 400)}
	run := func(seed uint32) []string {
		s, lvl := bossSpawnado(t, seed, 5, BossConfig{})
		var trace []string
		for i := 0; i < 600; i++ {
			s.Step(lvl, players)
			st := s.Snapshot()
			if st != nil {
				trace = append(trace, fmt.Sprintf("%d:%d:%s", st.X, st.Y, st.State))
			} else {
				trace = append(trace, "-")
			}
		}
		return trace
	}
	a, b := run(42), run(42)
	if len(a) != len(b) {
		t.Fatalf("traces de tamanhos diferentes: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("tick %d: %q vs %q — sequências divergiram (determinismo por seed)", i, a[i], b[i])
		}
	}
}

// TestBossDestrutivelPorTiros verifica a integração projétil → boss: um tiro
// amigável que sobrepõe a hitbox do boss devolve HitBoss (StepWorldBoss) e o
// dano é aplicado pelo ApplyDamage — o boss é destrutível por tiros como os
// inimigos, sem depender do grid.
func TestBossDestrutivelPorTiros(t *testing.T) {
	s, lvl := bossSpawnado(t, 42, 5, BossConfig{})
	b := s.Boss()
	projs := NewProjectileSystemDefault()

	// Tiro amigável disparado DENTRO da hitbox do boss (mesma linha).
	projs.Fire("p1", b.X+b.W/2-ProjectileWidth/2, b.Y+b.H/2-ProjectileHeight/2, 1)
	hits := projs.StepWorldBoss(lvl, nil, nil, b)
	if len(hits) != 1 || hits[0].Kind != HitBoss {
		t.Fatalf("hits = %+v, want 1 HitBoss", hits)
	}
	if hits[0].TargetID != "boss" {
		t.Errorf("TargetID = %q, want \"boss\"", hits[0].TargetID)
	}
	evs := s.ApplyDamage(hits[0].TargetID, hits[0].Damage)
	if len(evs) != 0 {
		t.Fatalf("ApplyDamage(25) = %v, want nil (boss vivo ainda)", evs)
	}
	if st := s.Snapshot(); st.HP != BossMaxHP-ProjectileDamage {
		t.Errorf("HP = %d, want %d após um tiro", st.HP, BossMaxHP-ProjectileDamage)
	}
}

// TestBossResetLimpaESemeiaDeterministico verifica que Reset remove o boss e
// re-semeia o RNG: o mesmo seed depois do Reset reproduz a MESMA sequência de
// estados de um sistema novo — base do determinismo por fase.
func TestBossResetLimpaESemeiaDeterministico(t *testing.T) {
	lvl := genLevel(t, 120, 12, 7)
	s := NewBossSystemDefault(42)
	s.SetPhase(5)
	s.SpawnForLevel(&lvl)
	if !s.Active() {
		t.Fatal("boss não spawnou na fase 5")
	}
	s.Reset(42)
	if s.Active() {
		t.Error("Active() = true após Reset, want false")
	}
	if st := s.Snapshot(); st != nil {
		t.Errorf("Snapshot() = %+v após Reset, want nil", st)
	}
	// Re-spawn com o MESMO seed: primeira escolha de ataque idêntica (seed 42
	// → primeiro draw 0,6011 ≥ 0,5 → salto).
	s.SetPhase(5)
	s.SpawnForLevel(&lvl)
	for i := 0; i < BossAttackIntervalTicks; i++ {
		s.Step(&lvl, nil)
	}
	if st := s.Snapshot(); st.State != "salto" {
		t.Errorf("primeiro ataque pós-Reset = %q, want salto (seed 42 determinística)", st.State)
	}
}

// TestWorldMsgCarregaBoss verifica que o broadcast do mundo inclui o estado
// do boss quando o sistema tem boss (campo "boss") e que a ausência do
// argumento mantém o campo nulo no WIRE (JSON null) — compatível com
// chamadas antigas e com o client que esconde a barra de HP sem boss.
func TestWorldMsgCarregaBoss(t *testing.T) {
	msg := WorldMsg(nil, nil, nil, nil, nil, &BossState{
		ID: "boss", X: 2832, Y: 384, HP: 400, MaxHP: 400, State: "idle", Phase: 5,
	})
	boss, ok := msg["boss"].(*BossState)
	if !ok || boss == nil {
		t.Fatalf("WorldMsg com boss: campo boss = %v (%T), want *BossState", msg["boss"], msg["boss"])
	}
	if boss.HP != 400 || boss.State != "idle" {
		t.Errorf("boss no wire = %+v, want HP=400 state=idle", boss)
	}
	// Sem o argumento variádico (chamada antiga) o campo é nulo no wire.
	msgAntigo := WorldMsg(nil, nil, nil, nil, nil)
	if b, ok := msgAntigo["boss"].(*BossState); ok && b != nil {
		t.Errorf("WorldMsg antiga: campo boss = %+v, want nulo", b)
	}
	// O JSON é o contrato real com o client: "boss": {...} com boss e
	// "boss": null sem boss.
	comBoss, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal com boss: %v", err)
	}
	if !strings.Contains(string(comBoss), `"boss":{"id":"boss"`) {
		t.Errorf("JSON com boss = %s, want campo boss serializado", comBoss)
	}
	semBoss, err := json.Marshal(msgAntigo)
	if err != nil {
		t.Fatalf("marshal sem boss: %v", err)
	}
	if !strings.Contains(string(semBoss), `"boss":null`) {
		t.Errorf("JSON sem boss = %s, want \"boss\":null", semBoss)
	}
}
