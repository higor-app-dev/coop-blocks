// Package game — mensagens do protocolo WebSocket.
package game

// WelcomeMsg é enviada ao jogador ao conectar.
func WelcomeMsg(id string, players []PlayerState) map[string]any {
	return map[string]any{
		"type":    "welcome",
		"id":      id,
		"players": players,
	}
}

// LeaveMsg notifica a saída de um jogador.
func LeaveMsg(id string) map[string]any {
	return map[string]any{
		"type": "player_leave",
		"id":   id,
	}
}

// PlayersMsg é o broadcast periódico do estado da sala (compatível com o
// client atual; projectiles ausente → lista vazia no client antigo).
func PlayersMsg(players []PlayerState) map[string]any {
	return map[string]any{
		"type":    "players",
		"players": players,
	}
}

// WorldMsg é o broadcast periódico do estado completo do mundo: jogadores +
// projéteis em voo + inimigos. Mantém o type "players" para compatibilidade
// com o client atual — os campos projectiles/enemies são extras e ignorados
// por clients que não os leem.
func WorldMsg(players []PlayerState, projectiles []ProjectileState, enemies []EnemyState) map[string]any {
	return map[string]any{
		"type":        "players",
		"players":     players,
		"projectiles": projectiles,
		"enemies":     enemies,
	}
}
