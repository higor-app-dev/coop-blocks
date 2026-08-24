package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	// aqui apenas loga como prova de que o hook dispara.
	projectiles := game.NewProjectileSystemDefault()
	projectiles.OnHit(func(h game.ProjectileHit) {
		log.Printf("projectile hit: kind=%s owner=%s target=%q at (%d,%d) dmg=%d",
			h.Kind, h.OwnerID, h.TargetID, int(h.X), int(h.Y), h.Damage)
	})

	// Bridge: eventos do hub -> sala, e broadcast da sala -> hub
	hub.OnJoin(func(c *ws.Client) {
		p := room.AddPlayer(c.ID())
		c.SetState(game.PlayerState{
			X:  p.X, Y: p.Y, HP: p.HP,
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

	hub.OnShoot(func(c *ws.Client) {
		if p, ok := room.GetPlayer(c.ID()); ok {
			projectiles.Fire(c.ID(), float64(p.X), float64(p.Y), p.Facing)
		}
	})

	hub.OnLeave(func(c *ws.Client) {
		room.RemovePlayer(c.ID())
		hub.Broadcast(game.LeaveMsg(c.ID()))
	})

	// Loop de simulação: tick fixo de 50 ms (20 tps, game.FixedDT) avançando
	// os projéteis contra o grid da fase; broadcast do mundo a cada 2 ticks
	// (~10 Hz, mantém a frequência de antes). Inimigos ainda não existem como
	// entidades no servidor — a lista chega vazia até a tarefa de HP/inimigos.
	go func() {
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for tick := 0; ; tick++ {
			<-t.C
			projectiles.Step(&level, nil)
			if tick%2 == 0 {
				hub.Broadcast(game.WorldMsg(room.Snapshot(), projectiles.Snapshot()))
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
