// Package game — física do player simulada no servidor (autoritativa).
//
// Este arquivo implementa a simulação de movimento do jogador no servidor:
// posição, velocidade e flag de grounded, com gravidade a cada tick, input
// horizontal (esquerda/direita) e pulo somente quando no chão. A colisão é
// feita contra o grid sólido da fase (Level.Solid), então o player nunca sai
// do mundo, não atravessa paredes e não cai através do chão.
//
// O movimento é determinístico: usa timestep fixo (FixedDT = 1/TicksPerSecond
// = 50 ms por tick) e não depende de aleatoriedade — mesmos inputs e mesma
// fase produzem exatamente a mesma trajetória.
//
// As constantes de física espelham o client (apps/web/src/player.ts e
// main.ts): gravidade 980 px/s², velocidade horizontal 320 px/s, pulo 520 px/s,
// hitbox 28x40 px. Assim a simulação do servidor reproduz o comportamento
// visual do client antigo.
package game

import (
	"math"
)

// Constantes físicas do jogador (alinhadas ao client).
const (
	// PlayerWidth / PlayerHeight: hitbox do jogador em pixels
	// (client: rect(28, 40)).
	PlayerWidth  = 28.0
	PlayerHeight = 40.0
	// PlayerMoveSpeed: velocidade horizontal (client: speed = 320).
	PlayerMoveSpeed = 320.0
	// PlayerJumpSpeed: velocidade vertical inicial do pulo (client: jump(520)).
	PlayerJumpSpeed = 520.0
	// PlayerGravity: aceleração da gravidade (client: setGravity(980)).
	PlayerGravity = 980.0
	// PlayerMaxFallSpeed: velocidade terminal de queda. O client não tem teto;
	// aqui o cap garante que o deslocamento por tick (900*0.05 = 45 px) fique
	// abaixo de TileSize (48 px), impedindo tunnelling através de tiles finos.
	PlayerMaxFallSpeed = 900.0
)

// FixedDT é o timestep fixo da simulação: 1 tick = 50 ms (TicksPerSecond=20).
// É uma const (não var) para que nada possa reatribuí-la em runtime — o
// determinismo depende dela nunca mudar.
const FixedDT = 1.0 / TicksPerSecond

// PlayerConfig configura a física de um jogador. Campos <= 0 usam os
// defaults (constantes acima).
type PlayerConfig struct {
	Width        float64 // largura do hitbox (default PlayerWidth)
	Height       float64 // altura do hitbox (default PlayerHeight)
	MoveSpeed    float64 // velocidade horizontal px/s (default PlayerMoveSpeed)
	JumpSpeed    float64 // velocidade inicial do pulo px/s (default PlayerJumpSpeed)
	Gravity      float64 // aceleração da gravidade px/s² (default PlayerGravity)
	MaxFallSpeed float64 // velocidade terminal px/s (default PlayerMaxFallSpeed)
}

func (c PlayerConfig) withDefaults() PlayerConfig {
	if c.Width <= 0 {
		c.Width = PlayerWidth
	}
	if c.Height <= 0 {
		c.Height = PlayerHeight
	}
	if c.MoveSpeed <= 0 {
		c.MoveSpeed = PlayerMoveSpeed
	}
	if c.JumpSpeed <= 0 {
		c.JumpSpeed = PlayerJumpSpeed
	}
	if c.Gravity <= 0 {
		c.Gravity = PlayerGravity
	}
	if c.MaxFallSpeed <= 0 {
		c.MaxFallSpeed = PlayerMaxFallSpeed
	}
	return c
}

// Input representa a intenção do jogador em um tick. Left/Right são estados
// de tecla segurada; Jump é uma borda de subida (true apenas no tick em que o
// jogador apertou pular); Shoot também é borda de subida — o cooldown de tiro
// é do núcleo (World), então cada tick com Shoot=true dispara no máximo um
// projétil se o cooldown permitir.
type Input struct {
	Left  bool
	Right bool
	Jump  bool
	Shoot bool
}

// PlayerBody é o corpo físico simulado do jogador. Posição (X, Y) é o canto superior
// esquerdo do hitbox em pixels; Y cresce para baixo (mesma convenção do grid
// de Level). VX/VY são velocidades em px/s.
type PlayerBody struct {
	X, Y     float64
	VX, VY   float64
	Grounded bool
	Facing   int // 1 = direita, -1 = esquerda

	cfg PlayerConfig
}

// NewPlayerBody cria um jogador com física padrão na posição dada (top-left).
func NewPlayerBody(x, y float64) *PlayerBody {
	return NewPlayerBodyWithConfig(x, y, PlayerConfig{})
}

// NewPlayerBodyWithConfig cria um jogador com configuração customizada.
func NewPlayerBodyWithConfig(x, y float64, cfg PlayerConfig) *PlayerBody {
	return &PlayerBody{
		X:   x,
		Y:   y,
		cfg: cfg.withDefaults(),
	}
}

// Width/Height devolvem as dimensões do hitbox (respeitando a config).
func (p *PlayerBody) Width() float64  { return p.cfg.Width }
func (p *PlayerBody) Height() float64 { return p.cfg.Height }

// SpawnAt posiciona o jogador de pé no spawn da fase (tile PlayerSpawn do
// level), zerando velocidade e marcando grounded. Útil para nascer e para
// respawn.
func (p *PlayerBody) SpawnAt(l *Level) {
	p.X = float64(l.PlayerSpawn.X * TileSize)
	p.Y = float64(l.PlayerSpawn.Y*TileSize) - p.cfg.Height // pés no topo do tile
	p.VX = 0
	p.VY = 0
	p.Grounded = true
	p.Facing = 1
}

// Step avança um tick com o timestep fixo (FixedDT). Use Update apenas quando
// precisar de um dt diferente (testes/tuning); o determinismo é garantido com
// Step.
func (p *PlayerBody) Step(in Input, l *Level) {
	p.Update(in, l, FixedDT)
}

// Update avança a simulação em dt segundos: aplica input, gravidade e resolve
// colisões com o grid da fase em cada eixo (X primeiro, depois Y — técnica
// clássica de AABB vs tile grid). O player nunca sai dos limites do mundo.
func (p *PlayerBody) Update(in Input, l *Level, dt float64) {
	if dt <= 0 {
		dt = FixedDT
	}

	// 1) Pulo: somente quando grounded (borda de subida do input).
	if in.Jump && p.Grounded {
		p.VY = -p.cfg.JumpSpeed
		p.Grounded = false
	}

	// 2) Movimento horizontal a partir do input (esquerda/direita).
	dir := 0
	if in.Left {
		dir--
	}
	if in.Right {
		dir++
	}
	if dir != 0 {
		p.Facing = dir
		p.VX = float64(dir) * p.cfg.MoveSpeed
	} else {
		p.VX = 0
	}

	// 3) Gravidade: só age fora do chão; limitada pela velocidade terminal.
	if !p.Grounded {
		p.VY += p.cfg.Gravity * dt
		if p.VY > p.cfg.MaxFallSpeed {
			p.VY = p.cfg.MaxFallSpeed
		}
	}

	// 4) Eixo X: move e resolve colisão com paredes, depois clamp no mundo.
	p.X += p.VX * dt
	p.resolveXCollision(l)
	p.clampX(l)

	// 5) Eixo Y: move e resolve colisão com chão/teto.
	p.Y += p.VY * dt
	p.resolveYCollision(l)

	// 6) Grounded recomputado: anda de borda de plataforma/lacuna, cai.
	p.Grounded = p.groundedOn(l)

	// 7) Limite inferior do mundo (cair em lacuna): nunca sai do grid.
	p.clampY(l)
}

// resolveXCollision encosta o hitbox na parede quando o movimento horizontal
// o empurra para dentro de um tile sólido. Zera VX no impacto.
func (p *PlayerBody) resolveXCollision(l *Level) {
	if p.VX > 0 {
		// Borda direita dentro de tile sólido -> encosta na face esquerda.
		col := int(math.Floor((p.X + p.cfg.Width - 1) / TileSize))
		y0 := int(math.Floor(p.Y / TileSize))
		y1 := int(math.Floor((p.Y + p.cfg.Height - 1) / TileSize))
		for ty := y0; ty <= y1; ty++ {
			if l.Solid(col, ty) {
				p.X = float64(col*TileSize) - p.cfg.Width
				p.VX = 0
				return
			}
		}
	} else if p.VX < 0 {
		// Borda esquerda dentro de tile sólido -> encosta na face direita.
		col := int(math.Floor(p.X / TileSize))
		y0 := int(math.Floor(p.Y / TileSize))
		y1 := int(math.Floor((p.Y + p.cfg.Height - 1) / TileSize))
		for ty := y0; ty <= y1; ty++ {
			if l.Solid(col, ty) {
				p.X = float64((col + 1) * TileSize)
				p.VX = 0
				return
			}
		}
	}
}

// resolveYCollision encosta o hitbox no chão (caindo) ou no teto (subindo).
// Ao aterrissar, marca grounded e zera VY.
func (p *PlayerBody) resolveYCollision(l *Level) {
	x0 := int(math.Floor(p.X / TileSize))
	x1 := int(math.Floor((p.X + p.cfg.Width - 1) / TileSize))
	if p.VY > 0 {
		// Pés dentro de tile sólido -> encosta no topo do tile (chão).
		row := int(math.Floor((p.Y + p.cfg.Height - 1) / TileSize))
		for tx := x0; tx <= x1; tx++ {
			if l.Solid(tx, row) {
				p.Y = float64(row*TileSize) - p.cfg.Height
				p.VY = 0
				p.Grounded = true
				return
			}
		}
	} else if p.VY < 0 {
		// Cabeça dentro de tile sólido -> encosta na base do tile (teto).
		row := int(math.Floor(p.Y / TileSize))
		for tx := x0; tx <= x1; tx++ {
			if l.Solid(tx, row) {
				p.Y = float64((row + 1) * TileSize)
				p.VY = 0
				return
			}
		}
	}
}

// groundedOn devolve true quando há tile sólido imediatamente abaixo dos pés.
// Recomputado a cada tick para detectar bordas de plataforma e lacunas.
func (p *PlayerBody) groundedOn(l *Level) bool {
	x0 := int(math.Floor(p.X / TileSize))
	x1 := int(math.Floor((p.X + p.cfg.Width - 1) / TileSize))
	row := int(math.Floor((p.Y + p.cfg.Height) / TileSize))
	for tx := x0; tx <= x1; tx++ {
		if l.Solid(tx, row) {
			return true
		}
	}
	return false
}

// clampX mantém o jogador dentro dos limites horizontais do mundo.
func (p *PlayerBody) clampX(l *Level) {
	if p.X < 0 {
		p.X = 0
		return
	}
	maxX := float64(l.Spec.Width*TileSize) - p.cfg.Width
	if p.X > maxX {
		p.X = maxX
	}
}

// clampY mantém o jogador dentro dos limites verticais do mundo: nunca acima
// do topo e, caindo em lacuna, assenta no fundo do mundo (em vez de cair no
// vazio infinito). A morte por queda é responsabilidade da camada de HP.
func (p *PlayerBody) clampY(l *Level) {
	if p.Y < 0 {
		p.Y = 0
		if p.VY < 0 {
			p.VY = 0
		}
		return
	}
	maxY := float64(l.Spec.Height*TileSize) - p.cfg.Height
	if p.Y >= maxY {
		// Assenta no fundo do mundo. Usa >= (não só >) porque groundedOn()
		// avalia a fileira exatamente no limite como fora do grid (row ==
		// height) — sem isto o player no fundo oscilaria entre grounded e
		// queda no limite exato.
		p.Y = maxY
		if p.VY > 0 {
			p.VY = 0
		}
		p.Grounded = true
	}
}

// State expõe o estado físico do jogador como PlayerState (pronto para ser
// serializado e enviado ao client via broadcast). hp vem de fora porque a
// gestão de HP é da camada de simulação (Sim).
func (p *PlayerBody) State(hp int) PlayerState {
	return PlayerState{
		X:        int(math.Round(p.X)),
		Y:        int(math.Round(p.Y)),
		VX:       p.VX,
		VY:       p.VY,
		HP:       hp,
		Grounded: p.Grounded,
		Facing:   p.Facing,
	}
}
