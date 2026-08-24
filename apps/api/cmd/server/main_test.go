package main

// Teste E2E do fluxo completo da loja (kanban t_9c484e34).
//
// Roda o servidor REAL (newGameServer — a mesma fiação do binário, extraída
// de main() justamente para isto) via httptest e conecta DOIS jogadores
// simulados (alice e bob) com WebSocket de verdade, atravessando o caminho
// inteiro da loja entre fases:
//
//  1. join → contexto de fase (playing/1) com estado individual por jogador;
//  2. loja FECHADA durante o mapa: shop_buy fora da fase de loja é rejeitado
//     (a tela de loja só existe entre fases — gate do servidor);
//  3. coleta de moedas → carteira INDIVIDUAL por jogador (o loop do servidor
//     credita o saldo da run a cada moeda coletada — bug de integração
//     corrigido neste mesmo commit);
//  4. fim do mapa → loja abre (broadcast phase=shop, ready todos false);
//  5. compra na loja: debita SÓ o comprador e a resposta é individual — o
//     saldo do outro jogador não muda e ele não recebe o comprovante;
//  6. pronto coletivo: a fase NÃO avança até todos confirmarem, e o broadcast
//     do avanço carrega upgrades + saldos atualizados por jogador;
//  7. efeitos aplicados na fase seguinte: escudo absorve um hit (broadcast
//     shield_absorbed, carga consumida), cadência de tiro sobe (dois tiros
//     dentro do intervalo base geram dois projéteis) e o teto de HP sobe
//     (stats.maxHp e HP real do jogador no mundo).

import (
	"encoding/json"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Fim de fase: lvl.Finished(X) = X+PlayerWidth >= (Width-1)*TileSize →
// X >= 5684 abre a loja (120 colunas × 48 px, hitbox 28 px).
const (
	e2eFinishX      = 5684 // X mínimo que dispara o fim do mapa (5684+28 >= 5712)
	e2eCoinSafeMaxX = 5689 // moeda com top-left x < 5689 não dispara o fim ao ser coletada
)

// ---- cliente de teste (WebSocket real) ----

type e2eClient struct {
	t         *testing.T
	conn      *websocket.Conn
	id        string
	msgs      chan map[string]any
	coletadas int // moedas coletadas NA FASE ATUAL (contador do broadcast coins)
}

func dialE2E(t *testing.T, wsURL string) *e2eClient {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &e2eClient{t: t, conn: conn, msgs: make(chan map[string]any, 512)}
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			select {
			case c.msgs <- m:
			default: // buffer cheio: descarta (o teste não para de drenar por muito tempo)
			}
		}
	}()
	return c
}

func (c *e2eClient) envia(m map[string]any) {
	c.t.Helper()
	if err := c.conn.WriteJSON(m); err != nil {
		c.t.Fatalf("envio %v: %v", m, err)
	}
}

func (c *e2eClient) estado(x, y, hp, facing int) {
	c.envia(map[string]any{"type": "state", "x": x, "y": y, "hp": hp, "facing": facing})
}

func (c *e2eClient) atira()  { c.envia(map[string]any{"type": "shoot"}) }
func (c *e2eClient) pronto() { c.envia(map[string]any{"type": "shop_ready"}) }

func (c *e2eClient) esperaWelcome(timeout time.Duration) {
	c.t.Helper()
	m := c.esperaTipo("welcome", timeout)
	id, _ := m["id"].(string)
	if id == "" {
		c.t.Fatalf("welcome sem id: %v", m)
	}
	c.id = id
}

// drena esvazia o canal — usado após o broadcast de avanço de fase para
// descartar world msgs enfileirados do estado ANTERIOR antes de ler o novo.
func (c *e2eClient) drena() {
	for {
		select {
		case <-c.msgs:
		default:
			return
		}
	}
}

// espera aguarda a próxima mensagem que satisfaça o predicado (drenando as
// demais). Falha com timeout se não chegar.
func (c *e2eClient) espera(pred func(map[string]any) bool, timeout time.Duration) map[string]any {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if pred(m) {
				return m
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	c.t.Fatalf("timeout (%v) aguardando mensagem", timeout)
	return nil
}

func (c *e2eClient) esperaTipo(typ string, timeout time.Duration) map[string]any {
	c.t.Helper()
	return c.espera(func(m map[string]any) bool { return m["type"] == typ }, timeout)
}

// garanteSemFasePlaying falha se um broadcast de fase playing chegar na
// janela — prova que o avanço NÃO acontece antes de todos confirmarem pronto.
func (c *e2eClient) garanteSemFasePlaying(janela time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(janela)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] == "phase" && m["phase"] == "playing" {
				c.t.Fatalf("fase avançou sem todos prontos: %v", m)
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// semRespostaDeCompra falha se o jogador receber shop_buy_result — a resposta
// de compra é INDIVIDUAL (SendTo); o outro jogador não pode ver o comprovante.
func (c *e2eClient) semRespostaDeCompra(janela time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(janela)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] == "shop_buy_result" {
				c.t.Fatalf("jogador recebeu resposta de compra individual de outro: %v", m)
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// ---- mensagens de fase ----

type faseWire struct {
	fase    string
	numero  int
	pronto  map[string]bool
	players map[string]map[string]any // id → {coins, stats}
}

func parseFase(m map[string]any) faseWire {
	f := faseWire{fase: m["phase"].(string), pronto: map[string]bool{}, players: map[string]map[string]any{}}
	if n, ok := m["number"].(float64); ok {
		f.numero = int(n)
	}
	if r, ok := m["ready"].(map[string]any); ok {
		for id, v := range r {
			f.pronto[id] = v.(bool)
		}
	}
	if ps, ok := m["players"].([]any); ok {
		for _, raw := range ps {
			p, _ := raw.(map[string]any)
			if id, ok := p["id"].(string); ok {
				f.players[id] = p
			}
		}
	}
	return f
}

func (c *e2eClient) esperaFase(pred func(faseWire) bool, timeout time.Duration) faseWire {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] != "phase" {
				continue
			}
			f := parseFase(m)
			if pred(f) {
				return f
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	c.t.Fatalf("timeout (%v) aguardando fase", timeout)
	return faseWire{}
}

func moedasDe(f faseWire, id string) int {
	p, ok := f.players[id]
	if !ok {
		return -1
	}
	return int(p["coins"].(float64))
}

func statsDe(f faseWire, id string) map[string]any {
	p, ok := f.players[id]
	if !ok {
		return nil
	}
	st, _ := p["stats"].(map[string]any)
	return st
}

// ---- compra (resposta individual) ----

type compraWire struct {
	ok      bool
	erro    string
	upgrade string
	level   int
	custo   int
	moedas  int
	stats   map[string]any
}

func parseCompra(m map[string]any) compraWire {
	cw := compraWire{ok: m["ok"].(bool)}
	if s, ok := m["error"].(string); ok {
		cw.erro = s
	}
	if cw.ok {
		cw.upgrade, _ = m["upgrade"].(string)
		cw.level = int(m["level"].(float64))
		cw.custo = int(m["cost"].(float64))
		cw.moedas = int(m["coins"].(float64))
		cw.stats, _ = m["stats"].(map[string]any)
	}
	return cw
}

// compra envia shop_buy e aguarda o shop_buy_result individual.
func (c *e2eClient) compra(upgrade string, timeout time.Duration) compraWire {
	c.t.Helper()
	c.envia(map[string]any{"type": "shop_buy", "upgrade": upgrade})
	return parseCompra(c.esperaTipo("shop_buy_result", timeout))
}

// ---- mundo (broadcast players) ----

type wireCoin struct {
	ID   string
	X, Y int
}

// moedasDoMundo devolve a lista de moedas de um broadcast do mundo (a fase
// recém-reiniciada; chamar drena() antes para não pegar estado velho).
func (c *e2eClient) moedasDoMundo() []wireCoin {
	c.t.Helper()
	m := c.espera(func(m map[string]any) bool {
		cs, _ := m["coins"].([]any)
		return m["type"] == "players" && len(cs) > 0
	}, 5*time.Second)
	cs, _ := m["coins"].([]any)
	out := make([]wireCoin, 0, len(cs))
	for _, raw := range cs {
		cm, _ := raw.(map[string]any)
		out = append(out, wireCoin{
			ID: cm["id"].(string),
			X:  int(cm["x"].(float64)),
			Y:  int(cm["y"].(float64)),
		})
	}
	return out
}

type wireInimigo struct {
	ID, Tipo string
	X, Y     int
}

func (c *e2eClient) inimigosDoMundo() []wireInimigo {
	c.t.Helper()
	m := c.espera(func(m map[string]any) bool {
		es, _ := m["enemies"].([]any)
		return m["type"] == "players" && len(es) > 0
	}, 5*time.Second)
	es, _ := m["enemies"].([]any)
	out := make([]wireInimigo, 0, len(es))
	for _, raw := range es {
		em, _ := raw.(map[string]any)
		out = append(out, wireInimigo{
			ID:   em["id"].(string),
			Tipo: em["type"].(string),
			X:    int(em["x"].(float64)),
			Y:    int(em["y"].(float64)),
		})
	}
	return out
}

// jogadorNoMundo aguarda um broadcast com o jogador e devolve o estado dele.
func (c *e2eClient) jogadorNoMundo(id string) map[string]any {
	c.t.Helper()
	m := c.espera(func(m map[string]any) bool {
		if m["type"] != "players" {
			return false
		}
		ps, _ := m["players"].([]any)
		for _, raw := range ps {
			if p, _ := raw.(map[string]any); p["id"] == id {
				return true
			}
		}
		return false
	}, 5*time.Second)
	ps, _ := m["players"].([]any)
	for _, raw := range ps {
		if p, _ := raw.(map[string]any); p["id"] == id {
			return p
		}
	}
	return nil
}

// esperaProjeteis aguarda um broadcast com pelo menos n projéteis do jogador
// (não hostis) no mundo — prova que a cadência de tiro aumentou.
func (c *e2eClient) esperaProjeteis(id string, n int, timeout time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] != "players" {
				continue
			}
			ps, _ := m["projectiles"].([]any)
			count := 0
			for _, raw := range ps {
				p, _ := raw.(map[string]any)
				if p["owner"] == id && p["hostile"] != true {
					count++
				}
			}
			if count >= n {
				return
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	c.t.Fatalf("timeout: esperados %d projéteis de %s no mundo", n, id)
}

// coletaMoeda posiciona o jogador sobre a moeda (sobreposição AABB) e espera
// o broadcast coins confirmar a coleta (contador da fase sobe). A confirmação
// torna a coleta determinística — sem depender de timing de tick.
func (c *e2eClient) coletaMoeda(coin wireCoin) {
	c.t.Helper()
	antes := c.coletadas
	c.estado(coin.X-5, coin.Y-5, 100, 1)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] != "coins" {
				continue
			}
			counts, _ := m["counts"].(map[string]any)
			if v, ok := counts[c.id].(float64); ok && int(v) > antes {
				c.coletadas = int(v)
				return
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	c.t.Fatalf("timeout coletando moeda %s (%d,%d): contador %d", coin.ID, coin.X, coin.Y, c.coletadas)
}

// ---- power-ups (broadcast powerups + campo do mundo) ----

type wirePowerUp struct {
	ID, Kind string
	X, Y     int
}

// powerUpsDoMundo devolve a lista de power-ups de um broadcast do mundo
// (recém-conectado; chamar drena() antes para não pegar estado velho).
func (c *e2eClient) powerUpsDoMundo() []wirePowerUp {
	c.t.Helper()
	m := c.espera(func(m map[string]any) bool {
		ps, _ := m["powerUps"].([]any)
		return m["type"] == "players" && len(ps) > 0
	}, 5*time.Second)
	ps, _ := m["powerUps"].([]any)
	out := make([]wirePowerUp, 0, len(ps))
	for _, raw := range ps {
		pm, _ := raw.(map[string]any)
		out = append(out, wirePowerUp{
			ID:   pm["id"].(string),
			Kind: pm["kind"].(string),
			X:    int(pm["x"].(float64)),
			Y:    int(pm["y"].(float64)),
		})
	}
	return out
}

// coletaPowerUp posiciona o jogador sobre o power-up (sobreposição AABB, sem
// física — o servidor compara o X/Y reportado) e espera o broadcast powerups
// confirmar a remoção + efeito ativo no HUD. Devolve o broadcast recebido.
func (c *e2eClient) coletaPowerUp(pu wirePowerUp, timeout time.Duration) map[string]any {
	c.t.Helper()
	c.estado(pu.X-5, pu.Y-5, 100, 1)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.msgs:
			if m["type"] != "powerups" {
				continue
			}
			removed, _ := m["removed"].([]any)
			for _, raw := range removed {
				if r, _ := raw.(map[string]any); r["id"] == pu.ID {
					return m
				}
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	c.t.Fatalf("timeout coletando power-up %s (%s @%d,%d)", pu.ID, pu.Kind, pu.X, pu.Y)
	return nil
}

// coletaFaseETermina faz a coleta da fase atual: alice coleta todas as moedas
// coletáveis exceto uma (que fica para bob — prova de carteiras individuais),
// depois chega ao fim do mapa e espera a loja abrir. Devolve o broadcast da
// loja (phase=shop).
func coletaFaseETermina(t *testing.T, alice, bob *e2eClient) faseWire {
	t.Helper()
	alice.drena()
	coins := alice.moedasDoMundo()
	sort.Slice(coins, func(i, j int) bool { return coins[i].X < coins[j].X })
	var alvo []wireCoin
	for _, c := range coins {
		if c.X < e2eCoinSafeMaxX {
			alvo = append(alvo, c)
		}
	}
	if len(alvo) < 2 {
		t.Fatalf("fase com apenas %d moedas coletáveis, esperava >= 2 (total %d)", len(alvo), len(coins))
	}
	alice.coletadas = 0
	bob.coletadas = 0
	for _, c := range alvo[1:] {
		alice.coletaMoeda(c)
	}
	bob.coletaMoeda(alvo[0])
	// fim do mapa → a loja abre (fase shop)
	alice.estado(e2eFinishX, 440, 100, 1)
	return alice.esperaFase(func(f faseWire) bool { return f.fase == "shop" }, 5*time.Second)
}

// gateDePronto: alice confirma pronto; a fase NÃO avança até bob confirmar.
func gateDePronto(t *testing.T, alice, bob *e2eClient) {
	t.Helper()
	alice.pronto()
	f := alice.esperaFase(func(fw faseWire) bool {
		return fw.fase == "shop" && fw.pronto[alice.id]
	}, 5*time.Second)
	if f.pronto[bob.id] {
		t.Fatalf("bob já apareceu pronto sem ter confirmado: %v", f)
	}
	// janela de segurança: com bob pendente, a fase não pode avançar
	alice.garanteSemFasePlaying(700 * time.Millisecond)
	bob.pronto()
}

// ---- o teste ----

func TestFluxoLojaCompletoE2E(t *testing.T) {
	srv := httptest.NewServer(newGameServer())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"

	alice := dialE2E(t, wsURL)
	defer alice.conn.Close()
	bob := dialE2E(t, wsURL)
	defer bob.conn.Close()

	// ===== 1) JOIN: contexto de fase inicial =====
	alice.esperaWelcome(3 * time.Second)
	bob.esperaWelcome(3 * time.Second)
	fJoinA := alice.esperaFase(func(f faseWire) bool { return f.fase == "playing" }, 3*time.Second)
	fJoinB := bob.esperaFase(func(f faseWire) bool { return f.fase == "playing" }, 3*time.Second)
	if fJoinA.numero != 1 || fJoinB.numero != 1 {
		t.Fatalf("fase inicial = %d/%d, want 1/1", fJoinA.numero, fJoinB.numero)
	}
	if len(fJoinB.players) != 2 {
		t.Fatalf("contexto de fase do bob tem %d jogadores, want 2", len(fJoinB.players))
	}
	for _, id := range []string{alice.id, bob.id} {
		if moedasDe(fJoinB, id) != 0 {
			t.Errorf("join: %s coins = %d, want 0", id, moedasDe(fJoinB, id))
		}
	}

	// ===== 2) LOJA FECHADA DURANTE O MAPA (só existe entre fases) =====
	alice.envia(map[string]any{"type": "shop_buy", "upgrade": "max_hp"})
	rej := parseCompra(alice.esperaTipo("shop_buy_result", 3*time.Second))
	if rej.ok || !strings.Contains(rej.erro, "loja") {
		t.Fatalf("shop_buy fora da loja = ok:%v erro:%q, want rejeitado com erro de fase", rej.ok, rej.erro)
	}

	// ===== 3) FASE 1: coleta → carteira individual; fim do mapa → loja =====
	shop1 := coletaFaseETermina(t, alice, bob)
	if shop1.numero != 1 {
		t.Fatalf("loja abriu no número %d, want 1", shop1.numero)
	}
	if shop1.pronto[alice.id] || shop1.pronto[bob.id] {
		t.Fatalf("loja abriu com alguém pronto: %v", shop1.pronto)
	}
	balA := moedasDe(shop1, alice.id)
	balB := moedasDe(shop1, bob.id)
	if balA != alice.coletadas {
		t.Errorf("alice na loja: %d moedas, want %d (coletadas na fase)", balA, alice.coletadas)
	}
	if balB != 1 {
		t.Errorf("bob na loja: %d moedas, want 1 (só a moeda dele)", balB)
	}
	if balA < 30 {
		t.Fatalf("alice coletou %d moedas na fase 1, insuficiente para comprar escudo (30)", balA)
	}
	stA := statsDe(shop1, alice.id)
	if stA["maxHp"] != float64(100) || stA["fireRate"] != 1.0 || stA["shield"] != float64(0) {
		t.Errorf("alice stats na 1ª loja = %v, want base (100/1/0)", stA)
	}

	// ===== 4) COMPRA (escudo): débito só do comprador, resposta individual =====
	rc := alice.compra("shield", 3*time.Second)
	if !rc.ok {
		t.Fatalf("compra escudo = ok:%v erro:%q", rc.ok, rc.erro)
	}
	if rc.upgrade != "shield" || rc.level != 1 || rc.custo != 30 {
		t.Errorf("comprovante = %+v, want shield lv1 custo 30", rc)
	}
	if rc.moedas != balA-30 {
		t.Errorf("saldo no comprovante = %d, want %d (saldo − custo)", rc.moedas, balA-30)
	}
	if rc.stats["shield"] != float64(1) || rc.stats["maxHp"] != float64(100) {
		t.Errorf("stats do comprovante = %v, want shield 1 / maxHp 100", rc.stats)
	}
	// bob NÃO recebe a resposta individual da compra de alice
	bob.semRespostaDeCompra(400 * time.Millisecond)

	// ===== 5) PRONTO COLETIVO: gate + broadcast com upgrades e saldos =====
	gateDePronto(t, alice, bob)
	play2 := alice.esperaFase(func(f faseWire) bool { return f.fase == "playing" && f.numero == 2 }, 5*time.Second)
	if len(play2.pronto) != 0 {
		t.Errorf("pronto após avanço = %v, want vazio", play2.pronto)
	}
	if got := moedasDe(play2, alice.id); got != rc.moedas {
		t.Errorf("alice pós-avanço: %d moedas, want %d (saldo do comprovante)", got, rc.moedas)
	}
	if got := moedasDe(play2, bob.id); got != balB {
		t.Errorf("bob pós-avanço: %d moedas, want %d (compra de alice não o afeta)", got, balB)
	}
	if got := statsDe(play2, alice.id); got["shield"] != float64(1) {
		t.Errorf("alice stats pós-avanço = %v, want shield 1 aplicado", got)
	}

	// ===== 6) FASE 2: o escudo absorve um hit =====
	alice.drena()
	inimigos := alice.inimigosDoMundo()
	var alvo *wireInimigo
	for i := range inimigos {
		if inimigos[i].Tipo == "andador" {
			alvo = &inimigos[i]
			break
		}
	}
	if alvo == nil {
		t.Fatal("fase 2 sem andador para testar o escudo")
	}
	alice.estado(alvo.X-5, alvo.Y-5, 100, 1) // cola na hitbox do inimigo
	sh := alice.esperaTipo("shield_absorbed", 3*time.Second)
	if sh["id"] != alice.id {
		t.Fatalf("shield_absorbed para %v, want %s (escudo bloqueou o hit)", sh["id"], alice.id)
	}
	alice.estado(96, 440, 100, 1) // afasta do inimigo

	shop2 := coletaFaseETermina(t, alice, bob)
	balA2 := moedasDe(shop2, alice.id)
	if balA2 != rc.moedas+alice.coletadas {
		t.Errorf("alice na 2ª loja: %d moedas, want %d (%d + coleta da fase 2)", balA2, rc.moedas+alice.coletadas, rc.moedas)
	}
	if got := moedasDe(shop2, bob.id); got != 2 {
		t.Errorf("bob na 2ª loja: %d moedas, want 2", got)
	}
	if got := statsDe(shop2, alice.id); got["shield"] != float64(0) {
		t.Errorf("alice stats na 2ª loja = %v, want shield 0 (carga consumida no hit)", got)
	}
	gateDePronto(t, alice, bob)
	alice.esperaFase(func(f faseWire) bool { return f.fase == "playing" && f.numero == 3 }, 5*time.Second)

	// ===== 7) FASE 3: compra fire_rate =====
	shop3 := coletaFaseETermina(t, alice, bob)
	balA3 := moedasDe(shop3, alice.id)
	if balA3 < 40 {
		t.Fatalf("alice na 3ª loja: %d moedas, insuficiente para fire_rate (40)", balA3)
	}
	rc3 := alice.compra("fire_rate", 3*time.Second)
	if !rc3.ok || rc3.upgrade != "fire_rate" || rc3.custo != 40 {
		t.Fatalf("compra fire_rate = %+v, want ok custo 40", rc3)
	}
	if rc3.moedas != balA3-40 || rc3.stats["fireRate"] != 1.2 {
		t.Errorf("comprovante fire_rate = moedas %d (want %d) stats %v (want fireRate 1.2)",
			rc3.moedas, balA3-40, rc3.stats)
	}
	if got := moedasDe(shop3, bob.id); got != 3 {
		t.Errorf("bob na 3ª loja: %d moedas, want 3", got)
	}
	gateDePronto(t, alice, bob)

	// ===== 8) FASE 4: fire_rate aplicado na fase seguinte (stats + tiro) =====
	f4 := alice.esperaFase(func(f faseWire) bool { return f.fase == "playing" && f.numero == 4 }, 5*time.Second)
	if got := statsDe(f4, alice.id); got["fireRate"] != 1.2 {
		t.Fatalf("alice stats na fase 4 = %v, want fireRate 1.2 aplicado", got)
	}
	// Cadência: intervalo efetivo 150ms/1.2 = 125ms. Dois tiros com 140ms de
	// intervalo geram DOIS projéteis — sem o upgrade (150ms) o segundo seria
	// descartado. Alice atira do alto (y=200, fileiras 3-4 sem sólidos): os
	// projéteis voam o mapa inteiro sem colidir nem atingir inimigos.
	alice.estado(96, 200, 100, 1)
	alice.atira()
	time.Sleep(140 * time.Millisecond)
	alice.atira()
	alice.esperaProjeteis(alice.id, 2, 3*time.Second)

	shop4 := coletaFaseETermina(t, alice, bob)
	balA4 := moedasDe(shop4, alice.id)
	if balA4 < 50 {
		t.Fatalf("alice na 4ª loja: %d moedas, insuficiente para max_hp (50)", balA4)
	}
	rc4 := alice.compra("max_hp", 3*time.Second)
	if !rc4.ok || rc4.upgrade != "max_hp" || rc4.custo != 50 {
		t.Fatalf("compra max_hp = %+v, want ok custo 50", rc4)
	}
	if rc4.moedas != balA4-50 || rc4.stats["maxHp"] != float64(125) {
		t.Errorf("comprovante max_hp = moedas %d (want %d) stats %v (want maxHp 125)",
			rc4.moedas, balA4-50, rc4.stats)
	}
	gateDePronto(t, alice, bob)

	// ===== 9) FASE 5: max_hp aplicado (stats + HP real no mundo) =====
	f5 := alice.esperaFase(func(f faseWire) bool { return f.fase == "playing" && f.numero == 5 }, 5*time.Second)
	if got := statsDe(f5, alice.id); got["maxHp"] != float64(125) {
		t.Fatalf("alice stats na fase 5 = %v, want maxHp 125 aplicado", got)
	}
	alice.drena()
	world := alice.jogadorNoMundo(alice.id)
	if hp := int(world["hp"].(float64)); hp != 125 {
		t.Errorf("alice HP no mundo da fase 5 = %d, want 125 (teto elevado no respawn)", hp)
	}
	// carteira de bob intacta ao fim (só a moeda dele por fase)
	if got := moedasDe(f5, bob.id); got != 4 {
		t.Errorf("bob na fase 5 = %d moedas, want 4 (intocado pelas compras de alice)", got)
	}
}

// TestPowerUpsE2E cobre o caminho autoritativo dos power-ups no servidor
// REAL (mesma fiação do binário): a fase 1 (seed 1) gera exatamente 2
// power-ups (tiro_triplo e escudo) que chegam no broadcast do mundo; coletar
// um deles (sobreposição reportada) remove o coletável, aplica o EFEITO
// (tiro triplo com ticks restantes no HUD) e o broadcast powerups carrega a
// remoção + o estado dos efeitos. O segundo (escudo) confirma o efeito de
// carga no HUD. A verificação por seed/raridade fica nos testes de unidade
// (level_test.go/powerups_test.go).
func TestPowerUpsE2E(t *testing.T) {
	srv := httptest.NewServer(newGameServer())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"

	alice := dialE2E(t, wsURL)
	defer alice.conn.Close()

	alice.esperaWelcome(3 * time.Second)
	alice.esperaFase(func(f faseWire) bool { return f.fase == "playing" }, 3*time.Second)

	// ===== 1) Fase 1 (seed 1): power-ups no mundo, limitados e tipados =====
	alice.drena()
	pus := alice.powerUpsDoMundo()
	if len(pus) == 0 || len(pus) > 3 {
		t.Fatalf("fase 1 com %d power-ups, want 1..3 (raridade limitada)", len(pus))
	}
	kinds := map[string]int{}
	for _, pu := range pus {
		if pu.Kind != "vida" && pu.Kind != "tiro_triplo" && pu.Kind != "escudo" {
			t.Errorf("power-up %s com tipo desconhecido %q", pu.ID, pu.Kind)
		}
		kinds[pu.Kind]++
	}
	if kinds["tiro_triplo"] != 1 || kinds["escudo"] != 1 {
		t.Errorf("fase 1 (seed 1) deveria ter exatamente 1 tiro_triplo e 1 escudo, got %v", kinds)
	}

	// ===== 2) Coleta do tiro_triplo: removido + efeito ativo no HUD =====
	var alvo wirePowerUp
	for _, pu := range pus {
		if pu.Kind == "tiro_triplo" && pu.X < e2eCoinSafeMaxX {
			alvo = pu
			break
		}
	}
	if alvo.ID == "" {
		t.Fatal("tiro_triplo da fase 1 não encontrado antes do fim do mapa")
	}
	m := alice.coletaPowerUp(alvo, 5*time.Second)
	effects, _ := m["effects"].(map[string]any)
	me, ok := effects[alice.id].(map[string]any)
	if !ok {
		t.Fatalf("broadcast powerups sem efeitos de %s: %v", alice.id, m)
	}
	if rest := int(me["tripleShot"].(float64)); rest <= 0 || rest > 200 {
		t.Errorf("tripleShot restante = %d, want 1..200 ticks (10 s)", rest)
	}
	if me["vida"] != float64(0) || me["shield"] != float64(0) {
		t.Errorf("efeitos = %v, want só tiro triplo ativo", me)
	}

	// ===== 3) Coleta do escudo: carga no HUD =====
	for _, pu := range pus {
		if pu.Kind == "escudo" && pu.X < e2eCoinSafeMaxX {
			alvo = pu
			break
		}
	}
	if alvo.ID == "" {
		t.Fatal("escudo da fase 1 não encontrado antes do fim do mapa")
	}
	m2 := alice.coletaPowerUp(alvo, 5*time.Second)
	effects2, _ := m2["effects"].(map[string]any)
	me2, ok := effects2[alice.id].(map[string]any)
	if !ok {
		t.Fatalf("broadcast powerups sem efeitos de %s após escudo: %v", alice.id, m2)
	}
	if me2["shield"] != float64(1) {
		t.Errorf("shield = %v, want 1 carga", me2["shield"])
	}
	// o tiro triplo ainda está ativo (10 s não passaram)
	if rest := int(me2["tripleShot"].(float64)); rest <= 0 {
		t.Errorf("tripleShot restante = %d após coletar o escudo, want > 0", rest)
	}
}
