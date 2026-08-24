// Package game — máquina de fases da run (loja entre mapas).
//
// Este arquivo implementa o fluxo de fase da run: um mapa em andamento
// (PhasePlaying) que, ao ser completado, abre a loja (PhaseShop). Na loja,
// TODOS os jogadores precisam confirmar 'pronto' antes de a próxima fase
// começar — ninguém entra no mapa seguinte antes do time todo.
//
// Responsabilidades do Run:
//
//   - manter a fase atual (playing/shop) e o número da fase (1-based);
//   - manter o ELENCO da run (quem conta como "todos" no all-ready) — os
//     jogadores que entram/saem da sala são adicionados/removidos aqui. O
//     elenco persiste entre fases: quem jogou o mapa 1 também conta no
//     all-ready da loja do mapa 2;
//   - rastrear o estado de 'pronto' POR JOGADOR na loja atual (zerado a cada
//     abertura de loja);
//   - transicionar de forma ATÔMICA: MarkReady que completa o elenco sinaliza
//     o avanço (allReady=true) e Advance fecha a loja (shop→playing,
//     number++) numa única operação sob lock — sem dupla transição mesmo com
//     confirmações concorrentes;
//   - não conhece o mundo (level/inimigos/moedas): a reconstrução do próximo
//     mapa é do servidor (cmd/server/main.go), que chama Advance e depois
//     rebroadcasta o estado com upgrades e saldos.
//
// Thread-safe: todas as operações públicas usam sync.RWMutex.
package game

import (
	"errors"
	"sync"
)

// RunPhase identifica a fase atual da run.
type RunPhase int

const (
	// PhasePlaying: mapa em andamento (jogadores jogando).
	PhasePlaying RunPhase = iota
	// PhaseShop: loja entre mapas — todos os jogadores precisam confirmar
	// 'pronto' antes de a próxima fase começar.
	PhaseShop
)

// Erros da máquina de fases.
var (
	// ErrNotInShop: ação válida apenas durante a fase de loja.
	ErrNotInShop = errors.New("ação permitida apenas na fase de loja")
	// ErrNotInRun: jogador não está no elenco da run (não pode marcar pronto).
	ErrNotInRun = errors.New("jogador não está na run")
)

// Run é a máquina de fases da run: fase atual, número da fase, elenco e
// estado de 'pronto' por jogador na loja. Thread-safe.
type Run struct {
	mu     sync.RWMutex
	phase  RunPhase
	number int             // número da fase atual (1-based)
	roster map[string]bool // elenco da run (quem conta no all-ready)
	ready  map[string]bool // pronto por jogador NA LOJA ATUAL
}

// NewRun cria uma run no início: fase 1, mapa em andamento, elenco vazio.
func NewRun() *Run {
	return &Run{
		phase:  PhasePlaying,
		number: 1,
		roster: make(map[string]bool),
		ready:  make(map[string]bool),
	}
}

// Phase devolve a fase atual da run.
func (r *Run) Phase() RunPhase {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.phase
}

// Number devolve o número da fase atual (1-based).
func (r *Run) Number() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.number
}

// AddPlayer adiciona um jogador ao elenco da run (quem conta como "todos" no
// all-ready). Persiste entre fases; se a loja estiver aberta, o recém-chegado
// entra como não-pronto (a fase não avança até ele confirmar).
func (r *Run) AddPlayer(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.roster[id] = true
	if r.phase == PhaseShop {
		r.ready[id] = false
	}
}

// RemovePlayer remove um jogador do elenco e do mapa de prontos (ex.: saiu da
// sala). Devolve true quando a loja está aberta e TODOS os jogadores restantes
// já estavam prontos — o servidor deve então avançar a fase (evita softlock de
// um jogador que desistiu na loja). Fora da loja devolve sempre false.
func (r *Run) RemovePlayer(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.roster, id)
	delete(r.ready, id)
	return r.phase == PhaseShop && r.allReadyLocked()
}

// EnterShop abre a loja: zera o pronto de todos os jogadores do elenco.
// Devolve true apenas na transição playing→shop (false se já estava na loja —
// usado pelo servidor para não re-disparar a abertura a cada tick).
func (r *Run) EnterShop() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.phase == PhaseShop {
		return false
	}
	r.phase = PhaseShop
	r.ready = make(map[string]bool, len(r.roster))
	for id := range r.roster {
		r.ready[id] = false
	}
	return true
}

// MarkReady marca o jogador como pronto na loja. Devolve (todosProntos, err):
// todosProntos=true quando TODOS os jogadores do elenco já confirmaram — o
// servidor deve então avançar a fase (Advance + reconstrução do mapa). É
// idempotente: confirmar de novo não é erro. Fora da loja devolve ErrNotInShop;
// jogador fora do elenco devolve ErrNotInRun.
func (r *Run) MarkReady(id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.phase != PhaseShop {
		return false, ErrNotInShop
	}
	if _, ok := r.roster[id]; !ok {
		return false, ErrNotInRun
	}
	r.ready[id] = true
	return r.allReadyLocked(), nil
}

// ReadyStatus devolve uma cópia do mapa de prontos (id → pronto) da loja
// atual. Vazio fora da loja.
func (r *Run) ReadyStatus() map[string]bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]bool, len(r.ready))
	for id, ok := range r.ready {
		out[id] = ok
	}
	return out
}

// Advance fecha a loja e inicia a próxima fase: incrementa o número e volta a
// playing numa única operação atômica, zerando o estado de prontos. O servidor
// deve reconstruir o mundo do próximo mapa ANTES de chamar (enquanto ainda
// está na loja o loop não re-abre a loja nem re-dispara o fim de fase) e
// broadcastar o novo estado depois. Fora da loja é um no-op (não incrementa
// nem troca de fase).
func (r *Run) Advance() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.phase != PhaseShop {
		return
	}
	r.phase = PhasePlaying
	r.number++
	r.ready = make(map[string]bool)
}

// allReadyLocked devolve true quando o elenco NÃO está vazio e todos os
// jogadores do elenco estão prontos. Deve ser chamada com o lock held.
func (r *Run) allReadyLocked() bool {
	if len(r.roster) == 0 {
		return false
	}
	for id := range r.roster {
		if !r.ready[id] {
			return false
		}
	}
	return true
}
