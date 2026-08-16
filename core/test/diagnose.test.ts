import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/serve/diagnose.ts";
import type { VerdictDetail } from "../src/serve/api.ts";

function verdict(partial: Partial<VerdictDetail>): VerdictDetail {
  return {
    id: 1, verdict: "gecerli", subReason: null, decayType: null, evidence: null,
    method: null, correction: null, source: "mechanical", runId: "r1",
    createdAt: "2026-08-16T00:00:00Z", review: "pending", reviewedAt: null,
    supersededBy: null, repeatCount: 1, ...partial,
  };
}

const BASE = { content: "içerik", status: "active", suspicion: 0.5, verdict: null, anchors: [] };

test("kural 1a: born_invalid statüsü DURUM satırı olmadan bile durum günlüğü kuralını tetikler", () => {
  const d = diagnose({ ...BASE, status: "born_invalid", content: "sıradan gövde metni" });
  assert.match(d.sentence, /durum günlüğü/);
  assert.equal(d.accent, "durum günlüğü");
});

test("kural 1b: DURUM: satırı içeren içerik status'tan bağımsız tetikler, satır kısaltılıp alıntılanır", () => {
  const d = diagnose({
    ...BASE,
    content: "DURUM: 16 Ağu akşam — hepsi pushlandı, ağaç temiz",
  });
  assert.match(d.sentence, /durum günlüğü/);
  assert.match(d.sentence, /16 Ağu akşam/);
});

test("kural 1 öncelik: DURUM satırı, curuk/anchor-drift hükmünden önce gelir", () => {
  const d = diagnose({
    ...BASE,
    content: "DURUM: eski bir şey",
    verdict: verdict({ verdict: "curuk", method: "anchor-drift (git)", evidence: "missing_now: src/a.ts" }),
  });
  assert.match(d.sentence, /durum günlüğü/);
});

test("kural 2: curuk + anchor-drift, kanıttan ilk çapa değerini çıkarır", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "curuk", method: "anchor-drift (git)", evidence: "missing_now: src/a.ts, src/b.ts" }),
  });
  assert.match(d.sentence, /src\/a\.ts/);
  assert.equal(d.accent, "src/a.ts");
});

test("kural 2 jenerik: kanıt yoksa/çıkarılamazsa genel cümle döner, accent null", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "curuk", method: "anchor-drift (git)", evidence: null }),
  });
  assert.match(d.sentence, /Çapaladığı dosya/);
  assert.equal(d.accent, null);
});

test("kural 3: olculemez + classify-undecided ölçülemedi cümlesi kurar", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({
      verdict: "olculemez", subReason: "classify-undecided",
      evidence: "çelişki boyutu bu koşumda ölçülemedi; önceki şüphe (0.7) düşürülmedi",
    }),
  });
  assert.match(d.sentence, /ölçülemedi/);
  assert.match(d.sentence, /çelişki/);
});

test("kural 3: classifier-not-run alt sebebi de aynı kuralı tetikler", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "olculemez", subReason: "classifier-not-run", evidence: null }),
  });
  assert.match(d.sentence, /ölçülemedi/);
});

test("kural 3: anchor-unmeasured alt sebebi de aynı kuralı tetikler", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({
      verdict: "olculemez", subReason: "anchor-unmeasured",
      evidence: "çapa boyutu bu koşumda ölçülemedi; önceki şüphe (0.4) düşürülmedi",
    }),
  });
  assert.match(d.sentence, /ölçülemedi/);
  assert.match(d.sentence, /çapa/);
});

test("kural 4: rotation-starved üç rotasyon cümlesini kurar", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "olculemez", subReason: "rotation-starved", evidence: "..." }),
  });
  assert.match(d.sentence, /3 rotasyondur/);
});

test("kural 5: dogustan-yanlis kanıtı kısaltıp alıntılar", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "dogustan-yanlis", evidence: "never_existed: eski/yol.ts" }),
  });
  assert.match(d.sentence, /yazıldığı gün de/);
  assert.match(d.sentence, /never_existed: eski\/yol\.ts/);
});

test("kural 6: tarihsel sabit cümle döner", () => {
  const d = diagnose({ ...BASE, verdict: verdict({ verdict: "tarihsel" }) });
  assert.match(d.sentence, /Tarihsel kayıt/);
  assert.match(d.sentence, /çürüme sayılmaz/);
});

test("varsayılan: hiçbir kural eşleşmezse method+evidence sıkıştırılır", () => {
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "gecerli", method: "signal-scored", evidence: "temiz çıktı" }),
  });
  assert.equal(d.sentence, "signal-scored: temiz çıktı");
  assert.equal(d.accent, null);
});

test("varsayılan: hüküm null ise sabit cümle döner", () => {
  const d = diagnose({ ...BASE, verdict: null });
  assert.equal(d.sentence, "Bu koşumda hüküm çıkmadı.");
});

test("140 karakter tavanı: uzun kanıt kısaltılır, ... eklenmez fazladan uzatılmaz", () => {
  const longEvidence = "x".repeat(300);
  const d = diagnose({
    ...BASE,
    verdict: verdict({ verdict: "gecerli", method: "m", evidence: longEvidence }),
  });
  assert.ok(d.sentence.length <= 140, `uzunluk ${d.sentence.length}`);
  assert.ok(d.sentence.endsWith("…"));
});

test("başlık: frontmatter name alanından, tire/altçizgi boşluğa çevrilip baş harf büyütülür", () => {
  const d = diagnose({
    ...BASE,
    content: "---\nname: durum-notu_ornek\n---\n\ngövde",
  });
  assert.equal(d.title, "Durum notu ornek");
});

test("başlık: frontmatter yoksa boş dize döner (çağıran sourceRef ile tamamlar)", () => {
  const d = diagnose({ ...BASE, content: "frontmatter'sız düz metin" });
  assert.equal(d.title, "");
});
