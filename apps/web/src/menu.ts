/**
 * Menu inicial do jogo — roteamento Solo / Multijogador.
 *
 * Overlay DOM (mesmo padrão do shop.ts/hud.ts): duas opções grandes no
 * centro da tela. O main.ts decide o que acontece em cada escolha:
 *   - "Jogar Solo (offline)": roda o motor solo (solo.ts) — NENHUM WebSocket,
 *     nenhuma chamada à API; o jogo abre e funciona mesmo com o backend Go
 *     desligado ou hospedado em hosting estático.
 *   - "Multijogador (salas)": conecta ao servidor (connectToServer) e segue o
 *     fluxo de salas (lobby HTTP + WebSocket autoritativo a 20 tps).
 *
 * O menu também expõe um atalho de teclado (Enter = Solo, M = Multijogador)
 * e esconde o conteúdo até a escolha — nada do jogo roda atrás do overlay.
 */

export type MenuChoice = "solo" | "multiplayer";

export interface MenuOpts {
  /** Raiz onde o overlay é anexado (default document.body). */
  root?: HTMLElement;
  /** Chamado quando o jogador escolhe uma das opções. */
  onSelect: (choice: MenuChoice) => void;
}

export interface MenuHandle {
  /** Elemento raiz do overlay (para inspeção em testes/smoke). */
  el: HTMLElement;
  /** Mostra o menu (remove o atributo hidden). */
  show(): void;
  /** Esconde o menu (seta hidden) — chamado após a escolha. */
  hide(): void;
  /** Simula o clique numa opção (usado por testes). */
  select(choice: MenuChoice): void;
}

export function createMenu(opts: MenuOpts): MenuHandle {
  const root = opts.root ?? document.body;

  const el = document.createElement("div");
  el.className = "menu-root";
  el.style.cssText =
    "position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:28px;background:" +
    "radial-gradient(circle at 50% 40%, rgba(30,34,58,0.96), rgba(10,10,22,0.99));" +
    "font-family:monospace;color:#e8ecf8;user-select:none;";

  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = "COOP BLOCKS";
  title.style.cssText = "font-size:52px;font-weight:800;letter-spacing:6px;color:#e8ecf8;text-shadow:0 0 24px rgba(66,200,245,0.6);";

  const subtitle = document.createElement("div");
  subtitle.className = "menu-subtitle";
  subtitle.textContent = "modo solo (offline) ou multijogador";
  subtitle.style.cssText = "font-size:14px;color:#9aa4c2;letter-spacing:1px;";

  const buttons = document.createElement("div");
  buttons.className = "menu-buttons";
  buttons.style.cssText = "display:flex;flex-direction:column;gap:14px;min-width:280px;";

  function makeButton(label: string, hint: string, choice: MenuChoice): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `menu-btn menu-btn-${choice}`;
    btn.dataset.choice = choice;
    btn.style.cssText =
      "font:700 17px monospace;color:#fff;background:rgba(40,48,86,0.9);" +
      "border:2px solid rgba(120,200,255,0.45);border-radius:10px;padding:16px 20px;" +
      "cursor:pointer;display:flex;flex-direction:column;gap:4px;align-items:center;transition:transform .08s, border-color .08s;";
    btn.innerHTML = `<span>${label}</span><span style="font-size:11px;font-weight:400;color:#9aa4c2;">${hint}</span>`;
    btn.addEventListener("mouseenter", () => {
      btn.style.borderColor = "rgba(120,200,255,0.95)";
      btn.style.transform = "scale(1.02)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.borderColor = "rgba(120,200,255,0.45)";
      btn.style.transform = "scale(1)";
    });
    btn.addEventListener("click", () => {
      opts.onSelect(choice);
    });
    return btn;
  }

  const soloBtn = makeButton("🎮 Jogar Solo (offline)", "sem servidor — 100% local", "solo");
  const mpBtn = makeButton("🌐 Multijogador (salas)", "servidor autoritativo — 20 tps", "multiplayer");
  buttons.append(soloBtn, mpBtn);

  const footer = document.createElement("div");
  footer.className = "menu-footer";
  footer.textContent = "Enter = Solo · M = Multijogador";
  footer.style.cssText = "font-size:11px;color:#6a7394;letter-spacing:1px;";

  el.append(title, subtitle, buttons, footer);
  root.appendChild(el);

  // Atalhos de teclado: Enter → Solo, M → Multijogador (só quando visível).
  const onKey = (ev: KeyboardEvent) => {
    if (el.hidden) return;
    if (ev.key === "Enter") {
      opts.onSelect("solo");
    } else if (ev.key.toLowerCase() === "m") {
      opts.onSelect("multiplayer");
    }
  };
  window.addEventListener("keydown", onKey);

  return {
    el,
    show: () => {
      el.hidden = false;
      // ⚠️ hidden NÃO vence `display:flex` inline (cssText acima) — precisa
      // limpar o display também, senão o overlay continua visível e parece
      // que "nada acontece" ao escolher (o jogo roda atrás do menu).
      el.style.display = "";
    },
    hide: () => {
      el.hidden = true;
      el.style.display = "none";
    },
    select: (choice: MenuChoice) => opts.onSelect(choice),
  };
}
