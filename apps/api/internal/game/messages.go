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

// ShopBuyResultMsg é a resposta INDIVIDUAL de uma compra na loja (enviada só
// ao comprador): ok=true com o comprovante (upgrade comprado, nível, custo,
// saldo restante e estatísticas atualizadas) ou ok=false com o motivo
// (moedas insuficientes, upgrade inválido, etc.).
func ShopBuyResultMsg(ok bool, rc Receipt, errMsg string) map[string]any {
	if !ok {
		return map[string]any{
			"type":  "shop_buy_result",
			"ok":    false,
			"error": errMsg,
		}
	}
	return map[string]any{
		"type":    "shop_buy_result",
		"ok":      true,
		"upgrade": string(rc.UpgradeID),
		"level":   rc.Level,
		"cost":    rc.Cost,
		"coins":   rc.Coins,
		"stats": map[string]any{
			"maxHp":    rc.Stats.MaxHP,
			"fireRate": rc.Stats.FireRateMultiplier,
			"shield":   rc.Stats.ShieldCharges,
		},
	}
}

// ShieldAbsorbedMsg é o broadcast de que o escudo de um jogador absorveu um
// hit (carga consumida) — o client toca o efeito visual e atualiza o HUD.
func ShieldAbsorbedMsg(playerID string) map[string]any {
	return map[string]any{
		"type": "shield_absorbed",
		"id":   playerID,
	}
}
