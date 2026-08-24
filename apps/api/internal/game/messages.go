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
// projéteis em voo + inimigos + moedas da fase + contadores por jogador +
// power-ups da fase + efeitos ativos por jogador + boss (opcional — fases
// múltiplas de 5). Mantém o type "players" para compatibilidade com o client
// atual — os campos projectiles/enemies/coins/coinCounts/powerUps/
// powerUpEffects/boss são extras e ignorados por clients que não os leem.
// O último argumento é variádico para não quebrar chamadas antigas: sem boss,
// o campo "boss" fica nulo (o client esconde a barra de HP).
func WorldMsg(players []PlayerState, projectiles []ProjectileState, enemies []EnemyState, coins []CoinState, coinCounts map[string]int, powerUps []PowerUpState, powerUpEffects map[string]PlayerPowerUpsState, bosses ...*BossState) map[string]any {
	if coinCounts == nil {
		coinCounts = map[string]int{}
	}
	if powerUps == nil {
		powerUps = []PowerUpState{}
	}
	if powerUpEffects == nil {
		powerUpEffects = map[string]PlayerPowerUpsState{}
	}
	var boss *BossState
	if len(bosses) > 0 {
		boss = bosses[0]
	}
	return map[string]any{
		"type":           "players",
		"players":        players,
		"projectiles":    projectiles,
		"enemies":        enemies,
		"coins":          coins,
		"coinCounts":     coinCounts,
		"powerUps":       powerUps,
		"powerUpEffects": powerUpEffects,
		"boss":           boss,
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

// PowerUpsMsg é o broadcast de atualização de power-ups: estado atual dos
// power-ups restantes (powerUps), remoções deste update (removed — IDs +
// tipo + posição para efeitos de coleta no client) e os efeitos ativos por
// jogador (effects — para o HUD). É enviado a todos os clientes quando um
// power-up é coletado ou os efeitos de um jogador são zerados (morte).
func PowerUpsMsg(powerUps []PowerUpState, removed []PowerUpRemoved, effects map[string]PlayerPowerUpsState) map[string]any {
	if powerUps == nil {
		powerUps = []PowerUpState{}
	}
	if removed == nil {
		removed = []PowerUpRemoved{}
	}
	if effects == nil {
		effects = map[string]PlayerPowerUpsState{}
	}
	return map[string]any{
		"type":     "powerups",
		"powerUps": powerUps,
		"removed":  removed,
		"effects":  effects,
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

// PlayerRunState é o estado individual de um jogador no broadcast de fase:
// saldo de moedas INDIVIDUAL (carteira da run) e estatísticas efetivas com os
// upgrades comprados aplicados (RunStats).
type PlayerRunState struct {
	ID    string   `json:"id"`
	Coins int      `json:"coins"`
	Stats RunStats `json:"stats"`
}

// PhaseMsg é o broadcast de mudança de fase da run. Cobre os três momentos:
//
//   - abertura da loja (phase="shop"): o client renderiza a tela de loja com o
//     saldo de cada jogador, o catálogo e o estado de prontos;
//   - cada confirmação de 'pronto' (phase="shop"): todos os clientes veem quem
//     já confirmou (ready atualizado);
//   - início do próximo mapa (phase="playing"): o client navega para a fase
//     seguinte sabendo os upgrades e saldos atualizados de cada jogador.
//
// players carrega SEMPRE o estado individual (upgrades + saldo); ready só tem
// conteúdo na loja (vazio fora dela).
func PhaseMsg(phase RunPhase, number int, ready map[string]bool, players []PlayerRunState) map[string]any {
	if ready == nil {
		ready = map[string]bool{}
	}
	if players == nil {
		players = []PlayerRunState{}
	}
	return map[string]any{
		"type":    "phase",
		"phase":   runPhaseName(phase),
		"number":  number,
		"ready":   ready,
		"players": players,
	}
}

// runPhaseName serializa a fase da run para o wire format.
func runPhaseName(p RunPhase) string {
	if p == PhaseShop {
		return "shop"
	}
	return "playing"
}

// ShopReadyErrorMsg é a resposta INDIVIDUAL de erro de shop_ready (ex.: fora
// da fase de loja, jogador desconhecido). Sucesso não tem resposta própria — o
// broadcast phase com o estado de prontos atualizado é a confirmação.
func ShopReadyErrorMsg(errMsg string) map[string]any {
	return map[string]any{
		"type":  "shop_ready_result",
		"ok":    false,
		"error": errMsg,
	}
}
