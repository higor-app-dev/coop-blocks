// Package ws implementa o hub WebSocket do servidor multiplayer.
package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/higor-app-dev/coop-blocks/apps/api/internal/game"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true }, // dev; restringir em prod
}

// Client é uma conexão WebSocket individual.
type Client struct {
	conn *websocket.Conn
	send chan []byte
	id   string
	mu   sync.Mutex
}

func (c *Client) ID() string { return c.id }

func (c *Client) SetState(st game.PlayerState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = st // estado é mantido na Room; aqui fica para extensões futuras
}

// Hub gerencia todas as conexões ativas.
type Hub struct {
	mu       sync.RWMutex
	clients  map[*Client]bool
	onJoin   func(c *Client)
	onState  func(c *Client, st game.PlayerState)
	onShoot  func(c *Client)
	onLeave  func(c *Client)
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*Client]bool),
	}
}

func (h *Hub) OnJoin(fn func(c *Client))  { h.onJoin = fn }
func (h *Hub) OnState(fn func(c *Client, st game.PlayerState)) { h.onState = fn }
func (h *Hub) OnShoot(fn func(c *Client)) { h.onShoot = fn }
func (h *Hub) OnLeave(fn func(c *Client)) { h.onLeave = fn }

// Broadcast envia uma mensagem JSON para todas as conexões.
func (h *Hub) Broadcast(msg map[string]any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- data:
		default:
			// client lento — dropa para não travar o hub
		}
	}
}

// ServeWS faz upgrade da conexão e inicia os loops de leitura/escrita.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}

	c := &Client{
		conn: conn,
		send: make(chan []byte, 64),
		id:   newID(),
	}

	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()

	if h.onJoin != nil {
		h.onJoin(c)
	}

	go h.writeLoop(c)
	h.readLoop(c)
}

func (h *Hub) readLoop(c *Client) {
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		close(c.send)
		if h.onLeave != nil {
			h.onLeave(c)
		}
		c.conn.Close()
	}()

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type   string `json:"type"`
			X      int    `json:"x"`
			Y      int    `json:"y"`
			HP     int    `json:"hp"`
			Facing int    `json:"facing"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "state":
			if h.onState != nil {
				h.onState(c, game.PlayerState{X: msg.X, Y: msg.Y, HP: msg.HP, Facing: msg.Facing})
			}
		case "shoot":
			// intenção de tiro — o servidor cria o projétil (autoritativo).
			if h.onShoot != nil {
				h.onShoot(c)
			}
		}
	}
}

func (h *Hub) writeLoop(c *Client) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case data, ok := <-c.send:
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
