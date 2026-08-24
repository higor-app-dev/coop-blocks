package main

// Teste E2E do comportamento do boss (kanban t_da3717c8).
//
// Roda o servidor REAL (newGameServer — a mesma fiação do binário) via
// httptest + WebSocket e atravessa o ciclo de vida completo do boss na régua
// de 5 fases, cobrindo o acceptance:
//
//  1. boss aparece na 5ª fase no MEIO do mapa (2832, 384) com HP 400/400,
//     idle e phase 5 — e NÃO aparece nas fases 1-4 nem na 6 (régua de 5);
//  2. os ataques INVESTIDA e SALTO rodam no loop do servidor (máquina de
//     estados periódica e determinística: para a seed 5 a sequência é
//     salto → salto → investida) e CAUSAM DANO: o jogador posicionado no
//     raio do ataque tem o hit absorvido pelo escudo da loja (broadcast
//     shield_absorbed exatamente durante a janela do ataque) — o valor
//     exato do dano (25 salto / 20 investida) é coberto pelos testes de
//     unidade (boss_test.go);
//  3. o boss NÃO trava o caminho: o jogador atravessa a hitbox do bloco
//     vivo (2600 → 3400) e, após a derrota, chega ao fim do mapa, abre a
//     loja e avança para a fase 6 normalmente;
//  4. a derrota por tiros é emitida: HP do boss cai a cada tiro (dado da
//     barra de HP do client), o broadcast passa a mandar "boss": null
//     (a barra some) e o drop gordo de 20 moedas é emitido na posição do
//     boss (fileira alta — acima das moedas de chão);
//  5. fase 6: sem boss de novo (régua).
//
// O cenário é 100% determinístico (seed fixa por fase: seed = fase). As
// posições de combate (2800 para o raio dos ataques, 2400 para o tiro) e os
// instantes são calculados a partir do comportamento real do servidor
// (enemies/boss/projéteis simulados com o mesmo código), então o teste não
// depende de timing de rede além das janelas largas de broadcast.

import (
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"
)

// ===== Constantes do cenário (fase 5, seed 5, mapa 120×12) =====

const (
	// BossX: coluna central do mundo ((120*48)/2 − 96/2 = 2832).
	bossSpawnX = 2832
	// BossY: pés na fileira do chão (GroundY 10 → 10*48 − 96 = 384).
	bossSpawnY = 384
	// BossHP: vida cheia do boss no spawn.
	bossSpawnHP = 400
	// bossDropTopY: fileira ALTA onde o drop do boss nasce (Y do boss − lift
	// 6 px, ~378) — acima das moedas de chão (~442), o que permite isolar o
	// drop por posição no broadcast.
	bossDropTopY = 410
	// janela X do drop: 20 moedas a 16 px de pitch centradas no ponto da
	// morte (2280 após a investida da seed 5) → [2128, 2432].
	bossDropMinX = 2100
	bossDropMaxX = 2500
	// Posições de combate (determinísticas, calculadas em cima do
	// comportamento real de inimigos/boss da fase 5).
	// 2800 = dentro do raio do salto (vertical, sem movimento horizontal) e
	//       na rota da investida (dash de 552 px em direção ao jogador).
	//       Nenhum inimigo alcança essa posição (atiradores e7/e9 são
	//       abatidos no início; andadores/voadores passam longe nas janelas).
	danoX, danoY = 2800, 440
	// 2400 = à esquerda do ponto de descanso do boss pós-investida (2280),
	//       fora do raio de tudo (atiradores restantes fora de alcance,
	//       voadores em fileira alta, andadores longe).
	tiroX, tiroY = 2400, 430
	// Dodge spot: fileira alta (y=200) — nada alcança (tiros hostis miram a
	// posição no disparo e o jogador sai de perto; voadores ficam ~390-418).
	dodgeX, dodgeY = 2832, 200
)

// ===== helpers de wire do boss =====

type bossWire struct {
	id              string
	x, y            int
	hp, maxHp, phase int
	state           string
}

// parseBoss extrai o campo boss de um broadcast do mundo ("players").
// Devolve (nil, true) quando o campo existe e é null (sem boss na fase).
func parseBoss(m map[string]any) (*bossWire, bool) {
	raw, ok := m["boss"]
	if !ok {
		return nil, false
	}
	if raw == nil {
		return nil, true
	}
	b, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	return &bossWire{
		id:     b["id"].(string),
		x:      int(b["x"].(float64)),
		y:      int(b["y"].(float64)),
		hp:     int(b["hp"].(float64)),
		maxHp:  int(b["maxHp"].(float64)),
		phase:  int(b["phase"].(float64)),
		state:  b["state"].(string),
	}, true
}

// esperaMundo aguarda o próximo broadcast do mundo (type "players") que
// satisfaça o predicado (drenando os demais). Falha com timeout se não
// chegar.
func (c *e2eClient) esperaMundo(pred func(m map[string]any) bool, timeout time.Duration) map[string]any {
	c.t.Helper()
	return c.espera(func(m map[string]any) bool {
		return m["type"] == "players" && pred(m)
	}, timeout)
}

// bossDoMundo aguarda um broadcast do mundo com o campo boss presente (não
// importa se objeto ou null) e devolve o estado parseado.
func (c *e2eClient) bossDoMundo(timeout time.Duration) (*bossWire, bool) {
	c.t.Helper()
	m := c.esperaMundo(func(m map[string]any) bool {
		_, ok := m["boss"]
		return ok
	}, timeout)
	return parseBoss(m)
}

// esperaEstadoBoss aguarda o boss entrar no estado dado (e devolve o
// snapshot daquele broadcast). Falha se o boss sumir antes (não deveria
// acontecer no meio da fase 5).
func (c *e2eClient) esperaEstadoBoss(state string, timeout time.Duration) *bossWire {
	c.t.Helper()
	m := c.esperaMundo(func(m map[string]any) bool {
		b, ok := parseBoss(m)
		return ok && b != nil && b.state == state
	}, timeout)
	b, _ := parseBoss(m)
	return b
}

// esperaBossNull aguarda o broadcast em que o servidor anuncia a ausência do
// boss (derrota ou fase fora da régua) — "boss": null no wire.
func (c *e2eClient) esperaBossNull(timeout time.Duration) map[string]any {
	c.t.Helper()
	return c.esperaMundo(func(m map[string]any) bool {
		b, ok := parseBoss(m)
		return ok && b == nil
	}, timeout)
}

// esperaPosicao aguarda um broadcast com o jogador local na posição dada —
// confirma que o servidor processou o estado ANTES de atirar (a ordem
// estado→tiro importa: o OnShoot lê o facing do estado atual).
func (c *e2eClient) esperaPosicao(x, y int, timeout time.Duration) {
	c.t.Helper()
	c.esperaMundo(func(m map[string]any) bool {
		ps, _ := m["players"].([]any)
		for _, raw := range ps {
			p, _ := raw.(map[string]any)
			if p["id"] == c.id {
				return int(p["x"].(float64)) == x && int(p["y"].(float64)) == y
			}
		}
		return false
	}, timeout)
}

// moedasNaFileiraAlta conta as moedas do broadcast do mundo na fileira do
// drop do boss (Y < bossDropTopY e X na janela do drop) — isola o drop das
// moedas de chão (~442) e de plataforma baixa.
func moedasNaFileiraAlta(c *e2eClient) int {
	c.t.Helper()
	m := c.esperaMundo(func(m map[string]any) bool {
		cs, _ := m["coins"].([]any)
		return len(cs) > 0
	}, 5*time.Second)
	cs, _ := m["coins"].([]any)
	n := 0
	for _, raw := range cs {
		cm, _ := raw.(map[string]any)
		x := int(cm["x"].(float64))
		y := int(cm["y"].(float64))
		if y < bossDropTopY && x >= bossDropMinX && x <= bossDropMaxX {
			n++
		}
	}
	return n
}

// coletaMoedaRemovida posiciona o jogador sobre a moeda (sobreposição AABB) e
// espera o broadcast coins confirmar a REMOÇÃO exata da moeda (campo
// "removed" com o id). Diferente do coletaMoeda do main_test.go, não depende
// do contador da fase — robusto a morte/respawn do jogador durante a coleta
// (a morte zera o contador da fase, o que dessincroniza a contagem local).
func (c *e2eClient) coletaMoedaRemovida(coin wireCoin) {
	c.t.Helper()
	c.estado(coin.X-5, coin.Y-5, 100, 1)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] != "coins" {
				continue
			}
			removed, _ := m["removed"].([]any)
			for _, raw := range removed {
				r, _ := raw.(map[string]any)
				if r["id"] == coin.ID {
					return
				}
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	c.t.Fatalf("timeout coletando moeda %s (%d,%d)", coin.ID, coin.X, coin.Y)
}

// coletaMoedasNaFase coleta até n moedas da fase atual (posiciona o jogador
// sobre cada uma e espera a remoção). Usa as moedas mais à esquerda (nunca
// disparam o fim do mapa). Devolve quantas coletou.
func coletaMoedasNaFase(c *e2eClient, n int) int {
	c.t.Helper()
	c.drena()
	coins := c.moedasDoMundo()
	sort.Slice(coins, func(i, j int) bool { return coins[i].X < coins[j].X })
	coletadas := 0
	for _, coin := range coins {
		if coletadas >= n {
			break
		}
		if coin.X >= e2eCoinSafeMaxX {
			continue
		}
		c.coletaMoedaRemovida(coin)
		coletadas++
	}
	return coletadas
}

// terminaFase teleporta o jogador para o fim do mapa, espera a loja abrir,
// confirma pronto e espera a próxima fase começar. Devolve o número da fase
// seguinte.
func terminaFase(c *e2eClient, proxima int) {
	c.t.Helper()
	c.estado(e2eFinishX, 440, 100, 1)
	c.esperaFase(func(f faseWire) bool { return f.fase == "shop" }, 5*time.Second)
	c.pronto()
	c.esperaFase(func(f faseWire) bool { return f.fase == "playing" && f.numero == proxima }, 5*time.Second)
}

// ===== o teste =====

func TestBossCicloVidaE2E(t *testing.T) {
	srv := httptest.NewServer(newGameServer())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"

	c := dialE2E(t, wsURL)
	defer c.conn.Close()
	c.esperaWelcome(3 * time.Second)
	c.esperaFase(func(f faseWire) bool { return f.fase == "playing" }, 3*time.Second)

	// =====================================================================
	// 1) FASES 1-4: SEM boss (régua de 5) + coleta para o escudo da loja.
	// =====================================================================
	for fase := 1; fase <= 4; fase++ {
		// O mundo desta fase NÃO tem boss (campo null/ausente no broadcast).
		m := c.esperaMundo(func(m map[string]any) bool {
			_, ok := m["boss"]
			return ok
		}, 5*time.Second)
		if b, ok := parseBoss(m); ok && b != nil {
			t.Fatalf("fase %d: boss presente (%+v), want sem boss (régua %d)", fase, b, 5)
		}

		// Coleta (fases 1-2: orçamento dos 2 escudos = 60 moedas; 30 × 2
		// fases cobre com folga — a carteira da run persiste entre fases).
		if fase <= 2 {
			if got := coletaMoedasNaFase(c, 30); got < 30 {
				t.Fatalf("fase %d: coletei apenas %d moedas, want >= 30", fase, got)
			}
		}

		if fase == 4 {
			// Fase 4: abre a loja (fim do mapa), compra os 2 escudos ANTES
			// de confirmar pronto e avançar para a fase 5.
			c.estado(e2eFinishX, 440, 100, 1)
			c.esperaFase(func(f faseWire) bool { return f.fase == "shop" }, 5*time.Second)
			rc1 := c.compra("shield", 3*time.Second)
			if !rc1.ok {
				t.Fatalf("compra escudo 1 = ok:%v erro:%q (saldo insuficiente?)", rc1.ok, rc1.erro)
			}
			rc2 := c.compra("shield", 3*time.Second)
			if !rc2.ok {
				t.Fatalf("compra escudo 2 = ok:%v erro:%q", rc2.ok, rc2.erro)
			}
			if rc2.stats["shield"] != float64(2) {
				t.Fatalf("stats pós-2 escudos = %v, want shield 2", rc2.stats)
			}
			c.pronto()
			c.esperaFase(func(f faseWire) bool { return f.fase == "playing" && f.numero == fase+1 }, 5*time.Second)
			continue
		}

		terminaFase(c, fase+1)
	}

	// =====================================================================
	// 2) FASE 5: boss no MEIO do mapa, HP cheio, idle, phase 5.
	// =====================================================================
	b, ok := c.bossDoMundo(5 * time.Second)
	if !ok || b == nil {
		t.Fatal("fase 5: broadcast sem boss — deveria ter spawnado (régua 5)")
	}
	if b.id != "boss" || b.x != bossSpawnX || b.y != bossSpawnY {
		t.Errorf("boss spawn = (%s @%d,%d), want (boss @%d,%d — meio do mapa, chão)",
			b.id, b.x, b.y, bossSpawnX, bossSpawnY)
	}
	if b.hp != bossSpawnHP || b.maxHp != bossSpawnHP {
		t.Errorf("boss HP = %d/%d, want %d/%d", b.hp, b.maxHp, bossSpawnHP, bossSpawnHP)
	}
	if b.state != "idle" || b.phase != 5 {
		t.Errorf("boss estado/fase = %q/%d, want idle/5", b.state, b.phase)
	}

	// =====================================================================
	// 3) CAMPO LIMPO + boss NÃO trava o caminho.
	// Os dois atiradores em alcance da zona de combate (e7 @2688, e9 @3696)
	// são abatidos; o jogador atravessa a hitbox do boss VIVO (2600 → 3400)
	// e o boss continua lá (colisão permissiva — o bloco não é terreno).
	// O tiro nasce no Y do jogador − 10 px (SpawnOffsetY): de y=450 o
	// projétil (440..445) sobrepõe a hitbox do atirador (444..480).
	// O jogador SAI na hora do ponto de abate (sem linger): o contra-tiro de
	// e7 (disparado ~tick 7, chega ~tick 16) é mirado na posição antiga e
	// erra — nenhum escudo é gasto com inimigos.
	// =====================================================================
	c.estado(2600, 450, 100, 1)
	c.esperaPosicao(2600, 450, 5*time.Second)
	c.atira()
	time.Sleep(180 * time.Millisecond)
	c.atira() // e7 (atirador @2688) morto — o boss (2832) fica intocado
	c.estado(3400, 450, 100, 1) // atravessa o boss vivo (2832..2928)
	c.esperaPosicao(3400, 450, 5*time.Second)
	c.atira()
	time.Sleep(180 * time.Millisecond)
	c.atira() // e9 (atirador @3696) morto

	// O boss continua vivo e com HP cheio após a travessia e os abates.
	b, ok = c.bossDoMundo(5 * time.Second)
	if !ok || b == nil || b.hp != bossSpawnHP {
		t.Fatalf("após a travessia: boss = %+v (presente=%v), want vivo com HP %d",
			b, ok, bossSpawnHP)
	}

	// =====================================================================
	// 4) MÁQUINA DE ESTADOS: ataques periódicos no loop do servidor.
	// Para a seed 5 a sequência é determinística: salto → salto → investida,
	// cada um separado por idle (intervalo BossAttackIntervalTicks).
	// =====================================================================
	c.estado(dodgeX, dodgeY, 100, 1) // observação de cima (nada alcança)

	salto1 := c.esperaEstadoBoss("salto", 15*time.Second)
	if salto1.phase != 5 {
		t.Errorf("salto1 phase = %d, want 5", salto1.phase)
	}

	// =====================================================================
	// 5) DANO DO SALTO: jogador no raio → hit absorvido pelo escudo 1.
	// O salto é vertical (JumpSpeedH=0 em produção): aterrissa no MESMO X e
	// aplica o dano em área (raio 120 px dos pés). O jogador em (2800, 440)
	// está dentro do raio do ponto de impacto (2880, 480).
	// =====================================================================
	c.estado(danoX, danoY, 100, 1)
	sh1 := c.esperaTipo("shield_absorbed", 5*time.Second)
	if sh1["id"] != c.id {
		t.Fatalf("shield_absorbed do salto para %v, want %s", sh1["id"], c.id)
	}
	c.estado(dodgeX, dodgeY, 100, 1) // volta ao posto de observação

	// =====================================================================
	// 6) SALTO 2 + INVESTIDA: espera o ciclo completar e prepara o raio.
	// =====================================================================
	c.esperaEstadoBoss("idle", 15*time.Second) // fim do salto 1
	salto2 := c.esperaEstadoBoss("salto", 15*time.Second)
	if salto2.x != bossSpawnX {
		t.Errorf("salto2 x = %d, want %d (salto vertical no lugar)", salto2.x, bossSpawnX)
	}
	c.esperaEstadoBoss("idle", 15*time.Second) // fim do salto 2
	// Pequena espera: o andador e5 passa por (2800, 440) ~tick 230; o
	// jogador entra no raio depois disso, antes da investida (~tick 320).
	time.Sleep(600 * time.Millisecond)
	c.estado(danoX, danoY, 100, 1)
	c.esperaPosicao(danoX, danoY, 5*time.Second)

	// DANO DA INVESTIDA: o boss avança em linha reta na direção do jogador
	// (552 px de dash) e o contato é absorvido pelo escudo 2. O
	// shield_absorbed chega no MESMO tick do contato — ANTES do broadcast do
	// mundo com o estado "investida" — então esperar o estado primeiro
	// drenaria e perderia a mensagem. A investida em si é confirmada abaixo
	// pelo ponto de descanso pós-dash (x=2280).
	t.Logf("aguardando shield_absorbed da investida (jogador em %d,%d)", danoX, danoY)
	sh2 := c.esperaTipo("shield_absorbed", 15*time.Second)
	if sh2["id"] != c.id {
		t.Fatalf("shield_absorbed da investida para %v, want %s", sh2["id"], c.id)
	}

	// =====================================================================
	// 7) DERROTA POR TIROS: HP cai a cada tiro (dado da barra), o broadcast
	// manda boss null (barra some) e o drop gordo de 20 moedas é emitido.
	// =====================================================================
	// A investida termina com o boss em x=2280 (dash de 552 px para a
	// esquerda); ele fica idle ~4,5 s — o jogador atira de (2400, 430)
	// virado para a esquerda dentro dessa janela (todos os tiros acertam).
	fimInv := c.esperaEstadoBoss("idle", 15*time.Second)
	if fimInv.x != bossSpawnX-552 {
		t.Fatalf("boss pós-investida = x %d, want %d (dash de 552 px p/ esquerda)",
			fimInv.x, bossSpawnX-552)
	}

	// Drop de inimigos abatidos durante a limpeza também nasce na fileira
	// alta? Não — andadores/atiradores morrem no chão (Y≈444 → drop ~438,
	// fora da janela). Pode haver UMA moeda de plataforma da fase na janela
	// (o jogador em 2400/430 não a toca) — o que importa é o DELTA: a
	// derrota adiciona exatamente 20 moedas na fileira do drop.
	dropsAntes := moedasNaFileiraAlta(c)

	c.estado(tiroX, tiroY, 100, -1)
	c.esperaPosicao(tiroX, tiroY, 5*time.Second)

	for i := 0; i < 26; i++ {
		c.atira()
		time.Sleep(160 * time.Millisecond)
	}

	// Aguarda a derrota: boss null no broadcast (a barra do HUD some). O
	// predicado também rastreia o HP mínimo visto na luta (o dado que a
	// barra do client consome).
	minHp := bossSpawnHP
	c.esperaMundo(func(m map[string]any) bool {
		if b, ok := parseBoss(m); ok && b != nil {
			if b.hp < minHp {
				minHp = b.hp
			}
			return false
		}
		return true // "boss": null = derrota
	}, 10*time.Second)
	if minHp == bossSpawnHP {
		t.Fatal("HP do boss nunca diminuiu durante a luta (barra não atualizou)")
	}
	t.Logf("HP mínimo do boss observado na luta: %d", minHp)

	// Drop gordo: 20 moedas na fileira alta na janela do ponto da morte.
	time.Sleep(300 * time.Millisecond) // deixa o broadcast do drop chegar
	c.estado(3400, dodgeY, 100, 1)      // afasta do drop (não coleta nada)
	c.esperaPosicao(3400, dodgeY, 5*time.Second)
	dropsDepois := moedasNaFileiraAlta(c)
	if dropsDepois-dropsAntes != 20 {
		t.Errorf("drop do boss = %d moedas na fileira alta (antes %d), want +20",
			dropsDepois, dropsAntes)
	}

	// =====================================================================
	// 8) O AVANÇO CONTINUA APÓS A DERROTA: fim do mapa → loja → fase 6.
	// =====================================================================
	terminaFase(c, 6)

	// Fase 6: sem boss de novo (régua).
	m6 := c.esperaMundo(func(m map[string]any) bool {
		_, ok := m["boss"]
		return ok
	}, 5*time.Second)
	if b6, ok := parseBoss(m6); ok && b6 != nil {
		t.Fatalf("fase 6: boss presente (%+v), want sem boss (régua %d)", b6, 5)
	}
}
