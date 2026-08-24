// Package game — loja de upgrades da run (autoritativa, server-side).
//
// Este arquivo implementa a loja de upgrades entre fases:
//
//   - UpgradeID identifica cada upgrade do catálogo (max_hp, fire_rate,
//     shield), cada um com custo em moedas e nível máximo;
//   - o estado de upgrades é POR JOGADOR e sobrevive à morte (run state):
//     cada compra sobe o nível daquele jogador e o efeito entra nas
//     estatísticas efetivas (RunStats);
//   - as moedas são INDIVIDUAIS: não existe carteira do time. O Shop não
//     guarda saldo — ele delega à CoinWallet injetada (no servidor, o Sim),
//     que já mantém um saldo por jogador. A compra valida saldo e debita
//     SOMENTE o comprador;
//   - o efeito do upgrade é aplicado pela camada que liga o Shop ao mundo
//     (cmd/server/main.go): max_hp sobe o teto no Sim (persiste no respawn),
//     shield absorve um hit (AbsorbShield) e fire_rate reduz o cooldown de
//     tiro. O Shop apenas mantém o estado e valida a compra.
//
// Thread-safe: todas as operações públicas usam sync.RWMutex.
package game

import (
	"errors"
	"sync"
)

// IDs dos upgrades do catálogo.
type UpgradeID string

const (
	// UpgradeMaxHP aumenta o teto de vida em DefaultMaxHPPerLevel por nível.
	UpgradeMaxHP UpgradeID = "max_hp"
	// UpgradeFireRate acelera o tiro: multiplicador sobe
	// DefaultFireRatePerLevel por nível (1.0 = base, sem upgrade).
	UpgradeFireRate UpgradeID = "fire_rate"
	// UpgradeShield concede uma carga de escudo que absorve um hit.
	UpgradeShield UpgradeID = "shield"
)

// Custos e efeitos padrão do catálogo (campos <= 0 usam estes defaults).
const (
	DefaultMaxHPCost        = 50  // moedas por nível de max_hp
	DefaultMaxHPMaxLevel    = 3   // níveis máximos de max_hp
	DefaultMaxHPPerLevel    = 25  // +HP no teto por nível
	DefaultFireRateCost     = 40  // moedas por nível de fire_rate
	DefaultFireRateMaxLevel = 3   // níveis máximos de fire_rate
	DefaultFireRatePerLevel = 0.2 // +20% de multiplicador por nível
	DefaultShieldCost       = 30  // moedas por carga de escudo
	DefaultShieldMaxLevel   = 3   // cargas máximas de escudo
)

// Erros da loja.
var (
	ErrInvalidUpgrade = errors.New("upgrade inválido")
	ErrUpgradeMaxed   = errors.New("upgrade já está no nível máximo")
)

// Upgrade descreve um item do catálogo: custo em moedas e nível máximo.
type Upgrade struct {
	ID       UpgradeID
	Cost     int
	MaxLevel int
}

// ShopConfig configura a loja. Campos <= 0 usam os defaults (constantes).
type ShopConfig struct {
	MaxHPCost        int     // custo por nível de max_hp
	MaxHPMaxLevel    int     // níveis máximos de max_hp
	MaxHPPerLevel    int     // +HP por nível
	FireRateCost     int     // custo por nível de fire_rate
	FireRateMaxLevel int     // níveis máximos de fire_rate
	FireRatePerLevel float64 // +multiplicador por nível
	ShieldCost       int     // custo por carga de escudo
	ShieldMaxLevel   int     // cargas máximas de escudo
}

func (c ShopConfig) withDefaults() ShopConfig {
	if c.MaxHPCost <= 0 {
		c.MaxHPCost = DefaultMaxHPCost
	}
	if c.MaxHPMaxLevel <= 0 {
		c.MaxHPMaxLevel = DefaultMaxHPMaxLevel
	}
	if c.MaxHPPerLevel <= 0 {
		c.MaxHPPerLevel = DefaultMaxHPPerLevel
	}
	if c.FireRateCost <= 0 {
		c.FireRateCost = DefaultFireRateCost
	}
	if c.FireRateMaxLevel <= 0 {
		c.FireRateMaxLevel = DefaultFireRateMaxLevel
	}
	if c.FireRatePerLevel <= 0 {
		c.FireRatePerLevel = DefaultFireRatePerLevel
	}
	if c.ShieldCost <= 0 {
		c.ShieldCost = DefaultShieldCost
	}
	if c.ShieldMaxLevel <= 0 {
		c.ShieldMaxLevel = DefaultShieldMaxLevel
	}
	return c
}

// CoinWallet é a carteira individual de moedas de um jogador. O Shop não
// mantém saldo próprio: a compra consulta e debita SOMENTE o saldo do
// comprador. No servidor quem implementa é o Sim (SimPlayer.Coins), que já
// garante saldo por jogador e nunca fica negativo.
type CoinWallet interface {
	// Balance devolve o saldo do jogador e false se ele não existe.
	Balance(id string) (int, bool)
	// Spend debita n moedas do jogador. Deve rejeitar com
	// ErrInsufficientCoins quando o saldo não cobrir.
	Spend(id string, n int) error
}

// RunUpgrades é o estado de upgrades da run de um jogador. Persiste entre
// fases e sobrevive à morte (respawn mantém os upgrades comprados).
type RunUpgrades struct {
	MaxHPLevel    int
	FireRateLevel int
	ShieldCharges int
}

// RunStats são as estatísticas efetivas do jogador após aplicar os upgrades.
// As tags JSON são o wire format consumido pelos broadcasts de fase e loja.
type RunStats struct {
	MaxHP              int     `json:"maxHp"`    // teto de vida (base DefaultMaxHP + bônus)
	FireRateMultiplier float64 `json:"fireRate"` // multiplicador de cadência (1.0 = base)
	ShieldCharges      int     `json:"shield"`   // cargas de escudo restantes
}

// Receipt é o comprovante de uma compra: o que foi comprado, quanto custou,
// o saldo restante e as estatísticas atualizadas do jogador.
type Receipt struct {
	UpgradeID UpgradeID
	Level     int
	Cost      int
	Coins     int
	Stats     RunStats
}

// Shop é a loja da run: catálogo de upgrades + estado por jogador. Thread-safe.
type Shop struct {
	mu     sync.RWMutex
	cfg    ShopConfig
	wallet CoinWallet
	states map[string]*RunUpgrades
}

// NewShop cria uma loja com a wallet e a config dadas.
func NewShop(wallet CoinWallet, cfg ShopConfig) *Shop {
	return &Shop{
		cfg:    cfg.withDefaults(),
		wallet: wallet,
		states: make(map[string]*RunUpgrades),
	}
}

// NewShopDefault cria uma loja com as regras padrão do catálogo.
func NewShopDefault(wallet CoinWallet) *Shop {
	return NewShop(wallet, ShopConfig{})
}

// stateLocked devolve (criando se preciso) o estado de upgrades do jogador.
// Deve ser chamada com o LOCK DE ESCRITA held (cria entrada no mapa).
func (s *Shop) stateLocked(id string) *RunUpgrades {
	st, ok := s.states[id]
	if !ok {
		st = &RunUpgrades{}
		s.states[id] = st
	}
	return st
}

// statsLocked calcula as estatísticas efetivas de um estado. Lock held.
func (s *Shop) statsLocked(st *RunUpgrades) RunStats {
	return RunStats{
		MaxHP:              DefaultMaxHP + st.MaxHPLevel*s.cfg.MaxHPPerLevel,
		FireRateMultiplier: 1.0 + float64(st.FireRateLevel)*s.cfg.FireRatePerLevel,
		ShieldCharges:      st.ShieldCharges,
	}
}

// Catalog devolve o catálogo de upgrades disponíveis, ordenado por ID.
func (s *Shop) Catalog() []Upgrade {
	return []Upgrade{
		{ID: UpgradeMaxHP, Cost: s.cfg.MaxHPCost, MaxLevel: s.cfg.MaxHPMaxLevel},
		{ID: UpgradeFireRate, Cost: s.cfg.FireRateCost, MaxLevel: s.cfg.FireRateMaxLevel},
		{ID: UpgradeShield, Cost: s.cfg.ShieldCost, MaxLevel: s.cfg.ShieldMaxLevel},
	}
}

// Cost devolve o custo de um upgrade e se ele existe no catálogo.
func (s *Shop) Cost(id UpgradeID) (int, bool) {
	for _, u := range s.Catalog() {
		if u.ID == id {
			return u.Cost, true
		}
	}
	return 0, false
}

// Stats devolve as estatísticas efetivas do jogador (sem upgrade = base).
// Nunca cria estado: jogador sem compras tem as estatísticas base.
func (s *Shop) Stats(id string) RunStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[id]
	if !ok {
		st = &RunUpgrades{}
	}
	return s.statsLocked(st)
}

// Buy valida e executa a compra de um upgrade para o jogador:
//  1. o upgrade deve existir no catálogo (ErrInvalidUpgrade);
//  2. o jogador deve existir na carteira (ErrPlayerNotFound);
//  3. o nível atual não pode estar no teto (ErrUpgradeMaxed);
//  4. a carteira deve cobrir o custo (ErrInsufficientCoins) — o débito é
//     feito APENAS no saldo do comprador, nunca em outro jogador;
//  5. aplica o upgrade ao estado individual e devolve o Receipt com as
//     estatísticas e o saldo restante.
//
// A validação de saldo acontece ANTES de qualquer mutação — compra atômica.
func (s *Shop) Buy(playerID string, id UpgradeID) (Receipt, error) {
	cost, ok := s.Cost(id)
	if !ok {
		return Receipt{}, ErrInvalidUpgrade
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	bal, exists := s.wallet.Balance(playerID)
	if !exists {
		return Receipt{}, ErrPlayerNotFound
	}
	if bal < cost {
		return Receipt{}, ErrInsufficientCoins
	}
	st := s.stateLocked(playerID)
	if s.levelLocked(st, id) >= s.maxLevelLocked(id) {
		return Receipt{}, ErrUpgradeMaxed
	}
	if err := s.wallet.Spend(playerID, cost); err != nil {
		return Receipt{}, err
	}
	s.applyLocked(st, id)
	return Receipt{
		UpgradeID: id,
		Level:     s.levelLocked(st, id),
		Cost:      cost,
		Coins:     bal - cost,
		Stats:     s.statsLocked(st),
	}, nil
}

// AbsorbShield consome uma carga de escudo do jogador. Devolve true se havia
// carga para absorver o hit (e ela foi gasta); false caso contrário.
func (s *Shop) AbsorbShield(playerID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stateLocked(playerID)
	if st.ShieldCharges <= 0 {
		return false
	}
	st.ShieldCharges--
	return true
}

// maxLevelLocked devolve o nível máximo do upgrade na config. Lock held.
func (s *Shop) maxLevelLocked(id UpgradeID) int {
	switch id {
	case UpgradeMaxHP:
		return s.cfg.MaxHPMaxLevel
	case UpgradeFireRate:
		return s.cfg.FireRateMaxLevel
	case UpgradeShield:
		return s.cfg.ShieldMaxLevel
	}
	return 0
}

// levelLocked devolve o nível atual do upgrade no estado. Lock held.
func (s *Shop) levelLocked(st *RunUpgrades, id UpgradeID) int {
	switch id {
	case UpgradeMaxHP:
		return st.MaxHPLevel
	case UpgradeFireRate:
		return st.FireRateLevel
	case UpgradeShield:
		return st.ShieldCharges
	}
	return 0
}

// applyLocked sobe o nível do upgrade no estado. Lock held.
func (s *Shop) applyLocked(st *RunUpgrades, id UpgradeID) {
	switch id {
	case UpgradeMaxHP:
		st.MaxHPLevel++
	case UpgradeFireRate:
		st.FireRateLevel++
	case UpgradeShield:
		st.ShieldCharges++
	}
}
