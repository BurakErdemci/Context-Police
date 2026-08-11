// Gözlemci döngüsü: scanOnce'ın onTurns kancasına takılır (M1'deki bilinçli
// ayrım — tarama okur, gözlemci yorumlar).
//
// Teslim en-az-bir-kez (scan.ts sözleşmesi). Mükerrer üretim filigranla kesilir
// (D-M2-2): bulgu yazımı + filigran aynı tx'te, etki tam-bir-kez. Zehirli parti
// görünür kayıpla atlanır (D-M2-3): sonsuz maliyet döngüsü yok, transcript diskte.

import type { Store } from "../store/db.ts";
import type { ExecutorAdapter } from "../adapters/executor.ts";
import type { Turn } from "../types.ts";
import { cutBatches, dropThroughWatermark, type Batch } from "./batch.ts";
import {
  OBSERVER_OUTPUT_SCHEMA, buildObserverPrompt, buildStateTitles, parseObserverOutput, type ObserverItem,
} from "./prompt.ts";
import { appendFinding, listActive, supersede } from "../store/findings.ts";
import { getWatermark, setWatermark } from "../store/watermarks.ts";
import { logEvent } from "../store/events.ts";

export interface ObserverOptions {
  store: Store;
  executor: ExecutorAdapter;
  /** Parti eşiği. Varsayılan 8000 (spec §3.3); en büyük gerçek oturum ~2M token → ~250 çağrı. */
  batchTokens?: number;
}

export interface ObserverStats {
  batches: number;
  calls: number;
  findings: number;
  superseded: number;
  unprocessed: number;
  /** Filigranla elenen tekrar-teslim turn'leri. */
  skippedTurns: number;
}

const DEFAULT_BATCH_TOKENS = 8000;

export class Observer {
  readonly stats: ObserverStats = { batches: 0, calls: 0, findings: 0, superseded: 0, unprocessed: 0, skippedTurns: 0 };
  private readonly store: Store;
  private readonly executor: ExecutorAdapter;
  private readonly batchTokens: number;

  constructor(opts: ObserverOptions) {
    this.store = opts.store;
    this.executor = opts.executor;
    this.batchTokens = opts.batchTokens ?? DEFAULT_BATCH_TOKENS;
  }

  /** scanOnce onTurns'a doğrudan verilir: (ctx) => observer.handleTurns(ctx). */
  async handleTurns(ctx: { projectId: number; sessionId: string; turns: Turn[] }): Promise<void> {
    const wm = getWatermark(this.store, ctx.projectId, ctx.sessionId);
    const fresh = dropThroughWatermark(ctx.turns, wm?.lastUuid ?? null);
    this.stats.skippedTurns += ctx.turns.length - fresh.length;
    if (fresh.length === 0) return;

    for (const batch of cutBatches(fresh, this.batchTokens)) {
      await this.processBatch(ctx.projectId, ctx.sessionId, batch);
    }
  }

  private async processBatch(projectId: number, sessionId: string, batch: Batch): Promise<void> {
    this.stats.batches++;
    const projectPath =
      this.store.get<{ path: string }>("SELECT path FROM projects WHERE id = ?", projectId)?.path ?? "(bilinmiyor)";

    // Durum her partide TAZE okunur: önceki partinin bulguları sonrakinin
    // başlık listesinde görünmeli, yoksa aynı taramada mükerrer üretilir.
    const active = listActive(this.store, projectId);
    const { titles, omitted } = buildStateTitles(active);
    const prompt = buildObserverPrompt({ projectPath, titles, omitted, turns: batch.turns });

    const outcome = await this.callWithRecovery(prompt);
    if (!outcome.ok) {
      // Görünür kayıp: olay uuid aralığını taşır, transcript diskte —
      // ileride elle ya da toplu yeniden işleme mümkün.
      this.stats.unprocessed++;
      this.store.tx(() => {
        logEvent(this.store, {
          projectId,
          kind: "observer_batch_unprocessed",
          detail: {
            sessionId, lastUuid: batch.lastUuid, turnCount: batch.turns.length,
            estTokens: batch.estTokens, error: outcome.error,
          },
        });
        if (batch.lastUuid != null)
          setWatermark(this.store, { projectId, sessionId, lastUuid: batch.lastUuid });
      });
      return;
    }

    const knownIds = new Set(active.map((f) => f.id));
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
          // Yalnız gözlemciye GÖSTERİLEN id'ler supersede edilebilir: model
          // rastgele/yabancı id söyleyerek başka projenin kaydını kapatamaz.
          if (knownIds.has(item.supersedes)) {
            supersede(this.store, item.supersedes, newId);
            supersededCount++;
          } else {
            droppedSupersedes++;
          }
        }
      }
      if (batch.lastUuid != null)
        setWatermark(this.store, { projectId, sessionId, lastUuid: batch.lastUuid });
      logEvent(this.store, {
        projectId,
        kind: "observer_batch_ok",
        detail: {
          sessionId, lastUuid: batch.lastUuid, turnCount: batch.turns.length,
          estTokens: batch.estTokens, newFindings: written,
          superseded: supersededCount, droppedSupersedes,
        },
      });
    });

    this.stats.findings += written;
    this.stats.superseded += supersededCount;
  }

  /**
   * Kurtarmalı çağrı (spec §3.7): yürütücü hatasında bir tekrar; geçerli çıkış
   * ama bozuk JSON'da bir düzeltmeli yeniden isteme. Sonra pes — parti işlenemedi.
   */
  private async callWithRecovery(
    prompt: string,
  ): Promise<{ ok: true; items: ObserverItem[] } | { ok: false; error: string }> {
    let res = await this.runOnce(prompt);
    if (!res.ok) res = await this.runOnce(prompt); // geçici hata tekrarı (ağ, kota)
    if (!res.ok) return { ok: false, error: `yürütücü: ${res.error}` };

    let parsed = parseObserverOutput(res.output);
    if (parsed.ok) return parsed;

    const corrective =
      `${prompt}\n\nÖNCEKİ ÇIKTIN GEÇERSİZDİ: ${parsed.error}.\n` +
      `Yalnız istenen şemaya uyan JSON döndür, başka hiçbir şey yazma.`;
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
