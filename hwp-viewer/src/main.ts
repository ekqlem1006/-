import "./style.css";
import { Viewer } from "hwp.js";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { hwpToText } from "./hwp";
import { hwpxToHtml } from "./hwpx";
import { saveDocx, saveTxt } from "./export";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $("view");
const nameEl = $("name");
const modeBtn = $<HTMLButtonElement>("mode");
const txtBtn = $<HTMLButtonElement>("txt");
const docxBtn = $<HTMLButtonElement>("docx");

let baseName = "문서";
let text = "";
let editing = false;
let viewerEl: HTMLElement | null = null;
let editor: HTMLTextAreaElement | null = null;

const currentText = () => (editing && editor ? editor.value : text);

function showError(e: unknown) {
  view.innerHTML = `<p class="err">열 수 없는 파일입니다: ${e instanceof Error ? e.message : String(e)}</p>`;
}

async function openData(name: string, data: Uint8Array) {
  baseName = name.replace(/\.[^.]+$/, "");
  nameEl.textContent = name;
  editing = false;
  modeBtn.textContent = "텍스트 편집";
  view.innerHTML = "";
  try {
    if (/\.hwpx$/i.test(name)) {
      const r = hwpxToHtml(data);
      text = r.text;
      view.innerHTML = `<div class="doc">${r.html}</div>`;
    } else {
      text = hwpToText(data);
      const host = document.createElement("div");
      view.appendChild(host);
      new Viewer(host, data, { type: "array" });
    }
    viewerEl = view.firstElementChild as HTMLElement;
    [modeBtn, txtBtn, docxBtn].forEach((b) => (b.hidden = false));
  } catch (e) {
    [modeBtn, txtBtn, docxBtn].forEach((b) => (b.hidden = true));
    showError(e);
  }
}

$<HTMLInputElement>("file").addEventListener("change", async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) await openData(f.name, new Uint8Array(await f.arrayBuffer()));
});

modeBtn.addEventListener("click", () => {
  if (!editing) {
    editor = document.createElement("textarea");
    editor.id = "editor";
    editor.value = text;
    view.replaceChildren(editor);
    editing = true;
    modeBtn.textContent = "보기로 돌아가기";
  } else {
    text = editor!.value;
    editing = false;
    modeBtn.textContent = "텍스트 편집";
    view.replaceChildren(viewerEl!);
    nameEl.textContent += " (수정한 내용은 보기 화면에 반영되지 않음)";
  }
});
txtBtn.addEventListener("click", () => saveTxt(baseName, currentText()));
docxBtn.addEventListener("click", () => saveDocx(baseName, currentText()));

// 안드로이드에서 "연결 프로그램"으로 파일을 열었을 때
if (Capacitor.isNativePlatform()) {
  App.addListener("appUrlOpen", async ({ url }) => {
    try {
      const res = await fetch(Capacitor.convertFileSrc(url));
      const name = decodeURIComponent(url.split("/").pop() ?? "문서.hwp");
      await openData(/\.hwpx?$/i.test(name) ? name : name + ".hwp", new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      showError(e);
    }
  });
}
