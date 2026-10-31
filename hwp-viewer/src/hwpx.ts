import { unzipSync, strFromU8 } from "fflate";

// HWPX = ZIP + XML. Contents/section*.xml 의 문단(p)·표(tbl)를 단순 HTML로 변환한다.
export function hwpxToHtml(data: Uint8Array): { html: string; text: string } {
  const files = unzipSync(data);
  const names = Object.keys(files)
    .filter((n) => /^Contents\/section\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.replace(/\D/g, "")) - parseInt(b.replace(/\D/g, "")));
  if (!names.length) throw new Error("HWPX 본문(section)을 찾지 못했습니다.");

  const lines: string[] = [];
  let html = "";

  const local = (n: Node) => (n as Element).localName;
  const textOf = (el: Element): string => {
    let s = "";
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 3) continue;
      const name = local(c);
      if (name === "t") s += c.textContent ?? "";
      else if (name === "tab") s += "\t";
      else if (name === "lineBreak") s += "\n";
      else if (name !== "tbl") s += textOf(c as Element);
    }
    return s;
  };

  const walk = (el: Element): string => {
    let out = "";
    for (const c of Array.from(el.children)) {
      const name = c.localName;
      if (name === "p") {
        const t = textOf(c);
        lines.push(t);
        out += `<p>${esc(t)}</p>`;
        for (const tbl of Array.from(c.getElementsByTagNameNS("*", "tbl"))) {
          if (closestP(tbl) === c) out += table(tbl);
        }
      } else out += walk(c);
    }
    return out;
  };

  const closestP = (el: Element) => {
    let p = el.parentElement;
    while (p && p.localName !== "p") p = p.parentElement;
    return p;
  };

  const table = (tbl: Element): string => {
    let out = "<table>";
    for (const tr of Array.from(tbl.children).filter((c) => c.localName === "tr")) {
      out += "<tr>";
      for (const tc of Array.from(tr.children).filter((c) => c.localName === "tc")) {
        const cell = Array.from(tc.getElementsByTagNameNS("*", "p")).map((p) => textOf(p)).join("\n");
        lines.push(cell);
        out += `<td>${esc(cell).replace(/\n/g, "<br>")}</td>`;
      }
      out += "</tr>";
    }
    return out + "</table>";
  };

  for (const n of names) {
    const doc = new DOMParser().parseFromString(strFromU8(files[n]), "application/xml");
    html += walk(doc.documentElement);
  }
  return { html, text: lines.join("\n") };
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
