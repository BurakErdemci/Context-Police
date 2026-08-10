// Claude Code transcript adapter'ı.
//
// Format dokümante değil; buradaki her kural 2026-08-10'da gerçek veriden
// ölçüldü (64 transcript, en büyüğü 245 MB / 42.688 satır). Ölçüm ve sayılar:
// docs/superpowers/plans/2026-08-10-m1-cekirdek-ve-tarayici.md

import { createReadStream } from "node:fs";
import { readdir, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
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
      : { kind: "unknown", lineType: type, shape: Object.keys(obj).sort() };
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
 * Artımlı okuma. Akış hâlinde okur — 245 MB'lık dosya bile belleğe alınmaz.
 * Bayt üzerinden çalışır (karakter değil): çok baytlı UTF-8 karakterler chunk
 * sınırına denk gelirse metin bozulmasın diye satırlar Buffer olarak biriktirilir.
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
  let pending: Buffer = Buffer.alloc(0);
  let consumed = start;

  for await (const chunk of stream) {
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);

    let nl: number;
    while ((nl = pending.indexOf(0x0a)) !== -1) {
      const lineBuf = pending.subarray(0, nl);
      pending = pending.subarray(nl + 1);
      consumed += lineBuf.length + 1;

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
  }

  // pending'de kalan = yarım satır. İmleç onun BAŞINDA bırakılır; "\n" gelince
  // sonraki turda tam olarak işlenir (spec §3.3).
  res.byteOffset = consumed;
  return res;
}

/** Transcript'in içindeki cwd alanı — proje yolunun tek güvenilir kaynağı. */
async function readCwd(filePath: string, maxLines = 50): Promise<string | null> {
  const fh = await open(filePath, "r");
  try {
    let seen = 0;
    let pending = "";
    const buf = Buffer.alloc(64 * 1024);
    while (seen < maxLines) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      pending += buf.subarray(0, bytesRead).toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (++seen > maxLines) break;
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { cwd?: unknown };
          if (typeof o.cwd === "string" && o.cwd) return o.cwd;
        } catch {
          /* bozuk satır keşfi durdurmaz */
        }
      }
    }
  } finally {
    await fh.close();
  }
  return null;
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
    let path: string | null = null;
    for (const s of sessions.slice(0, 3)) {
      path = await readCwd(s.filePath);
      if (path) break;
    }
    const unresolved = path === null;
    if (!path) path = guessPathFromKey(entry.name);

    out.push({
      path: path ?? join(projectsRoot, entry.name),
      transcriptDir: dir,
      memoryDir: existsSync(join(dir, "memory")) ? join(dir, "memory") : null,
      unresolved: unresolved && path === null,
      sessions,
    });
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export const claudeCodeAdapter: TranscriptAdapter = {
  id: ADAPTER_ID,
  discover,
  parseLine,
};
