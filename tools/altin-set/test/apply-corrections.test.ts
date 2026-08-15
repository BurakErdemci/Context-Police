// `apply-corrections.ts` — golden v1 + öneri dosyası -> v2.
//
// Bu dosyanın asıl sınadığı şey mutluluk yolu değil, BAŞARISIZLIKTA HİÇ DOSYA
// YAZILMAMASI. Kısmen uygulanmış bir altın set tam bir dosya gibi görünür ve
// aşağıdaki her ölçümü sessizce yanlış puanlar; o yüzden her sav ihlali için
// ayrı bir "dosya yok" iddiası var.
//
// Gerçek `docs/` dosyalarına hiç dokunulmuyor: her koşum kendi temp dizininde.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "apply-corrections.ts");

type Row = Record<string, unknown>;
const jsonl = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const claim = (note: string, n: number, over: Row = {}): Row => ({
  note,
  claim_id: `${note}#${n}`,
  line_start: n,
  line_end: n,
  text: `iddia ${n}`,
  verdict: "gecerli",
  evidence: `kanit ${n}`,
  method: `yontem ${n}`,
  ...over,
});

type Run = { rc: number; stderr: string; out: Row[] | null; outPath: string; dir: string };

function run(golden: Row[], proposal: Row[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "apply-corrections-"));
  const gPath = join(dir, "golden.jsonl");
  const pPath = join(dir, "proposal.jsonl");
  const outPath = join(dir, "out.jsonl");
  writeFileSync(gPath, jsonl(golden));
  writeFileSync(pPath, jsonl(proposal));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", TOOL, gPath, pPath, outPath], {
    encoding: "utf8",
  });
  const out = existsSync(outPath)
    ? readFileSync(outPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    : null;
  return { rc: r.status ?? -1, stderr: r.stderr, out, outPath, dir };
}

/** Çıktının i. kaydı; dosya hiç yazılmadıysa testi burada düşürür. */
function row(r: Run, i: number): Row {
  assert.ok(r.out, `çıktı dosyası yazılmamış (rc=${r.rc}): ${r.stderr}`);
  const c = r.out[i];
  assert.ok(c, `çıktıda ${i}. kayıt yok (${r.out.length} kayıt)`);
  return c;
}

/** Her testin sonunda temp dizin silinir — yaratan adımın kapanışı zorunlu. */
function runAndClean(golden: Row[], proposal: Row[]): Run {
  const r = run(golden, proposal);
  rmSync(r.dir, { recursive: true, force: true });
  return r;
}

test("kullanım hatası: eksik argüman rc=2", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", TOOL, "a.jsonl"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /kullanım/);
});

test("_yorum kaydı atlanır, işlem sayılmaz", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{ _yorum: "bu bir açıklama" }],
  );
  assert.equal(r.rc, 0);
  assert.equal(r.out!.length, 1);
  assert.match(r.stderr, /1 yorum/);
});

test("anchor-duzelt satır aralığını değiştirir, hükme dokunmaz", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 40, line_end: 41 })],
    [{
      islem: "anchor-duzelt", claim_id: "a#1", note: "a",
      old_line_start: 40, old_line_end: 41, new_line_start: 38, new_line_end: 39,
      text: "iddia 1", verdict: "gecerli", reason: "gerekçe", evidence: "yeni kanit", method: "yeni yontem",
    }],
  );
  assert.equal(r.rc, 0);
  assert.equal(row(r, 0).line_start, 38);
  assert.equal(row(r, 0).line_end, 39);
  assert.equal(row(r, 0).verdict, "gecerli");
  assert.match(r.stderr, /anchor-duzelt {4}1/);
});

test("anchor-duzelt: mevcut satırlar old_* ile uyuşmazsa ölümcül ve dosya yazılmaz", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 5, line_end: 6 })],
    [{
      islem: "anchor-duzelt", claim_id: "a#1", note: "a",
      old_line_start: 40, old_line_end: 41, new_line_start: 38, new_line_end: 39,
      text: "iddia 1", verdict: "gecerli",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'line_start' uyuşmuyor — altın sette 5, öneri 40 bekliyor/);
});

test("anchor-duzelt: mevcut hüküm önerinin verdict'i ile uyuşmazsa ölümcül", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 40, line_end: 41, verdict: "curuk" })],
    [{
      islem: "anchor-duzelt", claim_id: "a#1", note: "a",
      old_line_start: 40, old_line_end: 41, new_line_start: 38, new_line_end: 39,
      text: "iddia 1", verdict: "gecerli",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'verdict' uyuşmuyor — altın sette "curuk", öneri "gecerli" bekliyor/);
});

test("etiket-degistir hükmü değiştirir ve decay_type'ı taşır", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1,
      text: "iddia 1", old_verdict: "gecerli", new_verdict: "curuk",
      decay_type: "karar-tersine-dondu", reason: "gerekçe",
    }],
  );
  assert.equal(r.rc, 0);
  assert.equal(row(r, 0).verdict, "curuk");
  assert.equal(row(r, 0).decay_type, "karar-tersine-dondu");
  // Alan sırası v1 ile aynı kalmalı: decay_type verdict'in hemen ardında.
  const keys = Object.keys(row(r, 0));
  assert.equal(keys[keys.indexOf("verdict") + 1], "decay_type");
});

test("etiket-degistir: decay_type yoksa alan hiç eklenmez", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1,
      text: "iddia 1", old_verdict: "gecerli", new_verdict: "dogustan-yanlis",
    }],
  );
  assert.equal(r.rc, 0);
  assert.equal(row(r, 0).verdict, "dogustan-yanlis");
  assert.ok(!("decay_type" in row(r, 0)));
});

test("etiket-degistir: mevcut hüküm old_verdict değilse ölümcül ve dosya yazılmaz", () => {
  const r = runAndClean(
    [claim("a", 1, { verdict: "curuk" })],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1,
      text: "iddia 1", old_verdict: "gecerli", new_verdict: "dogustan-yanlis",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'verdict' uyuşmuyor/);
});

// EŞLEME ÖLÇÜTÜNÜN DOĞRULANMASI. Aşağıdaki dört test aynı tek tehlikeyi
// kuşatıyor: `claim_id` iki dosya arasında kaymışsa hüküm YANLIŞ iddiaya
// uygulanır ve altın set aşağıdaki hiçbir katmanın göremeyeceği biçimde
// bozulur. Öneri hedef hakkında ne söylüyorsa (`note`, satırlar, `text`)
// hepsi bulunan kayda karşı sınanmalı — yoksa aletin kendi hatası sonucun
// içinde saklanır (ölçüldü 14 Ağu: %58 alet hatası, %12,5 gerçek sinyal).

test("etiket-degistir: öneri note'u kaydınkiyle uyuşmazsa ölümcül", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "b", line_start: 1, line_end: 1,
      text: "iddia 1", old_verdict: "gecerli", new_verdict: "curuk",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'note' uyuşmuyor/);
});

test("etiket-degistir: satır aralığı uyuşmazsa ölümcül — kaymış claim_id'nin tuttuğu yer", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 27, line_end: 35 })],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 27, line_end: 99,
      text: "iddia 1", old_verdict: "gecerli", new_verdict: "curuk",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'line_end' uyuşmuyor/);
});

test("etiket-degistir: text birebir uyuşmazsa ölümcül — normalleştirme YOK", () => {
  // Yalnız sondaki boşluk farkı. Gevşetilmiş bir karşılaştırma bunu yutar;
  // yutarsa eşleme ölçütü ölçülmemiş olur.
  const r = runAndClean(
    [claim("a", 1, { text: "iddia metni" })],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1,
      text: "iddia  metni ", old_verdict: "gecerli", new_verdict: "curuk",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'text' uyuşmuyor/);
});

test("bir işlemin uyuşmayan TÜM alanları tek koşumda raporlanır", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 1, line_end: 1, text: "gerçek metin" })],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "b", line_start: 5, line_end: 6,
      text: "başka metin", old_verdict: "curuk", new_verdict: "dogustan-yanlis",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  for (const f of ["note", "line_start", "line_end", "text", "verdict"]) {
    assert.match(r.stderr, new RegExp(`'${f}' uyuşmuyor`), `${f} raporlanmalı`);
  }
  assert.match(r.stderr, /5 sorun/);
});

test("anchor-duzelt: öneri note'u kaydınkiyle uyuşmazsa ölümcül", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 40, line_end: 41 })],
    [{
      islem: "anchor-duzelt", claim_id: "a#1", note: "b",
      old_line_start: 40, old_line_end: 41, new_line_start: 38, new_line_end: 39,
      text: "iddia 1", verdict: "gecerli",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'note' uyuşmuyor/);
});

test("ekle yeni iddia üretir; reason taşınmaz, evidence ve method taşınır", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{
      islem: "ekle", note: "a", line_start: 9, line_end: 9, text: "yeni iddia",
      old_verdict: null, new_verdict: "dogustan-yanlis",
      reason: "raporun gerekçesi", evidence: "kanit X", method: "yontem X",
    }],
  );
  assert.equal(r.rc, 0);
  const yeni = row(r, 1);
  assert.equal(yeni.claim_id, "a#2");
  assert.equal(yeni.verdict, "dogustan-yanlis");
  assert.equal(yeni.evidence, "kanit X");
  assert.equal(yeni.method, "yontem X");
  assert.ok(!("reason" in yeni), "reason çıktıya taşınmamalı");
  assert.ok(!("new_verdict" in yeni));
  assert.ok(!("old_verdict" in yeni));
  assert.ok(!("islem" in yeni));
});

test("ekle: old_verdict null değilse ölümcül", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{ islem: "ekle", note: "a", line_start: 9, line_end: 9, text: "x", old_verdict: "gecerli", new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /old_verdict null olmalı/);
});

test("ekle: aynı not + aynı satırlar + aynı metin varsa ölümcül, sessiz atlama değil", () => {
  const r = runAndClean(
    [claim("a", 1, { line_start: 9, line_end: 9, text: "aynı metin" })],
    [{ islem: "ekle", note: "a", line_start: 9, line_end: 9, text: "aynı metin", old_verdict: null, new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /zaten etiketli/);
});

test("ekle: aynı öneride iki kez aynı iddia da ölümcül", () => {
  const dup = { islem: "ekle", note: "a", line_start: 9, line_end: 9, text: "x", old_verdict: null, new_verdict: "curuk" };
  const r = runAndClean([claim("a", 1)], [dup, { ...dup }]);
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
});

test("sentezlenen claim_id çakışmaz: sayısal olmayan #18a soneki de sayılır", () => {
  // Gerçek altın sette `unity-architect-mimari#18a` / `#18b` var (elle bölünmüş
  // iddialar). Sonek katı `\d+$` ile okunursa 18 görülmez ve #18'e çakışılır.
  const r = runAndClean(
    [claim("a", 1), { ...claim("a", 18), claim_id: "a#18a" }, { ...claim("a", 18), claim_id: "a#18b", line_start: 19 }],
    [{ islem: "ekle", note: "a", line_start: 30, line_end: 30, text: "yeni", old_verdict: null, new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 0);
  const ids = r.out!.map((c) => c.claim_id);
  assert.equal(new Set(ids).size, ids.length, "kimlikler benzersiz olmalı");
  assert.ok(ids.includes("a#19"), `beklenen a#19, gelen: ${ids.join(", ")}`);
});

test("aynı nota iki ekle art arda numaralanır", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [
      { islem: "ekle", note: "a", line_start: 5, line_end: 5, text: "ilk", old_verdict: null, new_verdict: "curuk" },
      { islem: "ekle", note: "a", line_start: 6, line_end: 6, text: "ikinci", old_verdict: null, new_verdict: "curuk" },
    ],
  );
  assert.equal(r.rc, 0);
  assert.deepEqual(r.out!.map((c) => c.claim_id), ["a#1", "a#2", "a#3"]);
  // Öneri sırası korunur.
  assert.deepEqual(r.out!.slice(1).map((c) => c.text), ["ilk", "ikinci"]);
});

test("ekle, notun SON iddiasının hemen ardına girer; diğer notlar kaymaz", () => {
  const r = runAndClean(
    [claim("a", 1), claim("b", 1), claim("a", 2), claim("c", 1)],
    [{ islem: "ekle", note: "a", line_start: 7, line_end: 7, text: "yeni a", old_verdict: null, new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 0);
  assert.deepEqual(r.out!.map((c) => c.claim_id), ["a#1", "b#1", "a#2", "a#3", "c#1"]);
});

test("v1'de hiç iddiası olmayan notun ekle'si dosyanın sonuna gider", () => {
  const r = runAndClean(
    [claim("a", 1), claim("b", 1)],
    [{ islem: "ekle", note: "z", line_start: 3, line_end: 3, text: "yeni z", old_verdict: null, new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 0);
  assert.deepEqual(r.out!.map((c) => c.claim_id), ["a#1", "b#1", "z#1"]);
});

test("bilinmeyen islem ölümcül ve dosya yazılmaz", () => {
  const r = runAndClean([claim("a", 1)], [{ islem: "sil", claim_id: "a#1" }]);
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /bilinmeyen islem 'sil'/);
});

test("eşleşmeyen claim_id ölümcül ve dosya yazılmaz", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{ islem: "etiket-degistir", claim_id: "a#99", note: "a", old_verdict: "gecerli", new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'a#99' altın sette yok/);
});

test("tek bir hata bile geçerli işlemlerin çıktısını engeller", () => {
  const r = runAndClean(
    [claim("a", 1), claim("b", 1)],
    [
      { islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1, text: "iddia 1", old_verdict: "gecerli", new_verdict: "curuk" },
      { islem: "etiket-degistir", claim_id: "yok#1", note: "yok", old_verdict: "gecerli", new_verdict: "curuk" },
    ],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null, "kısmen uygulanmış dosya yazılmamalı");
});

test("tüm sorunlar tek koşumda raporlanır", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [
      { islem: "etiket-degistir", claim_id: "yok#1", note: "yok", old_verdict: "gecerli", new_verdict: "curuk" },
      { islem: "sil", claim_id: "a#1" },
      { islem: "ekle", note: "a", line_start: 1, line_end: 1, text: "iddia 1", old_verdict: null, new_verdict: "curuk" },
    ],
  );
  assert.equal(r.rc, 1);
  assert.match(r.stderr, /3 sorun/);
  assert.match(r.stderr, /altın sette yok/);
  assert.match(r.stderr, /bilinmeyen islem/);
  assert.match(r.stderr, /zaten etiketli/);
});

// KUSUR I-a (15 Ağu 2026 probe'u). `anchor-duzelt` dalı `text`'i hiç sınamıyordu;
// kardeş dal `etiket-degistir` sınıyordu. Kaymış bir `claim_id`, komşusuyla aynı
// not + aynı satır aralığı + aynı hükme denk geldiğinde ayırt edici TEK alan
// `text` kalıyor — o sınanmayınca düzeltme yanlış kayda hata basmadan uygulandı.

test("anchor-duzelt: komşuya kaymış claim_id reddedilir — ayırt eden tek alan text", () => {
  // İki iddia; not, satırlar ve hüküm birebir aynı, yalnız metinleri farklı.
  const golden = [
    claim("a", 1, { line_start: 10, line_end: 12, text: "AAA", verdict: "curuk" }),
    claim("a", 2, { line_start: 10, line_end: 12, text: "BBB", verdict: "curuk" }),
  ];
  // Öneri AAA'yı (a#1) anlatıyor ama claim_id'si a#2'ye kaymış.
  const r = runAndClean(golden, [{
    islem: "anchor-duzelt", claim_id: "a#2", note: "a",
    old_line_start: 10, old_line_end: 12, new_line_start: 20, new_line_end: 22,
    text: "AAA", verdict: "curuk",
  }]);
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'text' uyuşmuyor — altın sette "BBB", öneri "AAA" bekliyor/);
});

test("anchor-duzelt: aynı öneri doğru claim_id ile uygulanır — negatif kontrol", () => {
  // Yukarıdaki testin ikizi. Bu geçmezse yukarıdaki red, çalışan bir kontrolü
  // değil kırık bir düzeneği ölçüyor olurdu.
  const golden = [
    claim("a", 1, { line_start: 10, line_end: 12, text: "AAA", verdict: "curuk" }),
    claim("a", 2, { line_start: 10, line_end: 12, text: "BBB", verdict: "curuk" }),
  ];
  const r = runAndClean(golden, [{
    islem: "anchor-duzelt", claim_id: "a#1", note: "a",
    old_line_start: 10, old_line_end: 12, new_line_start: 20, new_line_end: 22,
    text: "AAA", verdict: "curuk",
  }]);
  assert.equal(r.rc, 0);
  assert.deepEqual([row(r, 0).line_start, row(r, 0).line_end], [20, 22], "a#1 taşınmalı");
  assert.deepEqual([row(r, 1).line_start, row(r, 1).line_end], [10, 12], "a#2 yerinde kalmalı");
});

test("anchor-duzelt: text alanı hiç yoksa ölümcül — boş karşılaştırma kabul edilmez", () => {
  // `text` yokken sessizce geçilirse karşılaştırma `undefined === undefined`
  // olur ve hiçbir şey ölçmez; alanın VARLIĞI ayrıca sınanıyor.
  const r = runAndClean(
    [claim("a", 1, { line_start: 40, line_end: 41 })],
    [{
      islem: "anchor-duzelt", claim_id: "a#1", note: "a",
      old_line_start: 40, old_line_end: 41, new_line_start: 38, new_line_end: 39,
      verdict: "gecerli",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'text' zorunlu/);
});

// KUSUR I-b. `new_verdict` hiç doğrulanmıyordu: alan yoksa `undefined` atanıyor,
// `JSON.stringify` anahtarı DÜŞÜRÜYOR ve `score.ts` iddiayı hiç saymıyor
// (`WRONG.has(undefined)` false). Hedef altın setten buharlaşıyor, sonraki her
// ölçümün paydası sessizce değişiyor. Bu yüzden testler yalnız rc'ye değil
// ANAHTARIN VARLIĞINA da bakıyor.

test("etiket-degistir: new_verdict yoksa ölümcül — verdict anahtarı düşmez", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{
      islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1,
      text: "iddia 1", old_verdict: "gecerli",
    }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'new_verdict' boş olmayan string olmalı, undefined geldi/);
});

test("etiket-degistir: new_verdict boş string ya da string değilse ölümcül", () => {
  for (const bad of ["", null, 3]) {
    const r = runAndClean(
      [claim("a", 1)],
      [{
        islem: "etiket-degistir", claim_id: "a#1", note: "a", line_start: 1, line_end: 1,
        text: "iddia 1", old_verdict: "gecerli", new_verdict: bad,
      }],
    );
    assert.equal(r.rc, 1, `new_verdict=${JSON.stringify(bad)} reddedilmeli`);
    assert.equal(r.out, null);
    assert.match(r.stderr, /'new_verdict' boş olmayan string olmalı/);
  }
});

test("ekle: new_verdict yoksa ölümcül — sentezlenen kayıt verdict'siz doğmaz", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{ islem: "ekle", note: "a", line_start: 9, line_end: 9, text: "yeni", old_verdict: null }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'new_verdict' boş olmayan string olmalı/);
});

test("ekle: line_start/line_end number değilse ölümcül", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{ islem: "ekle", note: "a", line_start: "9", line_end: 9, text: "yeni", old_verdict: null, new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null);
  assert.match(r.stderr, /'line_start'\/'line_end' number olmalı/);
});

test("ekle: text yoksa ya da boşsa ölümcül", () => {
  for (const bad of [undefined, ""]) {
    const r = runAndClean(
      [claim("a", 1)],
      [{ islem: "ekle", note: "a", line_start: 9, line_end: 9, text: bad, old_verdict: null, new_verdict: "curuk" }],
    );
    assert.equal(r.rc, 1, `text=${JSON.stringify(bad)} reddedilmeli`);
    assert.equal(r.out, null);
    assert.match(r.stderr, /'text' boş olmayan string olmalı/);
  }
});

// KUSUR C5 (15 Ağu 2026 doğrulama turu). `ekle` dalı `line_start`/`line_end`/
// `text`/`new_verdict` doğruluyordu ama `note`'u HİÇ doğrulamıyordu — oysa
// dördü de aynı yoldan sentezlenen kaydın içine giriyor. Alan yokken
// `claim_id: "undefined#1"` üretiliyor ve `note` anahtarı `JSON.stringify`
// tarafından SESSİZCE düşürülüyordu: aşağıdaki hiçbir katmanın bir nota
// bağlayamayacağı bir iddia, hata basmadan altın sete giriyordu.

test("ekle: note yoksa ölümcül — 'undefined#1' kimliği doğmaz ve dosya yazılmaz", () => {
  const r = runAndClean(
    [claim("a", 1)],
    [{ islem: "ekle", line_start: 9, line_end: 9, text: "yeni", old_verdict: null, new_verdict: "curuk" }],
  );
  assert.equal(r.rc, 1);
  assert.equal(r.out, null, "çıktı dosyası HİÇ yazılmamalı");
  assert.match(r.stderr, /'note' boş olmayan string olmalı, undefined geldi/);
});

test("ekle: note boş string ya da string değilse ölümcül", () => {
  for (const bad of ["", null, 7]) {
    const r = runAndClean(
      [claim("a", 1)],
      [{ islem: "ekle", note: bad, line_start: 9, line_end: 9, text: "yeni", old_verdict: null, new_verdict: "curuk" }],
    );
    assert.equal(r.rc, 1, `note=${JSON.stringify(bad)} reddedilmeli`);
    assert.equal(r.out, null);
    assert.match(r.stderr, /'note' boş olmayan string olmalı/);
  }
});

// KUSUR J. Kaynak dosyada `identity()` içinde üç HAM NUL baytı vardı; git dosyayı
// İKİLİ sayıyor, `git show` gövdesi "Binary files differ" diyor ve altın seti
// yeniden yazan aracın satır düzeyi diff'i HİÇ olmuyordu. Ayıraç `\0` KAÇIŞ
// dizisiyle yazılınca davranış aynı kalıyor, dosya metin oluyor.
test("kaynak dosyada ham NUL baytı yok — git'te ikili görünmemeli", () => {
  const bytes = readFileSync(TOOL);
  const nul = bytes.filter((b) => b === 0).length;
  assert.equal(nul, 0, `${nul} ham NUL baytı var; \\0 kaçışı kullanılmalı`);
});

test("kimlik ayıracı hâlâ NUL: farklı alan bölünmeleri çakışmaz", () => {
  // `identity()` alanları NUL ile birleştiriyor. J düzeltmesi ham baytı `\0`
  // KAÇIŞIYLA değiştirdi; ayıraç sıradan bir karaktere (örn. boşluk) çevrilerek
  // "düzeltilirse" alan sınırı kaybolur. Aşağıdaki iki kayıt boşluk ayıraçla
  // AYNI kimliği verirdi ("a 1 2 3 b"), NUL ile vermiyor — ikisi de kabul
  // edilmeli, yoksa ikincisi "zaten etiketli" diye yanlış reddedilir.
  const r = runAndClean(
    [claim("a", 1)],
    [
      { islem: "ekle", note: "a 1", line_start: 2, line_end: 3, text: "b", old_verdict: null, new_verdict: "curuk" },
      { islem: "ekle", note: "a", line_start: 1, line_end: 2, text: "3 b", old_verdict: null, new_verdict: "curuk" },
    ],
  );
  assert.equal(r.rc, 0, r.stderr);
  assert.equal(r.out!.length, 3);
});

test("v1 kayıtları özgün sırasında ve dokunulmadan geçer", () => {
  const golden = [claim("a", 1), claim("b", 1), claim("b", 2), claim("a", 2)];
  const r = runAndClean(golden, [{ _yorum: "hiçbir işlem yok" }]);
  assert.equal(r.rc, 0);
  assert.deepEqual(r.out, golden);
});
