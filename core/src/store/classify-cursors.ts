// Sınıflama aday rotasyonunun kalıcı imleci (yüzey başına bir tamsayı).
// Gerekçe ve adaletin ispatı: schema.sql'deki `classify_cursors` yorumu.

import type { Store } from "./db.ts";
import type { CandidateKind } from "../signals/contradiction.ts";
// Tip TEK yerde: sözleşmenin sahibi seçimi yapan modül, depo yalnız taşıyor.
import type { ClassifyCursors } from "../signals/classify.ts";

export type { ClassifyCursors };

export function readClassifyCursors(store: Store, projectId: number): ClassifyCursors {
  const rows = store.all<{ kind: string; next_index: number }>(
    "SELECT kind, next_index FROM classify_cursors WHERE project_id = ?",
    projectId,
  );
  const out: Partial<Record<CandidateKind, number>> = {};
  // Tanınmayan bir `kind` sessizce atlanıyor: yüzey adı değişirse eski satır
  // bir çöp anahtar olarak durur, seçimi bozmaz. Şemada CHECK yok, çünkü yüzey
  // listesi koda ait — kısıtı SQL'e kopyalamak iki kaynak demek olurdu.
  for (const r of rows) out[r.kind as CandidateKind] = r.next_index;
  return out;
}

/**
 * İmleçleri yazar. Çağıran tx'ine katılır (kendi tx'ini AÇMAZ): imleç, o koşumun
 * skorlarıyla aynı anda commit edilmeli — arada bir ölümde imleç ilerleyip
 * ölçüm yazılmasaydı, ilerleyen pencere hiç yazılmamış bir ölçümün üstünden
 * atlardı.
 */
export function writeClassifyCursors(
  store: Store, projectId: number, cursors: ClassifyCursors,
): void {
  for (const [kind, next] of Object.entries(cursors)) {
    if (typeof next !== "number" || !Number.isFinite(next)) continue;
    store.run(
      "INSERT INTO classify_cursors (project_id, kind, next_index) VALUES (?,?,?) " +
        "ON CONFLICT (project_id, kind) DO UPDATE SET next_index = excluded.next_index",
      projectId, kind, Math.max(0, Math.trunc(next)),
    );
  }
}
