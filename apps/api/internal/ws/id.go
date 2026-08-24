package ws

import (
	"crypto/rand"
	"encoding/hex"
)

// newID gera um ID hex aleatório para cada cliente conectado.
func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(b)
}
