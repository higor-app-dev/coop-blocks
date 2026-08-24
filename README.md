# Coop Blocks 🧱

Jogo de plataforma **coop multiplayer** estilo Mario, com **geração automática de fases**.
Cada fase é gerada proceduralmente (chão com buracos, plataformas suspensas e spawns de inimigos)
e os jogadores se veem em tempo real via WebSocket — abra duas abas no navegador para jogar junto.

## Stack (monorepo Turborepo + pnpm)

| App | Linguagem / Framework | Descrição |
|-----|----------------------|-----------|
| `apps/web` | TypeScript + **Vite** + **KaplayJS** | Game client: player com pulo e tiro, inimigos de contato (dano), HP 100, geração procedural de fases |
| `apps/api` | **Go 1.22** + `gorilla/websocket` | Servidor multiplayer: WebSocket, salas, broadcast do estado dos jogadores (~10 Hz) |

Orquestração: **Turborepo** (`turbo dev`/`build`/`lint`/`test`) com **pnpm** como gerenciador de pacotes.
O Vite serve o client em `:5173` e faz proxy de `/api/*` (incluindo WebSocket) para a API Go em `:8080`.

## Pré-requisitos

- **Node.js >= 22** (usado pelo Vite; o projeto declara `engines.node >= 22`)
- **pnpm** (recomendado via `corepack enable` — o repo fixa `pnpm@11.23.0` via `packageManager`)
- **Go >= 1.22** (para o servidor da API)

## Como rodar local

Instale as dependências uma vez:

```bash
pnpm install
```

Sobe o client web (Vite, watch mode) com o Turborepo:

```bash
turbo dev
```

> `turbo dev` executa o script `dev` de todos os apps que têm `package.json` — hoje só o `@coop-blocks/web`, que sobe o Vite em **http://localhost:5173**.

Em **outro terminal**, suba a API Go (a API ainda não é gerenciada pelo turbo — não há `package.json` em `apps/api`):

```bash
cd apps/api
go run ./cmd/server
```

A API escuta em `:8080` (configurável via env `API_ADDR`) e expõe `GET /api/health` e o WebSocket `GET /api/ws`.

Pronto. Abra **http://localhost:5173** — abra duas abas para ver o multiplayer.

## Controles

| Tecla | Ação |
|-------|------|
| ← / → | Mover |
| Espaço | Pular |
| X | Atirar |

## Regras do jogo (estado atual)

- **HP**: o jogador começa com **100 HP** (HUD no topo da tela).
- **Dano**: inimigos são de contato — ao relar num inimigo, o jogador perde **10 HP** por colisão.
- **Morte**: com **HP ≤ 0** o jogador morre (some da fase). **Respawn automático ainda não existe** —
  o HUD mostra *"Você morreu! Recarregue a página para reiniciar"*; recarregue para recomeçar.
- **Multiplayer**: posições e HP de todos os jogadores são sincronizados pelo servidor via WebSocket
  (broadcast ~10×/s). Se o servidor estiver fora do ar, o client tenta reconectar a cada 2 s.

### Planejado (não implementado ainda)

As mecânicas abaixo estão no escopo do projeto, mas **não existem no código atual**:

- **Moedas** — coleta e economia de moedas por fase.
- **Squad wipe** — condição de derrota quando o time inteiro morre.
- **Loja** — gastar moedas em upgrades entre fases.
- **Respawn** — renascer após a morte (hoje é recarregar a página).
- **Servidor autoritativo** com tick fixo (20 tps) e seed compartilhada de fase.

## Estrutura

```
coop-blocks/
├── apps/
│   ├── web/          # KaplayJS + Vite + TypeScript
│   │   └── src/
│   │       ├── main.ts      # bootstrap, controles, câmera, colisões
│   │       ├── player.ts    # pulo, tiro, HP
│   │       ├── enemies.ts   # inimigo de contato (patrulha)
│   │       ├── levelgen.ts  # geração procedural de fases (mulberry32)
│   │       └── net.ts       # cliente WebSocket
│   └── api/          # Go: servidor WebSocket multiplayer
│       ├── cmd/server/     # main.go — HTTP + roteamento + broadcast
│       └── internal/
│           ├── game/       # salas, estado dos jogadores, mensagens
│           └── ws/         # hub WebSocket (clients, leitura/escrita)
└── packages/         # (futuro: tipos compartilhados)
```

## Scripts

| Comando | O que faz |
|---------|-----------|
| `pnpm install` | Instala dependências de todos os apps |
| `turbo dev` | Sobe o Vite (web) em watch mode — http://localhost:5173 |
| `turbo build` | Build de produção (Vite) |
| `go run ./cmd/server` | Sobe a API Go em :8080 (rodar em `apps/api`) |
