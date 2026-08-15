// Çelişki adaylığının mekanik ön elemesi — üç yüzey (M0-D3), üçünde de saha
// örneği var. Saf fonksiyon: pahalı katman (Codex sınıflaması) yalnız buradan
// çıkan adayları görür (spec §3.4: LLM'siz olan her şey LLM'siz).

import type { Anchor } from "../types.ts";

export interface NoteView {
  findingId: number;
  content: string;
  anchors: Anchor[];
  /** İmported notun frontmatter description'ı; observed bulguda null. */
  description: string | null;
  hasStatus: boolean;
}

/**
 * `coverage` bu dosyada ÜRETİLMİYOR (bkz. signals/coverage.ts): çelişki yüzeyi
 * değil, hiçbir sinyalin dokunmadığı notu sıraya sokan rotasyon yüzeyi. Kind
 * birliğinde durmasının sebebi aynı bütçeyi ve aynı damga mekanizmasını
 * paylaşması — ikinci bir seçim mekanizması kurmamak için.
 */
export type CandidateKind = "cross" | "intra" | "frontmatter" | "coverage";

export interface Candidate {
  kind: CandidateKind;
  aId: number;
  /** intra/frontmatter tek notluk: bId null. */
  bId: number | null;
  reason: string;
}

/** Bundan çok notta geçen çapa ayırt edici değil (ör. herkesin andığı README) —
 *  çift patlaması hem maliyet hem gürültü olur. Atlanan çapa SAYILIR. */
export const MAX_NOTES_PER_ANCHOR = 4;

/**
 * Çapa değerinin reason'a giren teşhis etiketi. Çapa uzunluğu sınırsız (ölçüldü:
 * 200.007 karakterlik bir yol çapası) ve reason iki yere birden akıyor —
 * sınıflama prompt'u ve denetim olayı (audit.ts: contradiction_confirmed,
 * signal_scored detayı). Sınır bu yüzden üretim yerinde: kırpma yalnız prompt'ta
 * olsaydı depo yine 200 bin karakterlik olay detayları taşırdı. Bir çapayı
 * insanın tanımasına 120 karakter yetiyor; eşleşme kararı zaten tam değerle
 * verildi, etiket yalnız onu anlatıyor.
 */
const MAX_LABEL_CHARS = 120;

export function findCandidates(notes: NoteView[]): { candidates: Candidate[]; skippedAnchors: number } {
  const candidates: Candidate[] = [];
  let skippedAnchors = 0;

  // (a) çapraz: aynı (kind,value) çapayı paylaşan çiftler.
  const byAnchor = new Map<string, { label: string; ids: number[] }>();
  for (const n of notes) {
    for (const a of n.anchors) {
      // Ayraç NUL: değer içinde geçemeyeceği için (kind,value) çifti tek anahtara
      // çakışmasız iner. Kaynakta ham bayt değil kaçış dizisi — ham NUL dosyayı
      // git'e binary gösterip diff'i körleştiriyor (bu repoda ölçüldü).
      const key = `${a.kind}\u0000${a.value}`;
      const label = a.value.length > MAX_LABEL_CHARS ? a.value.slice(0, MAX_LABEL_CHARS) + "…" : a.value;
      const e = byAnchor.get(key) ?? { label, ids: [] };
      if (!e.ids.includes(n.findingId)) e.ids.push(n.findingId);
      byAnchor.set(key, e);
    }
  }
  const seenPair = new Set<string>();
  for (const { label, ids } of byAnchor.values()) {
    if (ids.length < 2) continue;
    if (ids.length > MAX_NOTES_PER_ANCHOR) { skippedAnchors++; continue; }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pk = `${ids[i]}:${ids[j]}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        candidates.push({ kind: "cross", aId: ids[i]!, bId: ids[j]!, reason: `ortak çapa: ${label}` });
      }
    }
  }

  // (b) not içi: akış-durumu kalıbı taşıyan not kendi içinde çelişmeye aday
  //     (M0: bekleyen-isler satır 117 vs 156; kritik-acik üst vs alt blok).
  // (c) frontmatter ↔ gövde: en sinsi yüzey — indeksten okuyan ajan yalnız
  //     description'ı görür (M0: teslim-yolu-denetimi).
  for (const n of notes) {
    if (n.hasStatus) candidates.push({ kind: "intra", aId: n.findingId, bId: null, reason: "akış-durumu kalıbı" });
    if (n.description !== null && n.description !== "")
      candidates.push({ kind: "frontmatter", aId: n.findingId, bId: null, reason: "description ↔ gövde" });
  }

  return { candidates, skippedAnchors };
}
