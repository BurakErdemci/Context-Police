// Claude Code transcript adapter'ı.
//
// Format dokümante değil; buradaki her kural 2026-08-10'da gerçek veriden
// ölçüldü (64 transcript, en büyüğü 245 MB / 42.688 satır). Ölçüm ve sayılar:
// docs/superpowers/plans/2026-08-10-m1-cekirdek-ve-tarayici.md

import { createReadStream } from "node:fs";
import { readdir, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type {
  CwdProbe,
  DiscoveredProject,
  DiscoveredSession,
  ParseResult,
  TranscriptAdapter,
  Turn,
} from "../types.ts";

export const ADAPTER_ID = "claude-code";

/**
 * Bulgu taşımayan ama BİLİNEN satır tipleri. Ölçülen 11 tipin 9'u burada;
 * kalan ikisi (user, assistant) turn üretir. Listede olmayan bir tip
 * "unknown" döner ve olaya yazılır — format değişikliği sessiz kayba değil
 * görünür uyarıya dönüşsün diye (spec §3.7).
 */
const KNOWN_SKIP = new Set([
  "queue-operation",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "ai-title",
  "last-prompt",
  "system",
  "mode",
  "permission-mode",
  // Aşağıdaki ikisini aracın kendisi buldu: ilk tam taramada (10 Ağu 2026, 35 silo)
  // "unknown" olarak raporlandılar, incelendi, ikisi de saf üst-veri çıktı —
  // custom-title {customTitle, sessionId}, frame-link {path, frameUrl, title}.
  // Mekanizmanın çalıştığının kanıtı: ölçümde görülmeyen tip sessizce yutulmadı.
  "custom-title",
  "frame-link",
]);

/**
 * İçerik blok süzgeci. Ölçüm: bu kural 243,8 MB'ı 7,8 MB'a indiriyor (31,4×).
 * - text        → tam alınır
 * - tool_use    → yalnız BAŞLIK; parametreler bulgu taşımaz, hacim taşır
 * - tool_result → tamamen atılır (tek başına 178 MB'ın büyük kısmı)
 * - thinking    → atılır: modelin iç sesi kalıcı olgu değil
 * - image/document/fallback → atılır
 */
function filterContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; name?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool_use" && typeof b.name === "string") parts.push(`[araç: ${b.name}]`);
  }
  return parts.join("\n");
}

/**
 * Bilinmeyen satırın "şekli" — teşhis için anahtar adları. Anahtar ADI da
 * transcript'ten gelir ve içerik taşıyabilir: doğrulama turunda bir gizli
 * değer anahtar adı olarak kalıcı olay kaydına geçti. O yüzden yalnız zararsız
 * biçimdeki kısa adlar geçer; kalanı sayı olarak özetlenir.
 */
const KNOWN_KEYS = new Set([
  "type", "operation", "timestamp", "sessionId", "parentUuid", "isSidechain", "promptId",
  "message", "uuid", "permissionMode", "userType", "entrypoint", "cwd", "version", "gitBranch",
  "attachment", "messageId", "snapshot", "isSnapshotUpdate", "aiTitle", "requestId",
  "toolUseResult", "sourceToolAssistantUUID", "slug", "lastPrompt", "logicalParentUuid",
  "subtype", "content", "isMeta", "level", "compactMetadata", "isVisibleInTranscriptOnly",
  "isCompactSummary", "error", "isApiErrorMessage", "leafUuid", "apiErrorStatus", "errorDetails",
  "origin", "sourceToolUseID", "attributionSkill", "attributionPlugin", "cause", "retryInMs",
  "retryAttempt", "maxRetries", "mode", "promptSource", "direction", "trigger", "originalModel",
  "fallbackModel", "retractedMessageUuids", "classifierMetaLines", "toolDenialKind", "mcpMeta",
  "attributionMcpServer", "attributionMcpTool", "snapshotMessageId", "trackingPath", "backup",
  "effort", "hookCount", "hookInfos", "hookErrors", "hookAdditionalContext",
  "preventedContinuation", "stopReason", "hasOutput", "toolUseID", "interruptedByShutdown",
  "session_id", "durationMs", "messageCount", "pendingBackgroundAgentCount",
  "interruptedMessageId", "isAbortedMidStream", "imagePasteIds", "customTitle", "path",
  "frameUrl", "title",
]);

/**
 * YALNIZ bilinen sözlükteki anahtar adları geçer; tanınmayanlar sayı olur.
 * İlk denemem "zararsız biçimdeki kısa adlar" idi ve doğrulama turu onu kırdı:
 * bir API anahtarı da `[A-Za-z0-9_-]{1,40}` desenine uyuyor. Bir dizeyi
 * biçimine bakarak güvenli ilan etmek çalışmıyor; güvenli olan tek şey
 * BİZİM tanıdığımız sabit kelime dağarcığı.
 */
function safeShape(obj: Record<string, unknown>): string[] {
  const keys = Object.keys(obj);
  const known = keys.filter((k) => KNOWN_KEYS.has(k)).sort();
  const unknown = keys.length - known.length;
  return unknown > 0 ? [...known, `(+${unknown} tanınmayan anahtar)`] : known;
}

export function parseLine(line: string): ParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "skip", lineType: "(boş)" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "malformed", bytes: Buffer.byteLength(trimmed, "utf8") };
  }
  // JSON.parse("null") null döner ve typeof null === "object"; alan erişimi
  // atardı. Denetimde ölçüldü: tek bir `null` satırı taramayı kalıcı olarak
  // kilitliyordu — imleç ilerlemediği için her turda aynı yerde patlıyordu.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", bytes: Buffer.byteLength(trimmed, "utf8") };
  }
  const obj = parsed as Record<string, unknown>;

  const type = typeof obj.type === "string" ? obj.type : "(tipsiz)";
  if (type !== "user" && type !== "assistant") {
    return KNOWN_SKIP.has(type)
      ? { kind: "skip", lineType: type }
      : { kind: "unknown", lineType: type, shape: safeShape(obj) };
  }

  const message = obj.message as { content?: unknown } | undefined;
  const text = filterContent(message?.content).trim();
  // Yalnız düşünme ya da yalnız araç çıktısı içeren satırdan turn çıkmaz.
  if (!text) return { kind: "skip", lineType: `${type}(boş-süzgeç)` };

  const turn: Turn = {
    role: type,
    text,
    ...(typeof obj.uuid === "string" ? { uuid: obj.uuid } : {}),
    ...(typeof obj.timestamp === "string" ? { timestamp: obj.timestamp } : {}),
  };
  return { kind: "turn", turn };
}

export interface IncrementalResult {
  turns: Turn[];
  /** Yeni imleç — YALNIZ tam satırların sonu. Yarım satır işlenmez. */
  byteOffset: number;
  counts: { skipped: number; unknown: number; malformed: number };
  /**
   * TİP BAŞINA tek kayıt — sabit sayıda örnek DEĞİL. Denetimde ölçüldü: ilk 5
   * örnekle sınırlıyken 6 farklı bilinmeyen tip içeren bir parti 6.'yı sessizce
   * yutuyordu, ki "bilinmeyen tip asla sessizce yutulmaz" bu modülün sözü.
   * Tip sayısı sınırlı olduğu için tip başına kayıt doğal olarak sınırlı.
   */
  unknownTypes: Map<string, { count: number; shape: string[] }>;
  /** Dosya kısaldı ya da yerine yenisi kondu. */
  truncated: boolean;
  inode: string;
  mtimeMs: number;
}

/**
 * Tek bir satır için üst sınır. Aşan satır MALFORMED sayılır, atlanır ve tampon
 * boşaltılır — böylece imleç ilerler ve maliyet her taramada yeniden ödenmez.
 *
 * Sınır ölçüyle seçildi (11 Ağu 2026, ~/.claude/projects altında 542 MB / tüm
 * .jsonl dosyaları, `awk` ile en uzun satır): gerçek verideki EN BÜYÜK satır
 * 1.610.098 bayt (~1,54 MiB) — büyük bir tool_result. 8 MiB bunun ~5,2 katı,
 * yani gerçek transcript'lerde veri kaybettirmez; ama tek bir dev/yarım satırın
 * tarama döngüsünü CPU'ya boğmasını da engeller.
 *
 * Sınırın ikinci işi bellek: sınırı aşan satırın parçaları BİRİKTİRİLMEZ, yalnız
 * uzunluğu sayılır (imleci doğru ilerletmek için), yani tampon 8 MiB'ı geçmez.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Artımlı okuma. Akış hâlinde okur — 245 MB'lık dosya bile belleğe alınmaz.
 * Bayt üzerinden çalışır (karakter değil): çok baytlı UTF-8 karakterler chunk
 * sınırına denk gelirse metin bozulmasın diye satırlar Buffer olarak biriktirilir.
 *
 * Biriktirme DOĞRUSAL: eski hâli her 64 KiB'lık parçada tamponun tamamını yeni
 * bir Buffer'a kopyalıyordu (Buffer.concat([pending, chunk])), yani n baytlık bir
 * satır için O(n²) kopya. Ölçüldü (bulgu: unbounded-line-buffering): 8 MiB → 32 MiB
 * dosyada süre ~16×, tam karesel. Şimdi parçalar listede tutuluyor ve satır
 * tamamlandığında TEK Buffer.concat yapılıyor — her bayt en fazla bir kez kopyalanır.
 */
export async function readIncremental(
  filePath: string,
  fromOffset: number,
  knownInode?: string | null,
  knownMtimeMs?: number | null,
): Promise<IncrementalResult> {
  const st = await stat(filePath);
  const inode = String(st.ino);
  const mtimeMs = st.mtimeMs;

  // Eski imleç ne zaman anlamını yitirir? Üç işaret, üçü de gerekli:
  //  1. dosya küçüldü,
  //  2. inode değişti (yerine yenisi konmuş),
  //  3. imlecin ötesine hiç veri eklenmemişken dosya DEĞİŞMİŞ (mtime kaydı).
  // Üçüncüsü olmadan bir açık kalıyordu: aynı boyutta, aynı inode ile yerinde
  // yeniden yazılan dosya (boyut, inode) ikilisine göre "hiç değişmemiş"
  // görünüyor ve yeni içerik sessizce kayboluyordu. Denetimde ölçüldü.
  const replacedInPlace =
    knownMtimeMs != null && st.size <= fromOffset && mtimeMs !== knownMtimeMs;
  const truncated =
    st.size < fromOffset || (knownInode != null && knownInode !== inode) || replacedInPlace;
  const start = truncated ? 0 : fromOffset;

  const res: IncrementalResult = {
    turns: [],
    byteOffset: start,
    counts: { skipped: 0, unknown: 0, malformed: 0 },
    unknownTypes: new Map(),
    truncated,
    inode,
    mtimeMs,
  };

  if (start >= st.size) return res;

  const stream = createReadStream(filePath, { start });
  // Değişmez: `parts` içindeki hiçbir parça "\n" İÇERMEZ; hepsi işlenmemiş
  // satırın kuyruğudur. Yeni gelen parçadaki newline'ları doğrudan o parçada
  // arıyoruz — birikmiş tamponu yeniden taramaya gerek yok.
  let parts: Buffer[] = [];
  let pendingLen = 0;
  /** İçinde bulunduğumuz satır sınırı aştı: parçaları at, yalnız uzunluğu say. */
  let overlong = false;
  let consumed = start;

  for await (const c of stream) {
    let chunk = c as Buffer;

    let nl: number;
    while ((nl = chunk.indexOf(0x0a)) !== -1) {
      const head = chunk.subarray(0, nl);
      chunk = chunk.subarray(nl + 1);
      const lineLen = pendingLen + head.length;
      consumed += lineLen + 1;

      if (overlong || lineLen > MAX_LINE_BYTES) {
        // Sessiz kayıp yok: mevcut malformed sayacına yazılır, o da scan.ts'te
        // `malformed_line` olayına dönüşür.
        res.counts.malformed++;
      } else {
        // Tek concat: satır tamamlandığında, tam boyu bilinerek.
        let lineBuf: Buffer;
        if (pendingLen === 0) lineBuf = head;
        else {
          parts.push(head);
          lineBuf = Buffer.concat(parts, lineLen);
        }
        const parsed = parseLine(lineBuf.toString("utf8"));
        if (parsed.kind === "turn") res.turns.push(parsed.turn);
        else if (parsed.kind === "skip") res.counts.skipped++;
        else if (parsed.kind === "unknown") {
          res.counts.unknown++;
          const prev = res.unknownTypes.get(parsed.lineType);
          if (prev) prev.count++;
          else res.unknownTypes.set(parsed.lineType, { count: 1, shape: parsed.shape });
        } else {
          res.counts.malformed++;
        }
      }
      parts = [];
      pendingLen = 0;
      overlong = false;
    }

    // Parçanın newline'sız kuyruğu bir sonraki satırın parçası.
    if (chunk.length > 0) {
      if (overlong || pendingLen + chunk.length > MAX_LINE_BYTES) {
        overlong = true;
        parts = []; // biriktirmeyi bırak: bellek sınırlı kalsın
        pendingLen += chunk.length; // ama uzunluğu say: imleç doğru ilerlemeli
      } else {
        parts.push(chunk);
        pendingLen += chunk.length;
      }
    }
  }

  // pending'de kalan = yarım satır. İmleç onun BAŞINDA bırakılır; "\n" gelince
  // sonraki turda tam olarak işlenir (spec §3.3).
  res.byteOffset = consumed;
  return res;
}

/**
 * Transcript'in içindeki cwd alanı — proje yolunun tek güvenilir kaynağı.
 *
 * readIncremental ile AYNI biriktirme sözleşmesi, aynı sebeple. İlk düzeltme
 * yalnız readIncremental'i doğrusallaştırmıştı; doğrulama turu aynı karesel
 * kalıbın burada sürdüğünü ÖLÇTÜ (bulgu: unbounded-line-buffering, ikinci yüzey):
 * cwd satırından önceki tek satır 8 MiB → 32 MiB büyüdüğünde okuma ~55 ms'den
 * ~940 ms'ye çıkıyordu — 4 kat girdi, ~17 kat maliyet. Sebep `pending += chunk`
 * ve her parçada `pending.split("\n")`: n baytlık satır için O(n²).
 *
 * İki ek fayda: (1) satır artık TAM Buffer olarak decode ediliyor, yani çok
 * baytlı UTF-8 karakter 64 KiB parça sınırına denk gelse bile bozulmuyor (eski
 * hâl her parçayı ayrı ayrı `toString("utf8")` yapıyordu); (2) bayt tavanı.
 *
 * BAYT TAVANI NEDEN GEREKLİ: `maxLines` satır SAYISINI sınırlar, satır BOYUNU
 * değil. Keşif yolu güvenilmeyen/bozuk transcript'e bakıyor ve tek bir 245 MB'lık
 * satır tavan olmadan bütünüyle belleğe alınırdı. Sınır readIncremental ile aynı
 * (MAX_LINE_BYTES) — tek bir eşik olsun; aşan satır atlanır, keşif durmaz.
 */
export async function readCwd(filePath: string, maxLines = 50): Promise<string | null> {
  return (await readCwdDetailed(filePath, maxLines)).cwd;
}

/**
 * `readCwd`in SEBEP TAŞIYAN hâli. İki çağrı ayrı, çünkü `readCwd`in dar dönüşü
 * (`string | null`) çağrı yerinde üç farklı durumu tek değere eziyordu:
 * "cwd alanı yok", "satırlar bozuk JSON" ve "dosya hiç okunamadı" (izin, EIO).
 * İlki normaldir (saf üst-veri transcript'i), diğer ikisi düzeltilebilir bir
 * kurulum hatasıdır — ve proje `unresolved` işaretlenip TAHMİNİ yolla
 * (`guessPathFromKey`) kaydedildiği için ayrım kullanıcı açısından pahalı.
 *
 * Okuma arızası burada YAKALANMAZ: fırlar, çağıran sınıflandırır. Sayımlı
 * raporlama kalıbı `safeShape` ile aynı (tanınmayan anahtarlar da yutulmaz,
 * sayılır).
 */
export interface CwdProbeResult {
  /** Bulunan cwd; alan hiç yoksa null. */
  cwd: string | null;
  /** Bakılan satır sayısı (tavan `maxLines`). */
  scannedLines: number;
  /** JSON olarak ayrıştırılamayan satır sayısı — 0 değilse dosya bozuk. */
  malformedLines: number;
  /** MAX_LINE_BYTES tavanını aştığı için hiç bakılmayan satır sayısı. */
  overlongLines: number;
}

export async function readCwdDetailed(filePath: string, maxLines = 50): Promise<CwdProbeResult> {
  const res: CwdProbeResult = { cwd: null, scannedLines: 0, malformedLines: 0, overlongLines: 0 };
  const fh = await open(filePath, "r");
  try {
    let seen = 0;
    // Değişmez: `parts` içindeki hiçbir parça "\n" İÇERMEZ.
    let parts: Buffer[] = [];
    let pendingLen = 0;
    let overlong = false;
    const buf = Buffer.alloc(64 * 1024);

    /** @returns bulunan cwd, yoksa null. */
    const takeLine = (line: Buffer): string | null => {
      const text = line.toString("utf8");
      if (!text.trim()) return null;
      try {
        const o = JSON.parse(text) as { cwd?: unknown };
        if (typeof o.cwd === "string" && o.cwd) return o.cwd;
      } catch {
        /* bozuk satır keşfi durdurmaz — ama SAYILIR (bkz. CwdProbeResult) */
        res.malformedLines++;
      }
      return null;
    };

    while (seen < maxLines) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let chunk = buf.subarray(0, bytesRead);

      let nl: number;
      while ((nl = chunk.indexOf(0x0a)) !== -1) {
        const head = chunk.subarray(0, nl);
        chunk = chunk.subarray(nl + 1);
        const lineLen = pendingLen + head.length;

        if (!overlong && lineLen <= MAX_LINE_BYTES) {
          // Tek concat: satır tamamlandığında, tam boyu bilinerek.
          let lineBuf: Buffer;
          if (pendingLen === 0) lineBuf = head;
          else {
            // `head` kopyalanmadan eklenebilir: concat aynı yinelemede, bir
            // sonraki fh.read()'ten ÖNCE çalışıyor — `buf` henüz bozulmadı.
            parts.push(head);
            lineBuf = Buffer.concat(parts, lineLen);
          }
          const cwd = takeLine(lineBuf);
          if (cwd !== null) {
            res.cwd = cwd;
            res.scannedLines = seen + 1;
            return res;
          }
        } else {
          res.overlongLines++;
        }
        parts = [];
        pendingLen = 0;
        overlong = false;
        if (++seen >= maxLines) {
          res.scannedLines = seen;
          return res;
        }
      }

      if (chunk.length > 0) {
        if (overlong || pendingLen + chunk.length > MAX_LINE_BYTES) {
          overlong = true;
          parts = [];                   // biriktirmeyi bırak: bellek sınırlı kalsın
          pendingLen += chunk.length;   // uzunluğu saymaya devam: tavan doğru uygulansın
        } else {
          // subarray `buf`a bakar ve `buf` bir sonraki read'de üzerine yazılır;
          // saklanacak her parça kopyalanmak zorunda. Kopya parça başına O(k),
          // toplamda doğrusal — karesel olan eskinin dize birleştirmesiydi.
          parts.push(Buffer.from(chunk));
          pendingLen += chunk.length;
        }
      }
    }
    // Dosya sonundaki newline'sız kuyruk da bir satır: eski hâl onu hiç
    // bakmadan atıyordu, yani tek satırlık (newline'sız) transcript'te cwd
    // bulunamıyordu.
    if (pendingLen > 0 && seen < maxLines) {
      if (overlong) res.overlongLines++;
      else {
        seen++;
        const cwd = takeLine(Buffer.concat(parts, pendingLen));
        if (cwd !== null) res.cwd = cwd;
      }
    }
    res.scannedLines = seen;
  } finally {
    await fh.close();
  }
  return res;
}

/**
 * Dizin anahtarından yola kaba çözüm. Yalnız cwd bulunamazsa kullanılır ve
 * KAYIPLIDIR: anahtar üretimi alfanümerik olmayanı "-" yaptığı için tersi
 * belirsiz. M0'da gerçek vaka: "unityaıPython" → "unitya-Python", geri
 * çevrilince var olmayan "unitya/Python" çıkıyor. Bu yüzden cwd önceliklidir.
 */
function guessPathFromKey(key: string): string | null {
  const candidate = "/" + key.replace(/^-/, "").split("-").join("/");
  return existsSync(candidate) ? candidate : null;
}

export async function discover(root?: string): Promise<DiscoveredProject[]> {
  const projectsRoot = root ?? join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return [];

  const out: DiscoveredProject[] = [];
  const entries = await readdir(projectsRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsRoot, entry.name);
    try {
      out.push(await discoverOne(dir));
    } catch (err) {
      // Okunamayan tek bir silo keşfin tamamını öldürmemeli: doğrulama turunda
      // ölçüldü, izinsiz bir dizin yüzünden sağlam projeler hiç taranmıyordu.
      out.push({
        path: dir,
        transcriptDir: dir,
        memoryDir: null,
        unresolved: true,
        sessions: [],
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function discoverOne(dir: string): Promise<DiscoveredProject> {
  {
    const files = (await readdir(dir, { withFileTypes: true }))
      .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
      .map((f) => f.name);

    const sessions: DiscoveredSession[] = [];
    for (const name of files) {
      const full = join(dir, name);
      const st = await stat(full);
      sessions.push({
        sessionId: name.replace(/\.jsonl$/, ""),
        filePath: full,
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    }
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

    // Yol çözümü: önce transcript'in kendi cwd'si (kayıpsız), sonra anahtar tahmini.
    //
    // SEBEP SAĞ KALIR. Eski hâl `readCwd(...).catch(() => null)` idi: izin
    // hatası, bozuk JSONL ve "cwd alanı yok" tek bir `null`'a düşüyordu, proje
    // `unresolved` olarak TAHMİNİ yolla kaydediliyor ve errno hiçbir olayda
    // görünmüyordu. Dıştaki `discover()` yakalayıcısı bu dalı hiç görmüyor
    // (hata burada yutuluyordu), yani teşhis için tek bir iz bile kalmıyordu.
    // Artık her deneme bir kayda dönüşüyor; sınıflandırmayı scan.ts yapıyor.
    let path: string | null = null;
    const cwdProbes: CwdProbe[] = [];
    for (const sess of sessions.slice(0, 3)) {
      // Okunamayan tek bir oturum dosyası keşfi bozmamalı: o dosya okuma
      // aşamasında `session_read_failed` olarak raporlanır, keşif ise
      // sonraki oturumdan cwd bulmayı dener (doğrulama turu bulgusu).
      try {
        const r = await readCwdDetailed(sess.filePath);
        if (r.cwd) {
          path = r.cwd;
          break;
        }
        cwdProbes.push({
          sessionId: sess.sessionId,
          // "cwd yok" ile "okuyamadım" ayrı görünsün: ilki bir arıza DEĞİL.
          outcome: r.malformedLines > 0 ? "malformed" : "no_cwd",
          malformedLines: r.malformedLines,
          overlongLines: r.overlongLines,
          scannedLines: r.scannedLines,
        });
      } catch (err) {
        cwdProbes.push({
          sessionId: sess.sessionId,
          outcome: "read_failed",
          code: typeof (err as NodeJS.ErrnoException).code === "string" ? (err as NodeJS.ErrnoException).code : null,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    }
    const unresolved = path === null;
    if (!path) path = guessPathFromKey(basename(dir));

    return {
      path: path ?? dir,
      transcriptDir: dir,
      memoryDir: existsSync(join(dir, "memory")) ? join(dir, "memory") : null,
      unresolved: unresolved && path === null,
      sessions,
      cwdProbes,
    };
  }
}

export const claudeCodeAdapter: TranscriptAdapter = {
  id: ADAPTER_ID,
  discover,
  parseLine,
};
