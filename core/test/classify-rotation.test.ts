// D dalgası (12 Ağu 2026 doğrulama turu): ÖNCEKİ düzeltmelerin kendi getirdiği
// kusur. Probe ana ağaca karşı rc=1 ölçüldü; buradaki testler o probe'un terfi
// edilmiş hâli + sınıf kapanışı varyantları.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/store/db.ts";
import { appendFinding, getFinding, markClassified } from "../src/store/findings.ts";
import { auditProject } from "../src/audit.ts";
import { selectCandidates } from "../src/signals/classify.ts";
import type { Candidate } from "../src/signals/contradiction.ts";
import { tmpDir, tmpStorePath, fakeExecutor } from "./helpers.ts";

// --- 2) sınıflama kotası: aday ROTASYONU ---------------------------------------

const cand = (aId: number, bId: number | null, kind: Candidate["kind"] = "cross"): Candidate =>
  ({ kind, aId, bId, reason: "test" });

test("göç: last_classified_at'sız VAR OLAN depo açılınca kolon gelir, veri durur, damga yazılabilir", () => {
  // CLAUDE.md §7: taze depoda çalışması KANIT DEĞİL. Dosya önce yaratılıp içine
  // veri konuyor, sonra ELLE sütunsuz kuşağa indiriliyor; göç var olan veri
  // üstünde ölçülüyor. (DROP COLUMN, tabloyu yeniden kurmadan eski kuşağı
  // birebir üretiyor — append-only tetikleyicileri de yerinde kalıyor.)
  const path = tmpStorePath();
  const ilk = openStore(path);
  const projectId = Number(ilk.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", "/p", "claude-code", "/t",
  ).lastInsertRowid);
  const findingId = appendFinding(ilk, { projectId, source: "observed", content: "eski kuşak notu" });
  ilk.close();

  const eski = new DatabaseSync(path);
  eski.exec("ALTER TABLE findings DROP COLUMN last_classified_at");
  assert.equal(
    (eski.prepare("PRAGMA table_info(findings)").all() as { name: string }[])
      .some((c) => c.name === "last_classified_at"),
    false, "test kurulumu eski şemayı kuramadı",
  );
  eski.close();

  const yeni = openStore(path); // göç yolu: var olan dosya üzerinde
  assert.ok(
    yeni.all<{ name: string }>("PRAGMA table_info(findings)").some((c) => c.name === "last_classified_at"),
    "göç kolonu eklemedi: her denetim rotasyon damgasını yazarken patlar",
  );
  const f = getFinding(yeni, findingId)!;
  assert.equal(f.content, "eski kuşak notu", "göç veri kaybetti");
  assert.equal(f.lastClassifiedAt, null, "göç uydurma damga yazdı: ölçülmemiş aday sıranın sonuna atılır");
  // Damga gerçekten YAZILABİLİR olmalı — sütunun varlığı tek başına yetmiyor.
  markClassified(yeni, [findingId], "2026-08-12T00:00:00.000Z");
  assert.equal(getFinding(yeni, findingId)!.lastClassifiedAt, "2026-08-12T00:00:00.000Z");
  // Append-only koruması göçten sonra da ayakta: damga içerik değil.
  assert.throws(() => yeni.run("UPDATE findings SET content = 'x' WHERE id = ?", findingId));
  yeni.close();
});

test("selectCandidates: hiç sınıflanmamış aday, sınıflanmış adayların ÖNÜNE geçer", () => {
  const many = Array.from({ length: 25 }, (_, i) => cand(i + 1, 100 + i));
  // 1..24 (İKİ tarafı birden) dün sınıflandı, 25 hiç sınıflanmadı ve listenin SONUNDA.
  const last = new Map<number, string>(
    Array.from({ length: 24 }, (_, i) => i).flatMap((i) =>
      [[i + 1, "2026-08-11T00:00:00.000Z"], [100 + i, "2026-08-11T00:00:00.000Z"]] as [number, string][]),
  );
  const taken = selectCandidates(many, 20, (id) => last.get(id) ?? null);
  assert.equal(taken.length, 20);
  assert.ok(taken.some((c) => c.aId === 25), "hiç ölçülmemiş aday yine kırpıldı: kalıcı donma");
});

test("selectCandidates: eşit sayıda sınıflanmışta EN ESKİ öne gelir", () => {
  const many = [cand(1, 11), cand(2, 12), cand(3, 13)];
  const last = new Map<number, string>([
    [1, "2026-08-12T00:00:00.000Z"], [11, "2026-08-12T00:00:00.000Z"],
    [2, "2026-08-10T00:00:00.000Z"], [12, "2026-08-10T00:00:00.000Z"],
    [3, "2026-08-11T00:00:00.000Z"], [13, "2026-08-11T00:00:00.000Z"],
  ]);
  const taken = selectCandidates(many, 1, (id) => last.get(id) ?? null);
  assert.deepEqual(taken.map((c) => c.aId), [2]);
});

test("varyant: aday sayısı tavanın altında — rotasyon hiçbir şeyi değiştirmiyor", () => {
  const few = [cand(1, 11), cand(2, 12, "intra")];
  const last = new Map<number, string>([[1, "2020-01-01T00:00:00.000Z"]]);
  assert.deepEqual(selectCandidates(few, 20, (id) => last.get(id) ?? null), few);
});

test("varyant: rotasyon sonrası aynı aday iki koşum üst üste seçilmiyor", () => {
  const many = [cand(1, 11), cand(2, 12), cand(3, 13)];
  const last = new Map<number, string>();
  const stamp = (n: number) => `2026-08-12T00:00:0${n}.000Z`;
  const seen: number[] = [];
  for (let run = 0; run < 3; run++) {
    const taken = selectCandidates(many, 1, (id) => last.get(id) ?? null);
    assert.equal(taken.length, 1);
    seen.push(taken[0]!.aId);
    for (const id of [taken[0]!.aId, taken[0]!.bId!]) last.set(id, stamp(run));
  }
  assert.deepEqual([...new Set(seen)].sort(), [1, 2, 3], `rotasyon dönmüyor: ${seen.join(",")}`);
});

test("varyant: yüzey kotası rotasyonun ÜSTÜNDE kalır (cross seli intra'yı yutamaz)", () => {
  // 20 cross hiç sınıflanmamış (en öncelikli), 2 intra dün sınıflanmış.
  const many: Candidate[] = [
    ...Array.from({ length: 20 }, (_, i) => cand(i + 1, 100 + i)),
    cand(90, null, "intra"), cand(91, null, "intra"),
  ];
  const last = new Map<number, string>([[90, "2026-08-11T00:00:00.000Z"], [91, "2026-08-11T00:00:00.000Z"]]);
  const taken = selectCandidates(many, 20, (id) => last.get(id) ?? null);
  assert.equal(taken.filter((c) => c.kind === "intra").length, 2, "kota rotasyona feda edildi");
});

test("kota kırpması aynı adayı SONSUZA KADAR ölçülmemiş bırakmıyor (uçtan uca)", async () => {
  // İki aday üreten üç not; tavan 1 → her koşumda yalnız biri ölçülebiliyor.
  const repo = tmpDir("cp-wave-d-rot-");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-qm", "ilk"], { stdio: "ignore" });

  const store = openStore(":memory:");
  const projectId = Number(store.run(
    "INSERT INTO projects (path, adapter_id, transcript_dir) VALUES (?,?,?)", repo, "probe", "/t",
  ).lastInsertRowid);
  const ids = [0, 1, 2].map((i) => appendFinding(store, {
    projectId, source: "observed", content: `not ${i}: src/a.ts hakkında bir iddia`,
    anchors: [{ kind: "file_path", value: "src/a.ts" }],
  }));

  const seen = new Set<number>();
  for (let run = 0; run < 3; run++) {
    await auditProject(store, { id: projectId, path: repo, memoryDir: null }, {
      executor: fakeExecutor([{ output: '{"verdicts":[{"index":0,"verdict":"uyumlu","evidence":"e"}]}' }]),
      fetch: false, maxClassifyItems: 1,
    });
    for (const id of ids) {
      const at = store.get<{ last_classified_at: string | null }>(
        "SELECT last_classified_at FROM findings WHERE id = ?", id,
      )!.last_classified_at;
      if (at !== null) seen.add(id);
    }
  }
  assert.equal(seen.size, ids.length, "bazı notlar üç koşum boyunca hiç sınıflanmadı");
  store.close();
});
