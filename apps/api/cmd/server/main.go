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
		}
	})

	hub.OnLeave(func(c *ws.Client) {
		room.RemovePlayer(c.ID())
		hub.Broadcast(game.LeaveMsg(c.ID()))
	})

	// Broadcast periódico do estado da sala (~10 Hz)
	go func() {
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for range t.C {
			hub.Broadcast(game.PlayersMsg(room.Snapshot()))
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
