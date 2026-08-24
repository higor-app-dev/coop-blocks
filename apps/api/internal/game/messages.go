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
// projéteis em voo + inimigos + moedas da fase + contadores por jogador.
// Mantém o type "players" para compatibilidade com o client atual — os
// campos projectiles/enemies/coins/coinCounts são extras e ignorados por
// clients que não os leem.
func WorldMsg(players []PlayerState, projectiles []ProjectileState, enemies []EnemyState, coins []CoinState, coinCounts map[string]int) map[string]any {
	if coinCounts == nil {
		coinCounts = map[string]int{}
	}
	return map[string]any{
		"type":        "players",
		"players":     players,
		"projectiles": projectiles,
		"enemies":     enemies,
		"coins":       coins,
		"coinCounts":  coinCounts,
	}
}

// CoinsMsg é o broadcast de atualização de moedas: estado atual das moedas
// restantes (coins), remoções deste update (removed — IDs + posição para
// efeitos de coleta no client) e os contadores por jogador da fase (counts).
// É enviado a todos os clientes quando moedas são coletadas ou um contador é
// zerado (morte no mapa atual).
func CoinsMsg(coins []CoinState, removed []CoinRemoved, counts map[string]int) map[string]any {
	if removed == nil {
		removed = []CoinRemoved{}
	}
	if counts == nil {
		counts = map[string]int{}
	}
	return map[string]any{
		"type":    "coins",
		"coins":   coins,
		"removed": removed,
		"counts":  counts,
	}
}
