package ws

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHubShopBuyRoteiaParaCallback(t *testing.T) {
	h := NewHub()
	// o welcome é enviado pelo handler de join (no servidor real, main.go)
	h.OnJoin(func(c *Client) {
		h.Broadcast(map[string]any{"type": "welcome", "id": c.ID()})
	})
	got := make(chan string, 1)
	h.OnShopBuy(func(c *Client, upgrade string) {
		got <- upgrade
	})

	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// espera o welcome (garante que o readLoop do servidor está ativo)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("welcome: %v", err)
	}

	if err := conn.WriteJSON(map[string]any{"type": "shop_buy", "upgrade": "max_hp"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case up := <-got:
		if up != "max_hp" {
			t.Errorf("upgrade = %q, want %q", up, "max_hp")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout: shop_buy não chegou ao callback")
	}

	// upgrade vazio/ausente também é roteado (validação fica no handler)
	if err := conn.WriteJSON(map[string]any{"type": "shop_buy"}); err != nil {
		t.Fatalf("write 2: %v", err)
	}
	select {
	case up := <-got:
		if up != "" {
			t.Errorf("upgrade ausente = %q, want vazio", up)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout: shop_buy sem upgrade não chegou ao callback")
	}
}

func TestHubSendToEntregaApenasAoDestinatario(t *testing.T) {
	h := NewHub()
	joined := make(chan *Client, 2)
	h.OnJoin(func(c *Client) {
		joined <- c
		h.Broadcast(map[string]any{"type": "welcome", "id": c.ID()})
	})

	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"

	connA, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	defer connA.Close()
	connB, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.Close()

	var clientA, clientB *Client
	select {
	case clientA = <-joined:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout: join A")
	}
	select {
	case clientB = <-joined:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout: join B")
	}

	readMsg := func(conn *websocket.Conn, label string) {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, _, err := conn.ReadMessage(); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
	}
	// A: welcome do próprio join; B: welcome do join dele; A: welcome do join
	// de B (broadcast) — drena tudo antes de testar o SendTo.
	readMsg(connA, "welcome A")
	readMsg(connB, "welcome B")
	readMsg(connA, "welcome do join de B")

	// resposta individual para A (ex.: comprovante de compra)
	h.SendTo(clientA, map[string]any{"type": "shop_buy_result", "ok": true})
	connA.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := connA.ReadMessage()
	if err != nil {
		t.Fatalf("A não recebeu a resposta: %v", err)
	}
	var msg struct {
		Type string `json:"type"`
		OK   bool   `json:"ok"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("json: %v", err)
	}
	if msg.Type != "shop_buy_result" || !msg.OK {
		t.Errorf("msg = %+v, want shop_buy_result ok=true", msg)
	}

	// B NÃO deve receber (SendTo é individual, não broadcast)
	connB.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, _, err := connB.ReadMessage(); err == nil {
		t.Error("B recebeu a resposta individual de A (SendTo vazou)")
	} else if ne, ok := err.(net.Error); !ok || !ne.Timeout() {
		// qualquer erro que não seja timeout de leitura é falha
		t.Errorf("leitura em B: %v", err)
	}
	_ = clientB
}

func TestHubShopReadyRoteiaParaCallback(t *testing.T) {
	h := NewHub()
	h.OnJoin(func(c *Client) {
		h.Broadcast(map[string]any{"type": "welcome", "id": c.ID()})
	})
	got := make(chan string, 1)
	h.OnShopReady(func(c *Client) {
		got <- c.ID()
	})

	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("welcome: %v", err)
	}

	if err := conn.WriteJSON(map[string]any{"type": "shop_ready"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case id := <-got:
		if id == "" {
			t.Error("shop_ready chegou ao callback com ID vazio")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout: shop_ready não chegou ao callback")
	}
}
