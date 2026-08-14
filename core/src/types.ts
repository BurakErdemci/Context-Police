// Çekirdeğin ortak tipleri. Depo ve adapter'lar bu tipler üzerinden konuşur;
// hiçbir modül başka bir modülün iç temsilini bilmez.

/** Süzülmüş bir konuşma turn'ü — gözlemciye (M2) girecek tek veri biçimi. */
export interface Turn {
  /** Transcript'teki satır tipi: "user" | "assistant" */
  role: "user" | "assistant";
  /** Süzülmüş metin. Araç çıktıları ve düşünme blokları burada ASLA yer almaz. */
  text: string;
  /** Satırın oturum içindeki uuid'si — bulgu çapası olarak kullanılır. */
  uuid?: string;
  timestamp?: string;
}

export type ParseResult =
  | { kind: "turn"; turn: Turn }
  /** Bilinen ama bulgu taşımayan satır tipi (file-history-snapshot, mode, …). */
  | { kind: "skip"; lineType: string }
  /**
   * Tanınmayan satır tipi — sessizce yutulmaz, events'e loglanır (spec §3.7).
   * `shape` yalnız üst düzey ANAHTAR adlarıdır, değer taşımaz: format
   * değişikliğini teşhis etmeye yeter, transcript içeriğini diske taşımaz.
   * (Denetim bulgusu: ham satır örneği saklanınca oturumdaki bir API anahtarı
   * silinemez denetim günlüğüne kalıcı olarak düşebiliyordu.)
   */
  | { kind: "unknown"; lineType: string; shape: string[] }
  /** JSON olarak ayrıştırılamayan satır. İçerik değil, yalnız boyut taşınır. */
  | { kind: "malformed"; bytes: number };

export interface DiscoveredSession {
  sessionId: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface DiscoveredProject {
  /** Transcript dizin anahtarından çözülen gerçek proje yolu. */
  path: string;
  /** ~/.claude/projects/<anahtar> dizini. */
  transcriptDir: string;
  /** Hafıza dosyalarının dizini; yoksa null. */
  memoryDir: string | null;
  /** Dizin anahtarı gerçek bir yola çözülemedi — atlanmaz, raporlanır (M0'daki `ı` vakası). */
  unresolved: boolean;
  sessions: DiscoveredSession[];
  /** Bu silo okunamadı; diğerleri etkilenmez, sebep olaya yazılır. */
  error?: string;
  /**
   * cwd'den yol çözme denemelerinin SONUÇSUZ kalanları. Boş dizi = ilk
   * denemede çözüldü. Var olma sebebi: eski hâlde üç ayrı durum ("cwd yok",
   * "bozuk JSONL", "okuyamadım") tek bir `null`'a düşüyordu ve proje tahmini
   * yolla kaydedilirken errno hiçbir yerde görünmüyordu.
   */
  cwdProbes?: CwdProbe[];
}

/** Tek bir oturum dosyasından cwd okuma denemesinin sonucu. */
export interface CwdProbe {
  sessionId: string;
  /**
   * `no_cwd` — dosya okundu, cwd alanı yok (ARIZA DEĞİL: saf üst-veri
   * transcript'i böyle görünür). `malformed` — bakılan satırların bir kısmı
   * JSON değil. `read_failed` — dosya hiç açılamadı/okunamadı; `code` errno.
   */
  outcome: "no_cwd" | "malformed" | "read_failed";
  code?: string | null;
  error?: string;
  scannedLines?: number;
  malformedLines?: number;
  overlongLines?: number;
}

export interface TranscriptAdapter {
  /** Kalıcı kimlik — depoya yazılır, ileride çok adapter'lı ayrıma yarar. */
  readonly id: string;
  discover(root?: string): Promise<DiscoveredProject[]>;
  parseLine(line: string): ParseResult;
}

export type FindingSource = "observed" | "imported";

export type FindingStatus =
  | "active"
  | "suspect"
  | "superseded"
  /** İddia yazıldığı gün de yanlıştı — çürüme değil doğum kusuru (M0-D2). */
  | "born_invalid"
  /** Kod çapası yok. Nötr durum: şüphe üretmez (M0-D5). */
  | "unanchored";

export type AnchorKind = "file_path" | "symbol" | "commit_sha" | "external_path";

export interface Anchor {
  kind: AnchorKind;
  value: string;
  takenAtCommit?: string | null;
}

export interface Finding {
  id: number;
  projectId: number;
  source: FindingSource;
  content: string;
  sourceRef: string | null;
  createdAt: string;
  status: FindingStatus;
  supersededBy: number | null;
  suspicion: number;
}
