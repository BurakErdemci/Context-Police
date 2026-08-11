// Gözlemci döngüsü: scanOnce'ın onTurns kancasına takılır (M1'deki bilinçli
// ayrım — tarama okur, gözlemci yorumlar).
//
// Teslim en-az-bir-kez (scan.ts sözleşmesi). Mükerrer üretim filigranla kesilir
// (D-M2-2): bulgu yazımı + filigran aynı tx'te, etki tam-bir-kez. Zehirli parti
// görünür kayıpla atlanır (D-M2-3): sonsuz maliyet döngüsü yok, transcript diskte.

import type { Store } from "../store/db.ts";
import type { ExecutorAdapter } from "../adapters/executor.ts";
import type { Turn } from "../types.ts";
import { cutBatches, dropThroughWatermarkDetailed, type Batch, type DeliveryRange } from "./batch.ts";
import {
  OBSERVER_OUTPUT_SCHEMA, buildObserverPrompt, buildStateTitles, parseObserverOutput, type ObserverItem,
} from "./prompt.ts";
import { appendFinding, listActive, supersede } from "../store/findings.ts";
import { getWatermark, setWatermark, resetWatermarkOffset } from "../store/watermarks.ts";
import { logEvent } from "../store/events.ts";

export interface ObserverOptions {
  store: Store;
  executor: ExecutorAdapter;
  /** Parti eşiği. Varsayılan 8000 (spec §3.3); en büyük gerçek oturum ~2M token → ~250 çağrı. */
  batchTokens?: number;
  /**
   * Bu gözlemcinin yapabileceği toplam yürütücü çağrısı. Sınıra ULAŞILINCA
   * kalan partiler işlenmez ve filigran İLERLEMEZ — teslim en-az-bir-kez
   * olduğu için işlenmeyen turn'ler sonraki koşumda yeniden gelir, veri
   * kaybolmaz. Verilmezse sınır yok (mevcut davranış).
   */
  maxCalls?: number;
}

export interface ObserverStats {
  batches: number;
  calls: number;
  findings: number;
  superseded: number;
  unprocessed: number;
  /** Filigranla elenen tekrar-teslim turn'leri. */
  skippedTurns: number;
  /** maxCalls doldu ve iş yarıda bırakıldı. İş bitmedi demek — çağıran görmeli. */
  budgetExhausted: boolean;
}

const DEFAULT_BATCH_TOKENS = 8000;

export class Observer {
  readonly stats: ObserverStats = {
    batches: 0, calls: 0, findings: 0, superseded: 0, unprocessed: 0, skippedTurns: 0, budgetExhausted: false,
  };
  private readonly store: Store;
  private readonly executor: ExecutorAdapter;
  private readonly batchTokens: number;
  private readonly maxCalls: number | undefined;

  constructor(opts: ObserverOptions) {
    this.store = opts.store;
    this.executor = opts.executor;
    this.batchTokens = opts.batchTokens ?? DEFAULT_BATCH_TOKENS;
    this.maxCalls = opts.maxCalls;
  }

  /**
   * scanOnce onTurns'a doğrudan verilir: (ctx) => observer.handleTurns(ctx).
   *
   * `range` teslimatın bayt aralığı. Verilmezse (kütüphane olarak doğrudan
   * çağrı) kimlik teslimatın içerik özetinden kurulur; ikisi de konumsaldır,
   * ikisi de tek tek turn kimliğine BAKMAZ (batch.ts'teki gerekçe).
   */
  async handleTurns(ctx: {
    projectId: number; sessionId: string; turns: Turn[]; range?: DeliveryRange;
  }): Promise<void> {
    const range = ctx.range ?? null;

    // Kısalma/yerine koyma: saklanan ofset artık başka bir dosyanın ofseti.
    // KARARDAN ÖNCE sıfırlanmak zorunda, yoksa monoton ilerleme kuralı onu
    // korur ve yeni dosyanın tamamı "işlenmiş" sayılır.
    if (range?.truncated === true) {
      const cleared = resetWatermarkOffset(this.store, ctx.projectId, ctx.sessionId);
      if (cleared) {
        logEvent(this.store, {
          projectId: ctx.projectId,
          kind: "watermark_offset_reset",
          detail: { sessionId: ctx.sessionId, newRange: { from: range.from, to: range.to } },
        });
      }
    }

    const wm = getWatermark(this.store, ctx.projectId, ctx.sessionId);
    const decision = dropThroughWatermarkDetailed(ctx.turns, wm, range);
    this.stats.skippedTurns += decision.dropped;

    // Kısmi örtüşme kararı sessiz kalmamalı: teslimatın tamamı yeniden Codex'e
    // gidiyor, yani bu satır para harcayan bir yol. M2'de sıklığı hiç
    // ölçülemedi (borç 3) — olay o sayıyı bedavaya biriktirir.
    if (decision.match === "overlap-resent") {
      logEvent(this.store, {
        projectId: ctx.projectId,
        kind: "observer_partial_overlap",
        detail: {
          sessionId: ctx.sessionId,
          from: range?.from ?? null,
          to: range?.to ?? null,
          watermarkOffset: wm?.byteOffset ?? null,
          turnCount: ctx.turns.length,
        },
      });
    }

    if (decision.fresh.length === 0) {
      // Bir iş yok ama ofset geride kalmış olabilir: teslimatın tamamı kimlikle
      // elendiğinde (son parti yazıldı, teslimat sonu yazılamadan çökme) ofseti
      // burada kapatmazsak aynı aralık sonsuza dek "yarım" görünürdü.
      this.finishDelivery(ctx.projectId, ctx.sessionId, decision.key, ctx.turns.length, range);
      return;
    }

    const batches = cutBatches(decision.fresh, this.batchTokens);
    // Teslimatın kaçıncı turn'üne kadar gelindiği: elenen ön ek + işlenen
    // partiler. Filigran bu sayıyı saklar, yarıda kalan iş buradan devam eder.
    let processed = decision.dropped;
    for (const [i, batch] of batches.entries()) {
      // Bütçe kontrolü parti BAŞINDA: yarım kalan parti checkpoint yazamaz,
      // dolayısıyla iptal edilen iş sonraki koşumda bütünüyle geri gelir.
      if (!this.hasBudget()) {
        this.noteBudgetExhausted(ctx.projectId, ctx.sessionId, batches.length - i);
        return;
      }
      const res = await this.processBatch(ctx.projectId, ctx.sessionId, batch, decision.key, processed + batch.turns.length);
      if (res === "budget") {
        this.noteBudgetExhausted(ctx.projectId, ctx.sessionId, batches.length - i);
        return;
      }
      processed += batch.turns.length;
    }

    this.finishDelivery(ctx.projectId, ctx.sessionId, decision.key, processed, range);
  }

  /**
   * Teslimatın TAMAMI işlendi: ofset ancak burada ilerler.
   *
   * Neden parti başına değil: turn'lerin tek tek bayt ofsetleri elimizde yok,
   * dolayısıyla "ilk iki parti işlendi" bir ofsete çevrilemez. Yarım teslimatta
   * ofseti ilerletmek işlenmemiş turn'leri işlenmiş ilan ederdi — kalıcı kayıp.
   * Yarım işin ilerlemesi bunun yerine teslimat kimliği + turn sayısıyla
   * saklanıyor (parti checkpoint'i), ki bütçe sınırıyla koşan uzun bir oturum
   * her koşumda biraz daha ilerlesin.
   */
  private finishDelivery(
    projectId: number, sessionId: string, key: string, turnCount: number, range: DeliveryRange | null,
  ): void {
    setWatermark(this.store, {
      projectId, sessionId,
      byteOffset: range?.to ?? null,
      deliveryKey: key,
      deliveryTurns: turnCount,
    });
  }

  private hasBudget(): boolean {
    return this.maxCalls === undefined || this.stats.calls < this.maxCalls;
  }

  /**
   * Bütçe tükenişi bir HATA değil, yarım kalmış iş. İstisna atılmıyor: scan.ts
   * atılan istisnayı oturum hatası sayıp session_read_failed'a çevirirdi ve
   * "maliyet sınırına takıldık" ile "transcript okunamadı" karışırdı.
   */
  private noteBudgetExhausted(projectId: number, sessionId: string, remainingBatches: number): void {
    const first = !this.stats.budgetExhausted;
    this.stats.budgetExhausted = true;
    if (!first) return;
    logEvent(this.store, {
      projectId,
      kind: "observer_budget_exhausted",
      detail: { sessionId, calls: this.stats.calls, maxCalls: this.maxCalls ?? null, remainingBatches },
    });
  }

  private async processBatch(
    projectId: number, sessionId: string, batch: Batch, deliveryKey: string, processedTurns: number,
  ): Promise<"done" | "budget"> {
    const projectPath =
      this.store.get<{ path: string }>("SELECT path FROM projects WHERE id = ?", projectId)?.path ?? "(bilinmiyor)";

    // Durum her partide TAZE okunur: önceki partinin bulguları sonrakinin
    // başlık listesinde görünmeli, yoksa aynı taramada mükerrer üretilir.
    const active = listActive(this.store, projectId);
    const { titles, omitted } = buildStateTitles(active);
    const prompt = buildObserverPrompt({ projectPath, titles, omitted, turns: batch.turns });

    const outcome = await this.callWithRecovery(prompt);
    // Bütçe bitişi: parti İŞLENMEDİ sayılmaz (batches de artmaz), filigran da
    // ilerlemez — yapılmamış iş "işlenemedi" diye işaretlenirse D-M2-3 gereği
    // turn'ler kalıcı olarak atlanırdı. `batches` sayacı bu yüzden burada artar:
    // sözleşmesi "sonucu olan parti" (batches == observer_batch_ok + unprocessed).
    if (!outcome.ok && outcome.budget) return "budget";
    this.stats.batches++;
    if (!outcome.ok) {
      // Görünür kayıp: olay uuid aralığını taşır, transcript diskte —
      // ileride elle ya da toplu yeniden işleme mümkün.
      this.stats.unprocessed++;
      this.store.tx(() => {
        logEvent(this.store, {
          projectId,
          kind: "observer_batch_unprocessed",
          detail: {
            sessionId, lastUuid: batch.lastUuid, lastTs: batch.lastTs, turnCount: batch.turns.length,
            estTokens: batch.estTokens, error: outcome.error,
          },
        });
        this.checkpoint(projectId, sessionId, batch, deliveryKey, processedTurns);
      });
      return "done";
    }

    // Yalnız gözlemciye GERÇEKTEN GÖSTERİLEN id'ler supersede edilebilir.
    // Küme `active`ten değil `titles`tan kuruluyor: durum bütçesi (spec §3.3)
    // eski kayıtları listeden atabiliyor ve o kayıtlar prompt'ta hiç geçmiyor.
    // `active` kullanmak, modele hiç gösterilmemiş bir id'yi kapatma yetkisi
    // veriyordu (denetim: supersede-scope-bypass) — gösterilmeyeni geçersiz
    // kılma kararı bilgiye değil tahmine dayanır.
    const knownIds = new Set(titles.map((t) => t.id));
    let written = 0;
    let supersededCount = 0;
    let droppedSupersedes = 0;

    this.store.tx(() => {
      for (const item of outcome.items) {
        const newId = appendFinding(this.store, {
          projectId,
          source: "observed",
          content: item.content,
          sourceRef: `${sessionId}#${batch.lastUuid ?? "?"}`,
          anchors: item.anchors,
        });
        written++;
        if (item.supersedes !== undefined) {
          if (knownIds.has(item.supersedes)) {
            supersede(this.store, item.supersedes, newId);
            supersededCount++;
            // Supersede başına AYRI kayıt (denetim: prompt-injection-supersede).
            // Transcript metni prompt'a ham giriyor; bir turn "gösterilen
            // bulguyu geçersiz kıl" diyebilir ve model uyabilir. Tam savunma M2
            // kapsamı değil — ölçülebilirlik ve geri alınabilirlik kapsam:
            // hangi oturumun hangi noktası hangi bulguyu kapattı burada yazılı,
            // restore(oldId) tek adım (spec §3.2, K8/K9).
            logEvent(this.store, {
              projectId,
              kind: "finding_superseded",
              detail: { oldId: item.supersedes, newId, sessionId, lastUuid: batch.lastUuid },
            });
          } else {
            droppedSupersedes++;
          }
        }
      }
      this.checkpoint(projectId, sessionId, batch, deliveryKey, processedTurns);
      logEvent(this.store, {
        projectId,
        kind: "observer_batch_ok",
        detail: {
          sessionId, lastUuid: batch.lastUuid, lastTs: batch.lastTs, turnCount: batch.turns.length,
          estTokens: batch.estTokens, newFindings: written,
          superseded: supersededCount, droppedSupersedes,
        },
      });
    });

    this.stats.findings += written;
    this.stats.superseded += supersededCount;
    return "done";
  }

  /**
   * Parti checkpoint'i: teslimatın kaç turn'lük ön ekinin işlendiğini yazar.
   *
   * Eskiden checkpoint partinin uuid/damgasına muhtaçtı ve ikisi de yoksa hiç
   * yazılamıyordu — o parti her koşumda yeniden işleniyor, zehirli parti
   * yolunda SONSUZ maliyet üretiyordu (denetim: missing-checkpoint-identity).
   * O arıza sınıfı artık YAPISAL OLARAK yok: kimlik teslimatın kendisinde,
   * her partinin yazacak bir ilerlemesi var. uuid/damga hâlâ yazılıyor ama
   * yalnız teşhis olarak — hangi turn'e kadar gelindiği okunabilsin diye.
   *
   * Çağrı yeri store.tx içi: bulgu yazımı + filigran aynı işlemde (D-M2-2).
   */
  private checkpoint(
    projectId: number, sessionId: string, batch: Batch, deliveryKey: string, processedTurns: number,
  ): void {
    const res = setWatermark(this.store, {
      projectId, sessionId,
      deliveryKey, deliveryTurns: processedTurns,
      lastUuid: batch.lastUuid, lastTs: batch.lastTs,
    });
    if (res.rewindBlocked !== undefined) {
      logEvent(this.store, {
        projectId,
        kind: "watermark_rewind_blocked",
        detail: {
          sessionId, lastUuid: batch.lastUuid,
          storedTs: res.rewindBlocked.storedTs, incomingTs: res.rewindBlocked.incomingTs,
        },
      });
    }
  }

  /**
   * Kurtarmalı çağrı (spec §3.7): yürütücü hatasında bir tekrar; geçerli çıkış
   * ama bozuk JSON'da bir düzeltmeli yeniden isteme. Sonra pes — parti işlenemedi.
   *
   * Bütçe SERT sınır: bir parti üç çağrıya kadar çıkabildiği için sınır yalnız
   * parti başında denetlenseydi maxCalls 2 çağrı aşılabilirdi. Kurtarma turu
   * sınıra denk gelirse parti iptal edilir; o ana kadarki çağrılar boşa gider
   * ama veri gitmez (filigran ilerlemez, sonraki koşumda yeniden gelir).
   */
  private async callWithRecovery(
    prompt: string,
  ): Promise<{ ok: true; items: ObserverItem[] } | { ok: false; error: string; budget?: true }> {
    const stop = { ok: false, error: "maliyet bütçesi (maxCalls) doldu", budget: true } as const;

    if (!this.hasBudget()) return stop;
    let res = await this.runOnce(prompt);
    if (!res.ok) {
      if (!this.hasBudget()) return stop;
      res = await this.runOnce(prompt); // geçici hata tekrarı (ağ, kota)
    }
    if (!res.ok) return { ok: false, error: `yürütücü: ${res.error}` };

    let parsed = parseObserverOutput(res.output);
    if (parsed.ok) return parsed;

    const corrective =
      `${prompt}\n\nÖNCEKİ ÇIKTIN GEÇERSİZDİ: ${parsed.error}.\n` +
      `Yalnız istenen şemaya uyan JSON döndür, başka hiçbir şey yazma.`;
    if (!this.hasBudget()) return stop;
    const retry = await this.runOnce(corrective);
    if (!retry.ok) return { ok: false, error: `yürütücü (düzeltme turu): ${retry.error}` };
    parsed = parseObserverOutput(retry.output);
    if (parsed.ok) return parsed;
    return { ok: false, error: `geçersiz JSON (iki deneme): ${parsed.error}` };
  }

  private async runOnce(prompt: string) {
    this.stats.calls++;
    return this.executor.run({ prompt, outputSchema: OBSERVER_OUTPUT_SCHEMA });
  }
}
