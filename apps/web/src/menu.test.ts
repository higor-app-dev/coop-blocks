import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMenu } from "./menu";

// ===== Fake DOM mínimo (padrão do shop.test.ts) =====
// O menu só usa document.createElement + body.appendChild + style/classList
// + addEventListener (click) + window.addEventListener (keydown).

type FakeEl = any;

function fakeDoc() {
  const els: FakeEl[] = [];
  const mk = () => {
    const el: FakeEl = {
      style: {},
      dataset: {},
      hidden: false,
      className: "",
      textContent: "",
      innerHTML: "",
      type: "",
      children: [],
      listeners: {} as Record<string, Array<(ev: any) => void>>,
      appendChild(c: FakeEl) {
        el.children.push(c);
      },
      append(...cs: FakeEl[]) {
        el.children.push(...cs);
      },
      setAttribute(_k: string, _v: string) {},
      addEventListener(type: string, fn: (ev: any) => void) {
        (el.listeners[type] ||= []).push(fn);
      },
      dispatchEvent(ev: any) {
        (el.listeners[ev.type] || []).forEach((fn: (ev: any) => void) => fn(ev));
        return true;
      },
      click() {
        (el.listeners["click"] || []).forEach((fn: (ev: any) => void) => fn({}));
      },
      querySelector(_sel: string) {
        return null;
      },
    };
    els.push(el);
    return el;
  };
  const body = mk();
  return {
    doc: {
      body,
      createElement: mk,
      createTextNode: (t: string) => ({ textContent: t }),
    },
    els,
  };
}

let doc: ReturnType<typeof fakeDoc>;
let keyListener: ((ev: KeyboardEvent) => void) | null = null;

beforeEach(() => {
  doc = fakeDoc();
  keyListener = null;
  vi.stubGlobal("document", doc.doc);
  vi.stubGlobal("window", {
    addEventListener: (_type: string, fn: (ev: KeyboardEvent) => void) => {
      keyListener = fn;
    },
    dispatchEvent: (ev: KeyboardEvent) => {
      keyListener?.(ev);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function findByClass(cls: string): FakeEl {
  return doc.els.find((e) => e.className.includes(cls));
}

// ===== Menu =====

describe("createMenu", () => {
  it("anexa o overlay com as duas opções (solo e multiplayer)", () => {
    const onSelect = vi.fn();
    const menu = createMenu({ root: doc.doc.body, onSelect });
    expect(doc.doc.body.children).toContain(menu.el);
    expect(findByClass("menu-btn-solo")).toBeTruthy();
    expect(findByClass("menu-btn-multiplayer")).toBeTruthy();
  });

  it("começa visível e hide()/show() alternam a visibilidade (hidden + display)", () => {
    const menu = createMenu({ root: doc.doc.body, onSelect: vi.fn() });
    expect(menu.el.hidden).toBe(false);
    // ⚠️ regression: o menu tem display:flex inline no cssText — o atributo
    // hidden NÃO vence CSS inline; hide() precisa setar display:none senão o
    // overlay continua na tela (o jogo roda atrás e parece que nada acontece).
    menu.hide();
    expect(menu.el.hidden).toBe(true);
    expect(menu.el.style.display).toBe("none");
    menu.show();
    expect(menu.el.hidden).toBe(false);
    expect(menu.el.style.display).toBe("");
  });

  it("clique em 'Jogar Solo' chama onSelect('solo')", () => {
    const onSelect = vi.fn();
    createMenu({ root: doc.doc.body, onSelect });
    findByClass("menu-btn-solo").click();
    expect(onSelect).toHaveBeenCalledWith("solo");
  });

  it("clique em 'Multijogador' chama onSelect('multiplayer')", () => {
    const onSelect = vi.fn();
    createMenu({ root: doc.doc.body, onSelect });
    findByClass("menu-btn-multiplayer").click();
    expect(onSelect).toHaveBeenCalledWith("multiplayer");
  });

  it("select('solo') dispara a escolha programaticamente", () => {
    const onSelect = vi.fn();
    const menu = createMenu({ root: doc.doc.body, onSelect });
    menu.select("solo");
    expect(onSelect).toHaveBeenCalledWith("solo");
  });

  it("Enter escolhe solo e M escolhe multiplayer (só com o menu visível)", () => {
    const onSelect = vi.fn();
    const menu = createMenu({ root: doc.doc.body, onSelect });

    keyListener?.({ key: "Enter" } as KeyboardEvent);
    expect(onSelect).toHaveBeenCalledWith("solo");

    menu.hide();
    keyListener?.({ key: "m" } as KeyboardEvent);
    // Escondido: o atalho não dispara — a última chamada continua "solo".
    expect(onSelect).toHaveBeenLastCalledWith("solo");
  });

  it("teclado com menu visível: M escolhe multiplayer", () => {
    const onSelect = vi.fn();
    createMenu({ root: doc.doc.body, onSelect });
    keyListener?.({ key: "m" } as KeyboardEvent);
    expect(onSelect).toHaveBeenCalledWith("multiplayer");
  });
});
