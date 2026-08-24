# Coop Blocks 🧱

Jogo de plataforma **coop multiplayer** estilo Mario, com **geração automática de fases**.

## Stack (monorepo Turborepo)

| App | Stack | Descrição |
|-----|-------|-----------|
| `apps/web` | Vite + **KaplayJS** + TypeScript | Game client: player com pulo e tiro, inimigos de contato (dano), HP 100, geração procedural de fases |
| `apps/api` | **Go** | Servidor multiplayer: WebSocket, salas, estado dos jogadores |

## Requisitos

- Node.js >= 22 + pnpm
- Go >= 1.22

## Como rodar

```bash
# instala deps de todos os apps
pnpm install

# sobe API (Go, porta 8080) + web (Vite, porta 5173) em paralelo
pnpm dev
```

Acesse http://localhost:5173 — abra duas abas para ver o multiplayer.

## Estrutura

```
coop-blocks/
├── apps/
│   ├── web/          # KaplayJS + Vite
│   │   └── src/
│   │       ├── main.ts      # bootstrap, controles, câmera
│   │       ├── player.ts    # pulo, tiro, HP
│   │       ├── enemies.ts   # inimigo de contato (patrulha)
│   │       ├── levelgen.ts  # geração procedural de fases
│   │       └── net.ts       # cliente WebSocket
│   └── api/          # Go multiplayer server
└── packages/         # (futuro: tipos compartilhados)
```

## Mecânicas atuais

- Player: move (←/→), pula (espaço), tira (X)
- HP total: 100 — inimigo de contato causa dano
- Inimigos: patrulham e invertem ao bater em paredes
- Fases: geradas proceduralmente (chão com buracos, plataformas, spawns) com seed
- Multiplayer: WebSocket (posições + HP broadcast)
