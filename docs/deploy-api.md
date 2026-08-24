# Deploy — Go API (coop-blocks) no VPS OCI ARM64

Deploy feito em 2026-08-24 (task kanban t_02ad9914). Alvo: VPS OCI free tier
`137.131.181.91` (hostname `free-tier-arm`, Ubuntu 24.04.4 LTS, aarch64).

## Estado da infra (verificado antes do deploy)

- **Dokploy / Docker: NÃO ativos.** Existe `/etc/dokploy` (config órfã) e socket
  `/var/run/docker.sock` órfão, mas não há `dockerd`/`containerd` rodando nem CLI
  `docker` instalado. Portas 80/443 são servidas por **nginx** (site `ollama`).
- Ollama roda nativo via systemd (`ollama.service`, porta 11434).
- Por isso o deploy usa **systemd** (não Dokploy).

## Arquivos no servidor

| Path | Conteúdo |
|---|---|
| `/opt/game-api/game-api-arm64` | binário Go estático linux/arm64 (owner `game-api:game-api`, 755) |
| `/opt/game-api/.env` | env file (owner `game-api`, 640) |
| `/etc/systemd/system/game-api.service` | unit do serviço |

User dedicado: `game-api` (system user, sem shell).

## Env file — /opt/game-api/.env

```
API_ADDR=:8080
```

## Unit — /etc/systemd/system/game-api.service

```ini
[Unit]
Description=coop-blocks game API (Go, WebSocket)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=game-api
Group=game-api
WorkingDirectory=/opt/game-api
EnvironmentFile=/opt/game-api/.env
ExecStart=/opt/game-api/game-api-arm64
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

## Comandos de deploy (a partir de qualquer máquina com a key ~/.oci/free-tier-ssh-key)

```bash
KEY=~/.oci/free-tier-ssh-key
H=ubuntu@137.131.181.91

# 1. subir binário (cross-compilado: GOOS=linux GOARCH=arm64 CGO_ENABLED=0)
scp -i $KEY artifacts/api/game-api-arm64 $H:/tmp/game-api-arm64

# 2. instalar + env + usuário
ssh -i $KEY $H 'sudo useradd --system --no-create-home --shell /usr/sbin/nologin game-api || true
sudo mkdir -p /opt/game-api
sudo mv /tmp/game-api-arm64 /opt/game-api/game-api-arm64
sudo chown -R game-api:game-api /opt/game-api
sudo chmod 755 /opt/game-api/game-api-arm64
printf "API_ADDR=:8080\n" | sudo tee /opt/game-api/.env >/dev/null
sudo chown game-api:game-api /opt/game-api/.env && sudo chmod 640 /opt/game-api/.env'

# 3. unit + enable + start (unit acima em /tmp/game-api.service)
ssh -i $KEY $H 'sudo install -m 644 /tmp/game-api.service /etc/systemd/system/game-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now game-api'

# 4. verificação
curl -s http://localhost:8080/api/health            # → {"status":"ok"}
curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
     http://localhost:8080/api/ws                    # → HTTP/1.1 101 Switching Protocols
```

## Rotas reais do servidor

O binário serve **com prefixo `/api`** (source: `apps/api/cmd/server/main.go`):

- `GET /api/health` → `200 {"status":"ok"}`
- `GET /api/ws` → upgrade WebSocket (HTTP 101), mensagens `welcome`/`players` (~10 Hz)

`/health` e `/ws` sem prefixo retornam 404 — o frontend deve usar `VITE_API_URL`/
proxy apontando para `/api`.

## Verificações executadas (evidência)

- `sha256sum /opt/game-api/game-api-arm64` = `3b0278cc…22b0bc` (bate com SHA256SUMS do build t_35dae4ac).
- `systemctl is-enabled game-api` → `enabled`; `systemctl is-active` → `active`.
- `curl http://localhost:8080/api/health` → `200 {"status":"ok"}`.
- Handshake WS em `/api/ws` → `HTTP/1.1 101 Switching Protocols`.
- **Reboot real** (`sudo systemctl reboot`) → após boot: `game-api` active,
  health 200, WS 101, ollama e nginx também voltaram. Serviço sobrevive a reboot.

## Operações úteis

```bash
sudo systemctl restart game-api     # restart
sudo systemctl stop game-api        # parar
journalctl -u game-api -f           # logs
```

## Notas

- A task original citava `curl http://localhost:8080/health` e `ws://…/ws`, mas o
  servidor expõe `/api/health` e `/api/ws` (confirmado no source e no doc
  `docs/protocolo.md`). Health e WS estão OK nas rotas reais.
- Não há firewall UFW configurado (oci security list controla acesso externo);
  porta 8080 está escutando em `*`.
