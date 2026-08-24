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

	hub := ws.NewHub()
	room := game.NewRoom("default")

	// Fase autoritativa: o servidor gera o mundo (mesma seed a cada boot até a
	// camada de HP/squad-wipe centralizar a seed no estado da fase, t_244f297c).
	level, err := game.GenerateLevel(game.LevelSpec{Width: 120, Height: 12, Seed: 1})
	if err != nil {
		log.Fatalf("generate level: %v", err)
	}

	// Projéteis: servidor é dono do estado (posição/velocidade/dono). O hook de
	// colisão é onde a camada de HP/respawn (t_244f297c) conecta o dano real —
	// aqui o loop processa os hits diretamente (inimigos destrutíveis, tiros
	// hostis contra jogadores).
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

	// Moedas da fase: dono autoritativo do estado (entidades + contador por
	// jogador DA FASE, separado da carteira persistente em sim). Espalhadas
	// pelo grid inicial; drops de inimigos usam SpawnAt (mesma trilha de
	// coleta/zeramento). Sem pool comum — cada player tem o próprio contador.
	coins := game.NewCoinManagerDefault()
	coins.SpawnForLevel(&level)

	// Simulação de HP/moedas/respawn: aplica dano de contato e de projétil
	// hostil, e credita as moedas dos drops aos atiradores.
	sim := game.NewSimDefault(game.NewRandomSource(int64(level.Spec.Seed)))

	// Loja da run: estado de upgrades POR JOGADOR (max_hp, fire_rate, shield)
	// com carteira individual de moedas delegada ao Sim (SimPlayer.Coins) —
	// não existe carteira do time. O efeito dos upgrades é aplicado aqui:
	// max_hp sobe o teto no Sim (persiste no respawn), shield absorve um hit
	// (applyDamage) e fire_rate reduz o cooldown de tiro (OnShoot).
	shop := game.NewShopDefault(sim)

	// Aplica dano e reage à morte: zera o contador de moedas DA FASE do
	// jogador (morte no mapa atual) e broadcasta as contagens. A carteira
	// persistente/gasta (sim.Coins) não é tocada pela morte. Escudo ativo
	// absorve o hit inteiro (consome a carga, nenhum dano aplicado).
	applyDamage := func(id string, dmg int) {
		if shop.AbsorbShield(id) {
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
				coins.ResetPlayer(ev.PlayerID)
				hub.Broadcast(game.CoinsMsg(coins.Snapshot(), nil, coins.Counts()))
			}
		}
	}

	// Bridge: eventos do hub -> sala, e broadcast da sala -> hub
	hub.OnJoin(func(c *ws.Client) {
		p := room.AddPlayer(c.ID())
		sim.AddPlayer(c.ID())
		c.SetState(game.PlayerState{
			X: p.X, Y: p.Y, HP: p.HP,
		})
		hub.Broadcast(game.WelcomeMsg(c.ID(), room.Snapshot()))
	})

	hub.OnState(func(c *ws.Client, st game.PlayerState) {
		if p, ok := room.GetPlayer(c.ID()); ok {
			p.X, p.Y, p.HP = st.X, st.Y, st.HP
			// facing só é gravado quando o client o envia (0 = ausente/legado).
			if st.Facing != 0 {
				p.Facing = st.Facing
			}
		}
	})

	// Cooldown de tiro por jogador: a cadência efetiva vem do multiplicador de
	// fire_rate da loja (1.0 = base 150 ms; +20% por nível de upgrade). O
	// servidor é autoritativo — clientes não podem spammar tiros além do
	// intervalo permitido.
	baseFireInterval := 150 * time.Millisecond
	var fireMu sync.Mutex
	lastShot := map[string]time.Time{}

	hub.OnShoot(func(c *ws.Client) {
		if p, ok := room.GetPlayer(c.ID()); ok {
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
			projectiles.Fire(c.ID(), float64(p.X), float64(p.Y), p.Facing)
		}
	})

	// Compra na loja: valida o upgrade e o saldo INDIVIDUAL do comprador,
	// debita só as moedas dele e responde com o comprovante (stats + saldo
	// restante). max_hp também eleva o teto no Sim (persiste no respawn).
	hub.OnShopBuy(func(c *ws.Client, upgrade string) {
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

	hub.OnLeave(func(c *ws.Client) {
		room.RemovePlayer(c.ID())
		hub.Broadcast(game.LeaveMsg(c.ID()))
	})

	// Loop de simulação: tick fixo de 50 ms (20 tps, game.FixedDT) avançando
	// inimigos (IA + contato) e projéteis (amigáveis contra inimigos, hostis
	// contra jogadores); broadcast do mundo a cada 2 ticks (~10 Hz, mantém a
	// frequência de antes).
	go func() {
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for tick := 0; ; tick++ {
			<-t.C
			players := room.Players()

			// 1) Inimigos: IA determinística + contato com jogadores.
			for _, ev := range enemies.Step(&level, players) {
				if ev.Type == game.EnemyEventPlayerHit {
					applyDamage(ev.PlayerID, ev.Damage)
				}
			}

			// 2) Projéteis: amigáveis destróem inimigos (drop de moedas para o
			//    atirador); hostis ferem jogadores.
			for _, h := range projectiles.StepWorld(&level, enemies.Enemies(), players) {
				switch h.Kind {
				case game.HitEnemy:
					for _, ev := range enemies.ApplyDamage(h.TargetID, h.Damage, h.OwnerID) {
						if ev.Type == game.EnemyEventDestroyed {
							if _, err := sim.AddCoins(ev.PlayerID, ev.Coins); err != nil {
								log.Printf("coin drop: %v", err)
							}
						}
					}
				case game.HitPlayer:
					applyDamage(h.TargetID, h.Damage)
				}
			}

			// 3) Moedas: coleta por sobreposição (remove + contador do player +
			//    broadcast com remoções e contagens para todos os clientes).
			var removed []game.CoinRemoved
			for _, ev := range coins.Step(players) {
				if ev.Type == game.CoinEventCollected {
					removed = append(removed, game.CoinRemoved{
						ID: ev.CoinID, X: int(ev.X), Y: int(ev.Y),
					})
				}
			}
			if len(removed) > 0 {
				hub.Broadcast(game.CoinsMsg(coins.Snapshot(), removed, coins.Counts()))
			}

			if tick%2 == 0 {
				hub.Broadcast(game.WorldMsg(room.Snapshot(), projectiles.Snapshot(), enemies.Snapshot(), coins.Snapshot(), coins.Counts()))
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

	srv := &http.Server{
		Addr:              addr,
		Handler:           logRequests(mux),
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

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start))
	})
}
