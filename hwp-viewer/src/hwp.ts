import { parse } from "hwp.js";

// hwp.js 의 파싱 결과에서 일반 글자만 뽑아 본문 텍스트를 만든다 (표·도형 안의 글은 제외될 수 있음).
export function hwpToText(data: Uint8Array): string {
  const doc = parse(data, { type: "array" });
  const lines: string[] = [];
  for (const section of doc.sections) {
    for (const p of section.content) {
      let s = "";
      for (const ch of p.content) {
        if (ch.type === 0 && typeof ch.value === "string") s += ch.value;
      }
      lines.push(s);
    }
  }
  return lines.join("\n");
}
