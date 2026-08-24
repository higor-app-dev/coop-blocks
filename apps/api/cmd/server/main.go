package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/higor-app-dev/coop-blocks/apps/api/internal/game"
	"github.com/higor-app-dev/coop-blocks/apps/api/internal/ws"
)

func main() {
	addr := os.Getenv("API_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           newGameServer(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("coop-blocks api listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

// newGameServer monta o servidor completo do jogo (hub, sala, simulação,
// projéteis, inimigos, moedas, loja e máquina de fases) e devolve o handler
// HTTP. Foi extraído de main() para que os testes E2E executem a MESMA
// fiação do binário em processo (httptest + WebSocket real, com -race) em
// vez de replicar a lógica — o que o teste cobre é exatamente o que roda em
// produção.
func newGameServer() http.Handler {
	hub := ws.NewHub()
	room := game.NewRoom("default")

	// Fase autoritativa: o servidor gera o mundo. A seed base define o mapa da
	// fase 1; cada fase seguinte usa seed base + (número-1) — determinístico:
	// a mesma fase (mesma seed) gera o mesmo mapa para todos os jogadores.
	const baseSeed = uint32(1)
	level, err := game.GenerateLevel(game.LevelSpec{Width: 120, Height: 12, Seed: baseSeed})
	if err != nil {
		log.Fatalf("generate level: %v", err)
	}
	// level é trocado no avanço de fase (handler WS) e lido pelo loop a cada
	// tick — levelMu serializa o acesso entre as goroutines.
	var levelMu sync.RWMutex

	// Projéteis: servidor é dono do estado (posição/velocidade/dono). O hook de
	// colisão é onde a camada de HP/respawn conecta o dano real — aqui o loop
	// processa os hits diretamente (inimigos destrutíveis, tiros hostis contra
	// jogadores).
	projectiles := game.NewProjectileSystemDefault()

	// Inimigos autoritativos: IA determinística com RNG semeado pela fase
	// (mesma seed da sala → todos os jogadores veem o mesmo comportamento).
	// Presença/tipo respeita a fase atual (andador 1+, voador 3+, atirador 5+).
	enemies := game.NewEnemySystemDefault(level.Spec.Seed)
	enemies.SetPhase(1)
	enemies.SpawnForLevel(&level)
	enemies.OnShoot(func(sh game.EnemyShot) {
		projectiles.FireEnemyShot(sh)
	})

	// Boss autoritativo: máquina de estados (investida + salto) com o MESMO
	// RNG da fase — aparece apenas nas fases múltiplas de 5 (BossPhaseStep),
	// no meio do mapa. O hook de colisão de projéteis (StepWorldBoss) e os
	// eventos de Step (dano de contato/área) são tratados no loop abaixo.
	boss := game.NewBossSystemDefault(level.Spec.Seed)
	boss.SetPhase(1)
	boss.SpawnForLevel(&level)

	// Moedas da fase: dono autoritativo do estado (entidades + contador por
	// jogador DA FASE, separado da carteira persistente em sim). Espalhadas
	// pelo grid inicial; drops de inimigos usam SpawnDrop (mesma trilha de
	// coleta/zeramento). Sem pool comum — cada player tem o próprio contador.
	coins := game.NewCoinManagerDefault()
	coins.SpawnForLevel(&level)

	// Power-ups da fase: coletáveis RAROS (1-3 por fase, no máximo um de cada
	// tipo, posições determinísticas da seed — Level.PowerUpSpawns) com dono
	// autoritativo do estado (entidades + efeitos ativos por jogador). Mesma
	// trilha das moedas: SpawnForLevel no início da fase, Step no loop, Reset
	// no avanço. Efeitos aplicados aqui embaixo: VIDA eleva o HP acima do
	// teto no Sim (temporário), TIRO TRIPLO dura 10 s (3 projéteis por
	// disparo) e ESCUDO absorve 1 hit.
	powerups := game.NewPowerUpManagerDefault()
	powerups.SpawnForLevel(&level)

	// Simulação de HP/moedas/respawn: aplica dano de contato e de projétil
	// hostil. A carteira persistente (Sim.Coins) é o saldo da run que a loja
	// gasta — os drops de inimigos viram moedas coletáveis na fase (CoinManager),
	// não crédito direto aqui.
	sim := game.NewSimDefault(game.NewRandomSource(int64(level.Spec.Seed)))

	// Loja da run: estado de upgrades POR JOGADOR (max_hp, fire_rate, shield)
	// com carteira individual de moedas delegada ao Sim (SimPlayer.Coins) —
	// não existe carteira do time. O efeito dos upgrades é aplicado aqui:
	// max_hp sobe o teto no Sim (persiste no respawn), shield absorve um hit
	// (applyDamage) e fire_rate reduz o cooldown de tiro (OnShoot).
	shop := game.NewShopDefault(sim)

	// Run: máquina de fases. Um mapa em andamento (playing) que, ao ser
	// completado, abre a loja (shop) — todos os jogadores precisam confirmar
	// 'pronto' antes de a próxima fase começar. O Run não conhece o mundo: as
	// transições orquestram level/inimigos/moedas/jogadores aqui embaixo.
	run := game.NewRun()

	// Aplica dano e reage à morte: zera o contador de moedas DA FASE do
	// jogador (morte no mapa atual) e broadcasta as contagens. A carteira
	// persistente/gasta (sim.Coins) não é tocada pela morte. Escudo ativo
	// absorve o hit inteiro (consome a carga, nenhum dano aplicado) — escudo
	// da loja (upgrade) primeiro, escudo de power-up em seguida. Na morte,
	// TODOS os efeitos de power-up do jogador somem (efeito morre junto com o
	// player) e o estado dos efeitos é rebroadcastado para o HUD.
	applyDamage := func(id string, dmg int) {
		if shop.AbsorbShield(id) {
			hub.Broadcast(game.ShieldAbsorbedMsg(id))
			return
		}
		if powerups.ConsumeShield(id) {
			hub.Broadcast(game.ShieldAbsorbedMsg(id))
			return
		}
		evs, err := sim.ApplyDamage(id, dmg)
		if err != nil {
			log.Printf("damage %s: %v", id, err)
			return
		}
		for _, ev := range evs {
			if ev.Type == game.EventDeath {
				powerups.ClearPlayer(ev.PlayerID)
				coins.ResetPlayer(ev.PlayerID)
				hub.Broadcast(game.CoinsMsg(coins.Snapshot(), nil, coins.Counts()))
				hub.Broadcast(game.PowerUpsMsg(powerups.Snapshot(), nil, powerups.EffectsSnapshot()))
			}
		}
	}

	// runPlayers monta o estado individual de cada jogador para o broadcast de
	// fase: upgrades efetivos (loja) + saldo INDIVIDUAL de moedas (carteira da
	// run no Sim). Ordenado por ID (sim.Snapshot) — determinístico.
	runPlayers := func() []game.PlayerRunState {
		out := make([]game.PlayerRunState, 0)
		for _, sp := range sim.Snapshot() {
			out = append(out, game.PlayerRunState{
				ID:    sp.ID,
				Coins: sp.Coins,
				Stats: shop.Stats(sp.ID),
			})
		}
		return out
	}

	// broadcastPhase envia o estado atual da fase para todos os clientes
	// (abertura da loja, confirmação de pronto, início do próximo mapa).
	broadcastPhase := func() {
		hub.Broadcast(game.PhaseMsg(run.Phase(), run.Number(), run.ReadyStatus(), runPlayers()))
	}

	// advancePhase reconstrói o mundo do PRÓXIMO mapa e só então fecha a loja
	// (Run.Advance). A ordem importa: enquanto ainda está na loja, o loop não
	// re-abre a loja nem re-dispara o fim de fase — o mundo novo (jogadores no
	// spawn) já está pronto quando a transição shop→playing acontece.
	advancePhase := func() {
		n := run.Number() + 1
		seed := baseSeed + uint32(n-1)
		lvl, err := game.GenerateLevel(game.LevelSpec{Width: 120, Height: 12, Seed: seed})
		if err != nil {
			log.Printf("gerar fase %d: %v", n, err)
			return
		}
		levelMu.Lock()
		level = lvl
		levelMu.Unlock()
		enemies.Reset(seed)
		enemies.SetPhase(n)
		enemies.SpawnForLevel(&level)
		boss.Reset(seed)
		boss.SetPhase(n)
		boss.SpawnForLevel(&level)
		coins.Reset()
		coins.SpawnForLevel(&level)
		powerups.Reset()
		powerups.SpawnForLevel(&level)
		projectiles.Clear()
		sim.ReviveAll()
		hps := map[string]int{}
		for _, sp := range sim.Snapshot() {
			hps[sp.ID] = sp.MaxHP // teto individual com upgrades — nunca regride
		}
		room.ResetToSpawn(lvl.PlayerSpawn.X*game.TileSize, lvl.PlayerSpawn.Y*game.TileSize, hps)
		run.Advance()
	}

	// phaseMu serializa as transições de fase entre handlers WS concorrentes
	// (shop_ready / shop_buy / leave): sem dupla transição mesmo com dois
	// jogadores confirmando 'pronto' ao mesmo tempo.
	var phaseMu sync.Mutex

	// Bridge: eventos do hub -> sala, e broadcast da sala -> hub
	hub.OnJoin(func(c *ws.Client) {
		p := room.AddPlayer(c.ID())
		sim.AddPlayer(c.ID())
		run.AddPlayer(c.ID())
		c.SetState(game.PlayerState{
			X: p.X, Y: p.Y, HP: p.HP,
		})
		hub.SendTo(c, game.WelcomeMsg(c.ID(), room.Snapshot()))
		// O recém-chegado recebe o contexto de fase atual (loja aberta / mapa
		// em andamento) para renderizar a tela certa sem esperar o próximo
		// broadcast.
		hub.SendTo(c, game.PhaseMsg(run.Phase(), run.Number(), run.ReadyStatus(), runPlayers()))
	})

	hub.OnState(func(c *ws.Client, st game.PlayerState) {
		// SetState grava sob o lock da sala — sem corrida com o loop de
		// simulação e o avanço de fase (ResetToSpawn).
		room.SetState(c.ID(), st)
	})

	// Cooldown de tiro por jogador: a cadência efetiva vem do multiplicador de
	// fire_rate da loja (1.0 = base 150 ms; +20% por nível de upgrade). O
	// servidor é autoritativo — clientes não podem spammar tiros além do
	// intervalo permitido. Fora do mapa (fase de loja) não há tiro: o mundo
	// está pausado e ninguém pode agir antes da próxima fase.
	baseFireInterval := 150 * time.Millisecond
	var fireMu sync.Mutex
	lastShot := map[string]time.Time{}

	hub.OnShoot(func(c *ws.Client) {
		if run.Phase() != game.PhasePlaying {
			return
		}
		if st, ok := room.GetState(c.ID()); ok { // cópia sob lock — leitura segura
			stats := shop.Stats(c.ID())
			interval := time.Duration(float64(baseFireInterval) / stats.FireRateMultiplier)
			fireMu.Lock()
			now := time.Now()
			if now.Sub(lastShot[c.ID()]) < interval {
				fireMu.Unlock()
				return // ainda em cooldown — ignora a intenção de tiro
			}
			lastShot[c.ID()] = now
			fireMu.Unlock()
			// Tiro triplo (power-up): 3 projéteis paralelos com deslocamento
			// vertical (lanes) enquanto o efeito estiver ativo — o servidor
			// é autoritativo na cadência e na quantidade.
			projectiles.Fire(c.ID(), float64(st.X), float64(st.Y), st.Facing)
			if powerups.TripleShotActive(c.ID()) {
				projectiles.Fire(c.ID(), float64(st.X), float64(st.Y)-6, st.Facing)
				projectiles.Fire(c.ID(), float64(st.X), float64(st.Y)+6, st.Facing)
			}
		}
	})

	// Compra na loja: válida APENAS na fase de loja (fora dela a loja está
	// fechada — ninguém compra no meio do mapa). Valida o upgrade e o saldo
	// INDIVIDUAL do comprador, debita só as moedas dele e responde com o
	// comprovante (stats + saldo restante). max_hp também eleva o teto no Sim
	// (persiste no respawn e nas próximas fases).
	hub.OnShopBuy(func(c *ws.Client, upgrade string) {
		phaseMu.Lock()
		defer phaseMu.Unlock()
		if run.Phase() != game.PhaseShop {
			hub.SendTo(c, game.ShopBuyResultMsg(false, game.Receipt{}, game.ErrNotInShop.Error()))
			return
		}
		rc, err := shop.Buy(c.ID(), game.UpgradeID(upgrade))
		if err != nil {
			hub.SendTo(c, game.ShopBuyResultMsg(false, game.Receipt{}, err.Error()))
			return
		}
		if rc.UpgradeID == game.UpgradeMaxHP {
			if err := sim.SetMaxHP(c.ID(), rc.Stats.MaxHP); err != nil {
				log.Printf("shop max_hp %s: %v", c.ID(), err)
			}
		}
		hub.SendTo(c, game.ShopBuyResultMsg(true, rc, ""))
	})

	// Confirmação de 'pronto' na loja: marca o jogador e, quando TODOS os
	// jogadores da run confirmaram, reconstrói o próximo mapa e broadcasta o
	// novo estado (fase, upgrades e saldos). Ninguém entra na próxima fase
	// antes do time todo — o Run garante a transição atômica.
	hub.OnShopReady(func(c *ws.Client) {
		phaseMu.Lock()
		defer phaseMu.Unlock()
		allReady, err := run.MarkReady(c.ID())
		if err != nil {
			hub.SendTo(c, game.ShopReadyErrorMsg(err.Error()))
			return
		}
		if allReady {
			advancePhase()
		}
		broadcastPhase()
	})

	hub.OnLeave(func(c *ws.Client) {
		phaseMu.Lock()
		defer phaseMu.Unlock()
		room.RemovePlayer(c.ID())
		sim.RemovePlayer(c.ID()) // sem ghost: desconectou, some do sim e dos broadcasts
		hub.Broadcast(game.LeaveMsg(c.ID()))
		// Saiu na loja e os restantes já estavam todos prontos? Avança — não
		// deixa a run presa esperando quem desistiu.
		if run.RemovePlayer(c.ID()) {
			advancePhase()
			broadcastPhase()
		}
	})

	// Loop de simulação: tick fixo de 50 ms (20 tps, game.FixedDT) avançando
	// inimigos (IA + contato) e projéteis (amigáveis contra inimigos, hostis
	// contra jogadores); broadcast do mundo a cada 2 ticks (~10 Hz, mantém a
	// frequência de antes). Na fase de loja o mundo fica PAUSADO: sem dano,
	// sem coleta — o avanço vem do shop_ready.
	go func() {
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for tick := 0; ; tick++ {
			<-t.C

			// Fase de loja: mundo PAUSADO — sem dano, sem coleta; o avanço vem
			// do shop_ready. O RLock de level fica seguro DURANTE todo o corpo
			// do tick (inclui os steps): o avanço de fase, que troca o level
			// sob o Lock, espera o tick terminar — o tick nunca vê metade do
			// mundo antigo e metade do novo (race read-then-check eliminada).
			// O snapshot de jogadores é tirado DENTRO do gate de fase: um tick
			// que vê playing leu o mundo já pós-avanço (ResetToSpawn acontece
			// antes de Advance), então nunca avalia o fim de fase com posições
			// pré-avanço congeladas no fim do mapa antigo (TOCTOU).
			if run.Phase() == game.PhasePlaying {
				levelMu.RLock()
				lvl := level
				players := room.Players()

				// 1) Inimigos: IA determinística + contato com jogadores.
				for _, ev := range enemies.Step(&lvl, players) {
					if ev.Type == game.EnemyEventPlayerHit {
						applyDamage(ev.PlayerID, ev.Damage)
					}
				}

				// 2) Boss: máquina de estados (investida/salto) — dano por
				//    contato e em área contra jogadores, sempre que houver
				//    boss na fase (múltipla de 5).
				for _, ev := range boss.Step(&lvl, players) {
					if ev.Type == game.BossEventPlayerHit {
						applyDamage(ev.PlayerID, ev.Damage)
					}
				}

				// 3) Projéteis: amigáveis destróem inimigos E o boss — a
				//    destruição DROPA moedas coletáveis na posição final
				//    (SpawnDrop, mesma trilha das moedas geradas: coleta por
				//    Step remove + conta, morte zera o contador da fase);
				//    hostis ferem jogadores. Broadcast imediato para o
				//    client ver as moedas surgirem no ponto da destruição.
				for _, h := range projectiles.StepWorldBoss(&lvl, enemies.Enemies(), players, boss.Boss()) {
					switch h.Kind {
					case game.HitEnemy:
						for _, ev := range enemies.ApplyDamage(h.TargetID, h.Damage, h.OwnerID) {
							if ev.Type == game.EnemyEventDestroyed {
								coins.SpawnDrop(ev.X, ev.Y, ev.Coins)
								hub.Broadcast(game.CoinsMsg(coins.Snapshot(), nil, coins.Counts()))
							}
						}
					case game.HitBoss:
						// Tiro no bloco gigante: derrotou o boss, o drop
						// gordo vira moedas coletáveis e o avanço dos
						// players segue normalmente.
						for _, ev := range boss.ApplyDamage(h.TargetID, h.Damage) {
							if ev.Type == game.BossEventDefeated {
								coins.SpawnDrop(ev.X, ev.Y, ev.Coins)
								hub.Broadcast(game.CoinsMsg(coins.Snapshot(), nil, coins.Counts()))
							}
						}
					case game.HitPlayer:
						applyDamage(h.TargetID, h.Damage)
					}
				}

				// 4) Moedas: coleta por sobreposição (remove + contador do
				//    player + CRÉDITO NA CARTEIRA da run + broadcast com
				//    remoções e contagens). Cada moeda coletada vale 1 moeda
				//    de carteira (Sim.AddCoins) — é essa carteira persistente
				//    que a loja entre fases gasta. O contador da fase
				//    (coins.Counts) é separado: é o display do HUD do mapa
				//    atual, zerado na morte; a carteira sobrevive à morte e
				//    às fases. Sem este crédito, ninguém jamais teria saldo
				//    para comprar upgrades na loja (bug de integração).
				var removed []game.CoinRemoved
				for _, ev := range coins.Step(players) {
					if ev.Type == game.CoinEventCollected {
						if _, err := sim.AddCoins(ev.PlayerID, 1); err != nil {
							log.Printf("creditar moeda %s: %v", ev.PlayerID, err)
						}
						removed = append(removed, game.CoinRemoved{
							ID: ev.CoinID, X: int(ev.X), Y: int(ev.Y),
						})
					}
				}
				if len(removed) > 0 {
					hub.Broadcast(game.CoinsMsg(coins.Snapshot(), removed, coins.Counts()))
				}

				// 5) Power-ups: coleta por sobreposição (MESMA trilha das
				//    moedas — Step remove + devolve o evento) e o efeito é
				//    aplicado aqui, autoritativamente: VIDA eleva o HP acima do
				//    teto no Sim (temporário — respawn/fim de fase restauram
				//    MaxHP), TIRO TRIPLO registra a duração (10 s, expiração por
				//    tick no manager) e ESCUDO concede 1 carga (absorve 1 hit no
				//    applyDamage). Broadcast imediato com remoções + efeitos para
				//    o client tocar a coleta e atualizar o HUD.
				var removedPowerUps []game.PowerUpRemoved
				for _, ev := range powerups.Step(players) {
					if ev.Type == game.PowerUpEventCollected {
						powerups.ApplyCollected(ev.PlayerID, ev.Kind)
						if ev.Kind == game.PowerUpVida {
							// Lê MaxHP e aplica sob o mesmo lock do Sim (sem
							// janela de corrida com upgrades de max_hp da loja).
							if err := sim.BoostHPAboveMax(ev.PlayerID, game.PowerUpVidaBonus); err != nil {
								log.Printf("power-up vida %s: %v", ev.PlayerID, err)
							}
						}
						removedPowerUps = append(removedPowerUps, game.PowerUpRemoved{
							ID: ev.PowerUpID, Kind: ev.Kind.String(), X: int(ev.X), Y: int(ev.Y),
						})
					}
				}
				if len(removedPowerUps) > 0 {
					hub.Broadcast(game.PowerUpsMsg(powerups.Snapshot(), removedPowerUps, powerups.EffectsSnapshot()))
				}

				// 6) Fim de fase: qualquer jogador que cruzou o fim do mapa
				//    fecha a fase e abre a loja — todos precisam confirmar
				//    'pronto' antes do próximo mapa (EnterShop é idempotente;
				//    o Run não deixa re-disparar).
				for _, p := range players {
					if lvl.Finished(float64(p.X)) {
						if run.EnterShop() {
							broadcastPhase()
						}
						break
					}
				}

				levelMu.RUnlock()
			}

			if tick%2 == 0 {
				hub.Broadcast(game.WorldMsg(room.Snapshot(), projectiles.Snapshot(), enemies.Snapshot(), coins.Snapshot(), coins.Counts(), powerups.Snapshot(), powerups.EffectsSnapshot(), boss.Snapshot()))
			}
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/api/ws", hub.ServeWS)

	return logRequests(mux)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start))
	})
}
