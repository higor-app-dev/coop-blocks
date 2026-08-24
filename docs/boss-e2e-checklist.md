# Boss — Testes E2E e Checklist de Verificação

Cobre o acceptance do card t_da3717c8: o comportamento do boss ponta a
ponta (servidor → client), automatizado e/ou com verificação manual
documentada.

## Como rodar os testes automatizados

Servidor (Go, E2E real via httptest + WebSocket — a MESMA fiação do binário):

```sh
cd apps/api
go test -race ./cmd/server/ -run TestBossCicloVidaE2E -v
go test -race ./...          # suíte completa
```

Client (vitest — integração net → bossLayer → HUD):

```sh
cd apps/web
npx vitest run src/boss-e2e.test.ts
npx vitest run              # suíte completa
```

## Cobertura automatizada

| Cenário (acceptance) | Onde | O que prova |
|---|---|---|
| Boss aparece na 5ª fase, meio do mapa | `TestBossCicloVidaE2E` + `boss_test.go` | spawn em (2832, 384) — coluna central, chão — com HP 400/400, idle, phase 5 |
| Não aparece fora das fases múltiplas de 5 | `TestBossCicloVidaE2E` + `boss_test.go` | fases 1, 2, 3, 4 e 6 SEM boss no broadcast (campo `boss: null`) |
| Investida e salto causam dano | `TestBossCicloVidaE2E` (wiring) + `boss_test.go` (valores exatos) | jogador no raio do ataque tem o hit absorvido pelo escudo da loja (`shield_absorbed` exatamente na janela do ataque); dano exato: 25 (salto) e 20 (investida) |
| Ataques não travam o caminho | `TestBossCicloVidaE2E` | jogador atravessa a hitbox do boss VIVO (2600 → 3400) e, após a derrota, chega ao fim do mapa e avança para a fase 6 |
| Barra de HP aparece e some | `boss-e2e.test.ts` (client) + `hud.test.ts` | broadcast com boss → seção `[data-hud=boss]` visível com rótulo `👹 BOSS — Fase N`; dano → barra/número atualizam; `boss: null` → some |
| Drop de moedas ao derrotar | `TestBossCicloVidaE2E` + `boss_test.go` | +20 moedas na fileira do drop (Y ≈ 378, acima das moedas de chão) na posição da derrota |
| Avanço continua após a derrota | `TestBossCicloVidaE2E` | derrota → fim do mapa → loja abre → pronto → fase 6 começa normalmente |

Notas de determinismo (fase 5, seed 5, mapa 120×12):
- a sequência de ataques é salto → salto → investida (RNG mulberry32 da seed);
- o salto é VERTICAL (JumpSpeedH = 0 na config de produção): o boss sobe e
  aterrissa no mesmo X; o dano em área (raio 120 px dos pés) é o hit;
- a investida avança 552 px na direção do jogador mais próximo;
- os atiradores e7 (@2688) e e9 (@3696) são abatidos no início para isolar
  as janelas de dano do boss (são os únicos em alcance da zona de combate).

## Checklist de verificação manual (browser)

Rodar com `pnpm dev` (web em 5173 + API em 8080, ou o deploy de produção) e
jogar até a fase 5:

1. **Fases 1–4**: NENHUMA barra `👹 BOSS` no topo do HUD.
2. **Fase 5**: ao iniciar, o bloco gigante (vermelho) aparece no MEIO do
   mapa e a barra `👹 BOSS — Fase 5` surge no topo-centro com 400/400.
3. **Salto**: após ~4,5 s o boss pula no lugar; ao aterrissar, a barra fica
   laranja (`is-salto`) e um jogador na área (raio ~2,5 blocos dos pés)
   perde 25 de HP.
4. **Investida**: após ~16 s o boss avança em linha reta; a barra fica
   vermelho-vivo (`is-investida`) e o contato tira 20 de HP (com
   invulnerabilidade pós-contato de ~1,5 s).
5. **Atravessar**: o jogador passa POR DENTRO do bloco do boss (ele não é
   sólido) — o risco vem dos ataques, não da colisão.
6. **Derrubar**: 16 tiros (25 de dano cada) — a barra esvazia em tempo real
   e, ao zerar, o bloco e a barra SOMEM na hora.
7. **Drop**: no ponto da derrota surgem 20 moedas coletáveis.
8. **Avanço**: com o boss morto (ou até vivo), chegar ao fim do mapa abre a
   loja e a fase 6 começa sem boss.
9. **Fase 6+**: a barra do boss NÃO reaparece até a fase 10.
