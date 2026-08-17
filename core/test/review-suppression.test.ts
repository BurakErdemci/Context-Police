// Rejection suppression (design §5): a rejected (finding, reason) pair does not
// come back to the queue while its evidence is unchanged. Nothing is deleted —
// the duplicate is simply never produced, and the non-production is an event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store/db.ts";
import { appendFinding } from "../src/store/findings.ts";
import { listEvents, countEvents } from "../src/store/events.ts";
import {
  recordVerdict, reviewVerdict, getLiveVerdict, listVerdictHistory, listPendingVerdicts,
  computeEvidenceFingerprint, findLastRejected, verdictReason,
} from "../src/store/verdicts.ts";

function seed() {
  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(store, {
    projectId, source: "imported", content: "DURUM: eski", sourceRef: "n.md",
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  });
  return { store, projectId, findingId };
}

const DECAYED = { verdict: "curuk" as const, decayType: "dosya-silindi", evidence: "src/a.ts silinmiş (sha abc)" };

/** The verdict that withdraws DECAYED without the user seeing anything. */
const CLEARED = {
  verdict: "olculemez" as const, subReason: "anchor-evidence-cleared",
  evidence: "önceki hükmün çapa kanıtı bu ölçümde yok",
};

test("parmak izi deterministik: aynı girdi aynı hash, alan sırası ve çapa sırası fark etmez", () => {
  const a = computeEvidenceFingerprint({
    reason: "curuk|dosya-silindi", claimText: "kanıt", anchorStates: ["missing_now", "present"],
  });
  const b = computeEvidenceFingerprint({
    anchorStates: ["present", "missing_now"], claimText: "kanıt", reason: "curuk|dosya-silindi",
  });
  assert.equal(a, b, "girdi alanlarının/çapa durumlarının sırası hash'i değiştiriyor");
  assert.match(a, /^[0-9a-f]{64}$/, "sha256 hex bekleniyor");
  assert.notEqual(
    a,
    computeEvidenceFingerprint({ reason: "curuk|dosya-silindi", claimText: "başka kanıt" }),
    "kanıt değişti, parmak izi değişmedi",
  );
  assert.notEqual(
    computeEvidenceFingerprint({ reason: "a", claimText: "bc" }),
    computeEvidenceFingerprint({ reason: "ab", claimText: "c" }),
    "alan sınırı belirsiz: bitişik alanlar aynı hash'e düşüyor",
  );
});

test("hüküm satırı kendi kanıt parmak izini taşıyor", () => {
  const { store, projectId, findingId } = seed();
  const { id } = recordVerdict(store, { projectId, findingId, ...DECAYED, source: "mechanical", runId: "r1" });
  const v = listVerdictHistory(store, findingId).find((r) => r.id === id)!;
  assert.equal(
    v.evidenceFingerprint,
    computeEvidenceFingerprint({ reason: verdictReason(v), claimText: DECAYED.evidence }),
    "yaratmada parmak izi yazılmadı: bastırma hiç ısıramaz",
  );
  store.close();
});

/**
 * The real shape of the bug: the rejected verdict is no longer live (a later
 * measurement withdrew it), so `sameConclusion` — which only ever looks at the
 * live row — does not catch the re-run and the same complaint is queued again.
 */
function rejectedThenWithdrawn() {
  const s = seed();
  const first = recordVerdict(s.store, { ...s, ...DECAYED, source: "mechanical", runId: "r1" });
  assert.equal(reviewVerdict(s.store, first.id, "rejected"), true);
  recordVerdict(s.store, { ...s, ...CLEARED, source: "mechanical", runId: "r2" });
  return { ...s, rejectedId: first.id };
}

test("aynı parmak iziyle dönen hüküm yaratılmaz, verdict_suppressed düşer", () => {
  const { store, projectId, findingId, rejectedId } = rejectedThenWithdrawn();
  const before = listVerdictHistory(store, findingId).length;

  const again = recordVerdict(store, { projectId, findingId, ...DECAYED, source: "mechanical", runId: "r3" });

  assert.equal(again.recorded, false, "reddedilen şikâyet kuyruğa geri döndü");
  assert.equal(again.suppressed, true);
  assert.equal(listVerdictHistory(store, findingId).length, before, "satır yazıldı: append-only tablo şişiyor");
  assert.equal(getLiveVerdict(store, findingId)!.verdict, "olculemez", "canlı hüküm bastırma yüzünden değişti");
  assert.equal(
    listPendingVerdicts(store, projectId).filter((v) => v.verdict === "curuk").length, 0,
    "reddedilmiş hüküm yeniden bekliyor",
  );

  assert.equal(countEvents(store, "verdict_suppressed"), 1, "bastırma görünmez kaldı");
  const ev = listEvents(store, { kind: "verdict_suppressed" })[0]!;
  const detail = JSON.parse(ev.detail!) as Record<string, unknown>;
  assert.equal(detail["findingId"], findingId);
  assert.equal(detail["reason"], "curuk||dosya-silindi");
  assert.equal(detail["rejectedVerdictId"], rejectedId);
  assert.equal(typeof detail["fingerprint"], "string");
  store.close();
});

test("kanıt değiştiyse normal akış: hüküm yaratılır", () => {
  const { store, projectId, findingId } = rejectedThenWithdrawn();
  const again = recordVerdict(store, {
    projectId, findingId, ...DECAYED, evidence: "src/a.ts silinmiş (sha def)",
    source: "mechanical", runId: "r3",
  });
  assert.equal(again.recorded, true, "değişen kanıt bastırıldı: çürüme kullanıcıya hiç ulaşmaz");
  assert.equal(again.suppressed, false);
  assert.equal(countEvents(store, "verdict_suppressed"), 0);
  assert.equal(getLiveVerdict(store, findingId)!.verdict, "curuk");
  store.close();
});

test("başka sebeple gelen hüküm bastırılmaz", () => {
  const { store, projectId, findingId } = rejectedThenWithdrawn();
  const again = recordVerdict(store, {
    projectId, findingId, verdict: "dogustan-yanlis", evidence: DECAYED.evidence,
    source: "mechanical", runId: "r3",
  });
  assert.equal(again.recorded, true, "sebep farklı: red başka bir iddiaya aitti");
  store.close();
});

test("approved ASLA bastırmaz — onaylanmış hüküm supersede akışını izler", () => {
  const s = seed();
  const first = recordVerdict(s.store, { ...s, ...DECAYED, source: "mechanical", runId: "r1" });
  assert.equal(reviewVerdict(s.store, first.id, "approved"), true);
  recordVerdict(s.store, { ...s, ...CLEARED, source: "mechanical", runId: "r2" });

  const again = recordVerdict(s.store, { ...s, ...DECAYED, source: "mechanical", runId: "r3" });
  assert.equal(again.recorded, true, "onaylanmış hüküm bastırma kapısı oldu");
  assert.equal(countEvents(s.store, "verdict_suppressed"), 0);
  s.store.close();
});

test("bastırma claim başına: aynı sebep başka bir iddiada bastırılmaz", () => {
  const { store, projectId, findingId } = rejectedThenWithdrawn();
  const other = recordVerdict(store, {
    projectId, findingId, claimRef: "c1", ...DECAYED, source: "mechanical", runId: "r3",
  });
  assert.equal(other.recorded, true, "başka bir iddianın hükmü, tümü-not reddiyle bastırıldı");
  store.close();
});

test("canlı hüküm aynı sonucu söylüyorsa tekrar sayacı yolu korunur, bastırma devreye girmez", () => {
  const s = seed();
  const first = recordVerdict(s.store, { ...s, ...DECAYED, source: "mechanical", runId: "r1" });
  assert.equal(reviewVerdict(s.store, first.id, "rejected"), true);

  const again = recordVerdict(s.store, { ...s, ...DECAYED, source: "mechanical", runId: "r2" });
  assert.equal(again.id, first.id);
  assert.equal(again.recorded, false);
  assert.equal(again.suppressed, false, "tekrar ölçümü bastırma sayıldı: verdict_suppressed sayısı şişer");
  assert.equal(countEvents(s.store, "verdict_suppressed"), 0);
  s.store.close();
});

/**
 * The rejection that suppresses must be a CURRENT one. `findLastRejected` reads
 * the `review` column, which is now mutable, so reverting a decision has to drop
 * the suppression with it — otherwise an accidental Reject would silence the
 * complaint forever and the undo button would be cosmetic.
 *
 * The re-measurement here differs only in `source`: same reason, same evidence,
 * so the fingerprint matches and the repeat branch does not (design §5).
 */
test("red geri alınınca bastırma da düşer: aynı kanıtlı hüküm yeniden üretilir", () => {
  const s = seed();
  const first = recordVerdict(s.store, { ...s, ...DECAYED, source: "mechanical", runId: "r1" });
  assert.equal(reviewVerdict(s.store, first.id, "rejected"), true);

  const suppressed = recordVerdict(s.store, { ...s, ...DECAYED, source: "adjudicator", runId: "r2" });
  assert.equal(suppressed.suppressed, true, "red bastırmadı: kurulum yanlış");
  assert.equal(countEvents(s.store, "verdict_suppressed"), 1);

  assert.equal(reviewVerdict(s.store, first.id, "pending"), true);
  assert.equal(findLastRejected(s.store, s.findingId, "curuk||dosya-silindi"), undefined,
    "geri alınan red hâlâ red sayılıyor");

  const again = recordVerdict(s.store, { ...s, ...DECAYED, source: "adjudicator", runId: "r3" });
  assert.equal(again.suppressed, false, "geri alınan red bastırmaya devam ediyor");
  assert.equal(again.recorded, true);
  assert.equal(countEvents(s.store, "verdict_suppressed"), 1, "yeni bastırma olayı düştü");
  assert.equal(getLiveVerdict(s.store, s.findingId)!.source, "adjudicator");
  s.store.close();
});

test("findLastRejected en SON reddi verir, reddedilmemiş satırları görmez", () => {
  const { store, projectId, findingId } = rejectedThenWithdrawn();
  const reason = "curuk||dosya-silindi";
  const found = findLastRejected(store, findingId, reason);
  assert.equal(found?.review, "rejected");
  assert.equal(found?.verdict, "curuk");
  assert.equal(findLastRejected(store, findingId, "olculemez|anchor-evidence-cleared|"), undefined,
    "reddedilmemiş satır red gibi okundu");
  assert.equal(findLastRejected(store, findingId, reason, "c1"), undefined, "claim sınırı yok sayıldı");
  assert.equal(projectId > 0, true);
  store.close();
});
