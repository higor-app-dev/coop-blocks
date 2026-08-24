# Protocolo de Mensagens WebSocket — coop-blocks

Este documento descreve a arquitetura do servidor multiplayer e o protocolo de mensagens
WebSocket do coop-blocks, com base no código-fonte atual (`apps/api` e `apps/web/src/net.ts`).

**Objetivo:** permitir que alguém novo implemente um cliente mínimo (web, desktop ou bot)
apenas com este documento e os tipos definidos em `apps/api/internal/game/messages.go`
e `apps/api/internal/game/room.go`.

> ⚠️ **Fidelidade ao código**: este documento descreve o protocolo **como implementado hoje**.
> Recursos planejados (servidor autoritativo com tick fixo de 20 tps, seed compartilhada,
> morte/respawn e loja) **ainda não existem no protocolo** e estão marcados como tal na
> seção [Arquitetura-alvo (planejada)](#arquitetura-alvo-planejada). Não implemente um
> cliente contra mensagens que não existem no servidor.

---

## 1. Visão geral

- Jogo de plataforma cooperativo 2D (estilo Mario) com geração procedural de fases.
- A **simulação do jogo acontece no cliente** (KaplayJS): física, colisões, HP, inimigos.
- O **servidor (Go + gorilla/websocket) mantém o estado sincronizado dos jogadores** em uma
  sala única e o transmite a todos os clientes conectados.
- Posições e HP de todos os jogadores são **broadcast periódico** (~10 Hz) para todos os
  clientes; cada cliente renderiza os demais jogadores a partir dessa lista.

## 2. Arquitetura

### 2.1 Topologia atual

```
┌─────────────┐   WebSocket (ws://host/api/ws)   ┌──────────────────────────────┐
│  Cliente A  │ ──────────── state ────────────► │                              │
│ (KaplayJS)  │ ◄─────────── welcome ──────────  │          Servidor Go         │
└─────────────┘                                  │  ┌──────────┐  ┌─────────┐  │
┌─────────────┐                                  │  │ ws.Hub   │─►│ game.Room│  │
│  Cliente B  │ ──────────── state ────────────► │  │ (conexões│  │ (estado │  │
│ (KaplayJS)  │ ◄──── players / player_leave ─── │  │  ativas) │  │  sala)  │  │
└─────────────┘                                  │  └──────────┘  └─────────┘  │
                                                 │   ticker 100ms → broadcast   │
                                                 └──────────────────────────────┘
```

### 2.2 Papel do servidor

- **Autoridade sobre a identidade**: gera um `id` hex aleatório (16 caracteres) para cada
  conexão no handshake do WebSocket (sem autenticação).
- **Autoridade sobre o estado persistido da sala**: mantém um `PlayerState` (x, y, hp) por
  jogador em `game.Room` — spawn inicial `(96, 480)` com `HP 100`. Quando um cliente envia
  um `state`, o servidor **grava** os valores recebidos nesse registro.
- **Relay de broadcast**: a cada **100 ms (~10 Hz)** faz broadcast do snapshot da sala
  (`players`) para todas as conexões. Também emite `welcome` (na entrada de jogador) e
  `player_leave` (na saída).
- **Não simula o jogo**: não há física, colisão, inimigos ou validação de movimento no
  servidor hoje. Ele aceita o `state` enviado pelo cliente e o ecoa aos demais.
- **Healthcheck**: `GET /api/health` → `200 {"status":"ok"}` (JSON).

### 2.3 Papel do cliente

- **Simula o jogo localmente** (física, pulo, tiro, colisão com inimigos, HP, morte).
- **Envia seu estado** (`state` com x, y, hp) ao servidor em alta frequência
  (~10×/s no client atual, a cada frame).
- **Consome o broadcast** (`welcome` / `players` / `player_leave`) para desenhar e atualizar
  os jogadores remotos.
- **Reconecta** automaticamente a cada 2 s se a conexão cair.

### 2.4 Transporte e conexão

| Item | Valor |
|------|-------|
| Endpoint | `GET /api/ws` (upgrade WebSocket) |
| Esquema | `ws://` (dev) ou `wss://` (https) |
| Formato das mensagens | **texto**, JSON (um objeto por frame) |
| Roteamento | Vite (`:5173`) faz proxy de `/api/*` para a API Go (`:8080`) |
| Envelope comum | todo objeto tem o campo `type` (string) |
| Ping de manutenção | servidor envia `PingMessage` a cada 30 s |
| Deadline de escrita | 10 s (conexão fechada se estourar) |
| Cliente lento | fila de envio com capacidade 64; estourada → mensagens são **descartadas** (sem travar o hub) |
| Identificação | `id` hex de 16 caracteres gerado pelo servidor (8 bytes aleatórios) |
| Salas | única sala `"default"`; sem seleção de sala no protocolo |
| CORS/Origem | `CheckOrigin` aceita qualquer origem (dev) |
| Encerramento | servidor envia `CloseMessage` ao fechar o loop de escrita |

### 2.5 Modelo de estado

```go
// apps/api/internal/game/room.go
type PlayerState struct {
    X        int     `json:"x"`        // posição x em pixels (mundo)
    Y        int     `json:"y"`        // posição y em pixels (mundo)
    VX       float64 `json:"vx"`       // velocidade horizontal (px/s)
    VY       float64 `json:"vy"`       // velocidade vertical (px/s)
    HP       int     `json:"hp"`       // pontos de vida (0–100)
    Grounded bool    `json:"grounded"` // está no chão
    Facing   int     `json:"facing"`   // 1 = direita, -1 = esquerda
}

// apps/api/internal/game/projectile.go — estado sincronizado de um projétil
// (o servidor é dono do estado; o client apenas renderiza):
type ProjectileState struct {
    ID      string  `json:"id"`    // id do projétil (sequencial por servidor)
    Owner   string  `json:"owner"` // id do jogador que atirou
    X       int     `json:"x"`     // posição x em pixels (top-left da hitbox)
    Y       int     `json:"y"`     // posição y em pixels
    VX      float64 `json:"vx"`    // velocidade horizontal (px/s)
    VY      float64 `json:"vy"`    // velocidade vertical (px/s)
}
```

- Coordenadas em **pixels do mundo do jogo** (tile = 48 px; spawn inicial `X=96` = 2 tiles, `Y=480`).
- `HP` começa em `100`. Dano (inimigos de contato, −10 HP) é calculado no cliente e chega ao
  servidor apenas como valor refletido no próximo `state`.
- **Projéteis são autoritativos do servidor**: o client envia apenas a intenção de tiro
  (`shoot`); posição/velocidade/dono são simulados no servidor e broadcastados no campo
  `projectiles` da mensagem `players`.

## 3. Protocolo de mensagens

### 3.1 Formato geral

Toda mensagem é um **frame de texto JSON** cujo objeto contém ao menos o campo `type`
(string). Campos adicionais variam por tipo:

```json
{"type": "<nome>", ...}
```

### 3.2 Resumo

| Tipo | Direção | Quando | Campos |
|------|---------|--------|--------|
| `welcome` | servidor → cliente | na entrada de um jogador na sala (broadcast para **todos**) | `id`, `players` |
| `players` | servidor → cliente | broadcast periódico (~10 Hz) | `players`, `projectiles` |
| `player_leave` | servidor → cliente | quando um jogador desconecta | `id` |
| `player_join` | servidor → cliente | **não enviado pelo servidor** (ver nota) | `player` |
| `state` | cliente → servidor | envio contínuo do estado local (~10×/s) | `x`, `y`, `hp`, `facing` |
| `shoot` | cliente → servidor | intenção de tiro (borda de pressão) | — |

### 3.3 Servidor → Cliente

#### `welcome`

Enviada **para todos os clientes conectados** quando um jogador entra (inclusive para os que
já estavam conectados — o snapshot completo inclui o recém-chegado). É a primeira mensagem
que um cliente novo recebe e carrega seu próprio `id`.

```json
{
  "type": "welcome",
  "id": "a3f9c2d4e5b67890",
  "players": [
    {"x": 96, "y": 480, "hp": 100},
    {"x": 412, "y": 372, "hp": 80}
  ]
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | string | id da conexão recém-criada (16 hex). O cliente deve usá-lo para se distinguir na lista (`players`) e ignorar a própria entrada. |
| `players` | array | snapshot atual da sala: objetos `PlayerState` (`x`, `y`, `hp`) **sem** `id`. |

#### `players`

Broadcast periódico do estado de todos os jogadores (~10 Hz, ticker de 100 ms no servidor).

```json
{
  "type": "players",
  "players": [
    {"x": 96, "y": 480, "hp": 100},
    {"x": 412, "y": 372, "hp": 80}
  ],
  "projectiles": [
    {"id": "p7", "owner": "a3f9c2d4e5b67890", "x": 612, "y": 430, "vx": 560, "vy": 0}
  ]
}
```

> Nota: os itens de `players` **não carregam `id`**. Para correlacionar com `welcome`/`player_leave`,
> o client atual usa a ordem/posição relativa e seu próprio `id` para auto-exclusão. Se precisar
> rastrear jogadores individuais de forma confiável, trate a lista como um snapshot substituível
> (substitua a lista inteira a cada `players`).

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `players` | array | snapshot atual da sala: objetos `PlayerState` (`x`, `y`, `vx`, `vy`, `hp`, `grounded`, `facing`) **sem** `id` |
| `projectiles` | array | projéteis em voo: objetos `ProjectileState` (`id`, `owner`, `x`, `y`, `vx`, `vy`). Vazio quando não há tiros. **Autoritativo do servidor** — o client não envia posição de projétil. |

> O projétil some do `projectiles` quando colide (parede/chão/inimigo/borda do mundo) ou
> expira por tempo de vida. O client deve remover projéteis que deixarem de aparecer.

#### `player_leave`

Broadcast quando uma conexão é encerrada (desconexão, timeout de escrita, erro de leitura).

```json
{"type": "player_leave", "id": "a3f9c2d4e5b67890"}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | string | id do jogador que saiu |

#### `player_join` — nota

O client (`net.ts`) trata um tipo `player_join` com payload `{type, player: PlayerState}`,
**mas o servidor nunca envia essa mensagem hoje** (entrada de jogador só gera `welcome`
broadcast). Fica registrado como intenção/evolução futura; não depende dele.

### 3.4 Cliente → Servidor

#### `state`

Enviado continuamente pelo cliente (no client atual, a cada frame via `onUpdate`, na
prática ~10×/s). O servidor grava `x`, `y`, `hp` no registro do jogador na sala (e `facing`
quando presente); o próximo broadcast `players` reflete o novo estado.

```json
{"type": "state", "x": 412, "y": 372, "hp": 80, "facing": 1}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `type` | string | sim | deve ser exatamente `"state"` |
| `x` | int | sim | posição x em pixels |
| `y` | int | sim | posição y em pixels |
| `hp` | int | sim | vida atual (0–100) |
| `facing` | int | não | direção do jogador (1 = direita, -1 = esquerda). O servidor só atualiza quando o valor é ≠ 0 |

#### `shoot`

Intenção de tiro (borda de pressão — o client envia uma vez por aperto do botão de tiro).
O servidor **cria o projétil** de forma autoritativa na posição atual do jogador, na direção
do `facing` gravado; o client não envia posição/velocidade do projétil.

```json
{"type": "shoot"}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `type` | string | sim | deve ser exatamente `"shoot"` |

> O servidor não limita a cadência de tiro hoje (um `shoot` = um projétil). Limite de
> rate/fire é item futuro.

Mensagens recebidas com JSON inválido ou com `type` diferente de `"state"`/`"shoot"` são
**ignoradas** silenciosamente pelo servidor (`continue` no loop de leitura).

## 4. Fluxos importantes

### 4.1 Entrar no jogo

```
Cliente                          Servidor
   │  opens ws://host/api/ws        │
   ├───────────────────────────────►│  upgrade + gera id (16 hex)
   │                                │  room.AddPlayer(id) → spawn (96, 480, HP 100)
   │                                │  broadcast welcome {id, players}  → TODOS
   │◄───────────────────────────────┤
   │  (primeira msg; guarda msg.id) │
   │  envia state (x, y, hp) ~10×/s │
   ├───────────────────────────────►│
   │◄────────────── players (~10 Hz)┤  broadcast periódico
```

O cliente novo deve: conectar, receber `welcome`, guardar `id` (para se excluir da lista de
remotos), e começar a enviar `state`. Não há handshake de autenticação nem mensagem de
"join" explícita — **entrar = abrir a conexão WebSocket**.

### 4.2 Atualização de estado (ação/movimento)

Movimento continua **simulado localmente** no cliente e propagado como `state`
(a migração completa para física autoritativa do player está em andamento — `player.go`
existe no servidor mas o wiring no tick loop é de outra tarefa). O **tiro já é autoritativo**:

```
Cliente (aperta tiro) → shoot → Servidor cria projétil (posição/direção do facing gravado)
                        → simula voo a cada tick (20 tps) → colisão (parede/chão/inimigo/
                          borda) ou expiração remove o projétil
                        → broadcast players.projectiles → todos renderizam
```

Consequência prática: o servidor valida a trajetória do projétil contra o grid da fase e
reporta colisões pelo hook `OnHit` (dano ainda não aplicado — camada de HP é outra tarefa).

### 4.3 Saída de jogador

```
Cliente desconecta / WS fecha  →  Servidor: room.RemovePlayer(id) + broadcast player_leave {id} → demais clientes removem o jogador
```

### 4.4 Morte e respawn — NÃO implementados no protocolo

- Hoje a morte é **100% client-side**: `HP ≤ 0` → o jogador local é destruído e o HUD mostra
  *"Você morreu! Recarregue a página para reiniciar"*. **Não há mensagem de morte/respawn**
  no protocolo e **não há respawn automático** (reiniciar = recarregar a página).
- O `state` do jogador morto simplesmente deixa de ser enviado (o cliente foi destruído),
  então ele "congela" na última posição reportada para os demais até reconectar.
- **Planejado** (ver README): respawn e condição de derrota (squad wipe) ainda não existem.

### 4.5 Compra na loja — NÃO implementado

Não há código nem mensagem de loja em nenhuma camada (client ou servidor). É item planejado
(loja de upgrades com moedas entre fases) — **não implemente mensagens de shop contra este
servidor**; elas não existem.

## 5. Exemplo de cliente mínimo

Esboço funcional (TypeScript/browser, sem framework) cobrindo o ciclo completo:

```ts
const ws = new WebSocket(`ws://${location.host}/api/ws`);
let myId = "";

// estado local do jogador (simulado pelo cliente)
const me = { x: 96, y: 480, hp: 100 };

ws.onopen = () => {
  // após welcome, começa a mandar estado periodicamente
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "state", ...me }));
    }
  }, 100); // ~10×/s
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "welcome":
      myId = msg.id;                       // 1. guarda seu id
      renderPlayers(msg.players, myId);    // 2. desenha snapshot inicial
      break;
    case "players":
      renderPlayers(msg.players, myId);    // substitui a lista remota
      break;
    case "player_leave":
      removeRemote(msg.id);
      break;
  }
};

// players NÃO carrega id — usa o snapshot como lista substituível
function renderPlayers(list: {x:number;y:number;hp:number}[], selfId: string) {
  // desenha todos os itens; o próprio cliente se exclui pelo id do welcome
}

ws.onclose = () => setTimeout(connect, 2000); // reconexão a cada 2 s
```

Passos mínimos para um cliente válido:
1. Conectar em `ws(s)://host/api/ws`.
2. Receber `welcome` → guardar `id`.
3. Enviar `state` continuamente (x, y, hp atuais).
4. Renderizar `welcome.players` e `players` como lista substituível; remover por `id` em `player_leave`.

## 6. Arquitetura-alvo (planejada)

A arquitetura **alvo** do projeto (descrita no README como "Planejado") muda o papel do
servidor de *relay de estado* para **servidor autoritativo**. Nada nesta seção está
implementado no código atual — é o desenho de referência para a evolução do protocolo e
das regras do jogo.

### 6.1 Servidor autoritativo

- O servidor passa a **simular o jogo** (física, colisões, HP, moedas, inimigos) e os
  clientes enviam **intenções de entrada** (andar, pular, atirar) em vez da posição final.
- O servidor valida movimento e aplica dano/coleta; o cliente apenas renderiza o estado
  recebido e não decide o resultado de colisões.
- Consequência para o protocolo: o tipo `state` (cliente → servidor) seria substituído por
  uma mensagem de **ação/input**, e o servidor passaria a emitir o estado consolidado do
  mundo no broadcast.

### 6.2 Tick fixo de 20 tps

- Loop de simulação determinístico no servidor com **50 ms por tick (20 ticks/s)**.
- A cada tick o servidor: processa inputs, avança a simulação, aplica dano/coleta e emite
  o snapshot do mundo.
- Hoje o broadcast é de **~10 Hz** (ticker de 100 ms) apenas ecoando `state` do cliente —
  sem simulação.

### 6.3 Seed compartilhada de fase

- A geração procedural da fase recebe uma **seed única**, gerada pelo servidor e enviada
  aos clientes (ex.: no `welcome`), para que **todos vejam a mesma fase**.
- Hoje cada cliente gera a fase com `seed: Date.now()` local
  (`apps/web/src/main.ts` → `generateLevel`), então cada jogador vê uma fase diferente.
- O `LevelSpec` em `apps/web/src/levelgen.ts` já carrega `seed` no contrato; falta o
  servidor distribuir a seed e o client consumi-la.

### 6.4 Itens planejados derivados

- **Morte/respawn** — mensagem de morte e respawn coordenado pelo servidor (hoje é
  client-side: o HUD pede para recarregar a página).
- **Moedas** — coleta e economia de moedas por fase.
- **Loja** — gastar moedas em upgrades entre fases.
- **Squad wipe** — condição de derrota quando o time inteiro morre.

## 7. Referências no código

| Arquivo | Conteúdo |
|---------|----------|
| `apps/api/internal/game/messages.go` | construtores de `welcome`, `player_leave`, `players`, `WorldMsg` (players + projectiles) |
| `apps/api/internal/game/room.go` | `PlayerState` (x, y, vx, vy, hp, grounded, facing), sala, spawn inicial |
| `apps/api/internal/game/projectile.go` | `ProjectileSystem` autoritativo (Fire/Step/Snapshot), hook `OnHit`, tipos `ProjectileState`/`ProjectileHit`/`Enemy` |
| `apps/api/internal/game/player.go` | física do player no servidor (`PlayerBody` — wiring no loop é outra tarefa) |
| `apps/api/internal/ws/hub.go` | upgrade WS, loop de leitura (aceita `state` e `shoot`), broadcast, ping 30 s |
| `apps/api/internal/ws/id.go` | geração de id hex (16 chars) |
| `apps/api/cmd/server/main.go` | wiring hub↔sala↔projéteis, loop de simulação 20 tps (50 ms) com broadcast ~10 Hz, rotas `/api/health` e `/api/ws` |
| `apps/web/src/net.ts` | client de referência (envia `state`, consome `welcome`/`players`/`player_leave`) |
| `apps/web/src/levelgen.ts` | geração procedural de fase (`mulberry32`, seed local) |
