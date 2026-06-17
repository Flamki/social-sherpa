import type { Connection } from "./connections.types";

// LinkedIn Connections.csv columns: First Name, Last Name, URL, Email Address, Company, Position, Connected On
// We tolerate extra preamble lines that LinkedIn sometimes adds.
export function parseLinkedInCsv(text: string): Connection[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => /first name/i.test(l) && /last name/i.test(l));
  if (headerIdx === -1) return [];
  const rows = lines.slice(headerIdx).map(parseCsvRow);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h === name);
  const iFirst = idx("first name"),
    iLast = idx("last name"),
    iUrl = idx("url"),
    iEmail = idx("email address"),
    iCompany = idx("company"),
    iPosition = idx("position");
  const out: Connection[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[iFirst]) continue;
    const name = `${r[iFirst] ?? ""} ${r[iLast] ?? ""}`.trim();
    const headline = r[iPosition] ?? "";
    const company = r[iCompany] ?? "";
    const profileUrl = iUrl >= 0 ? r[iUrl]?.trim() : "";
    const email = iEmail >= 0 ? r[iEmail]?.trim() : "";
    if (!name) continue;
    const tagSrc = `${headline} ${company}`.toLowerCase();
    const tags = Array.from(
      new Set(tagSrc.split(/[\s,/&|-]+/).filter((t) => t.length > 2 && !STOP.has(t))),
    ).slice(0, 8);
    out.push({
      id: `csv-${i}`,
      name,
      headline,
      company,
      location: "",
      tags,
      profileUrl: profileUrl || undefined,
      email: email || undefined,
    });
  }
  return out;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "over",
  "under",
  "inc",
  "llc",
  "ltd",
  "pvt",
  "pte",
  "corp",
  "gmbh",
  "plc",
  "co",
  "at",
  "of",
  "in",
  "on",
  "to",
  "by",
  "or",
]);

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}
