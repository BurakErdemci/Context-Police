// CLI çıkış kodları. Ayrı modül, çünkü `cli.ts` bir BETİK: import edildiği anda
// argv'yi ayrıştırıp komutu koşturuyor. Testin bir sabiti okuyabilmesi için
// sabitin betikten bağımsız bir evi olmalı.
//
// Sözleşme: her kod ayrı bir EYLEM ima eder. Betikle koşan biri "argümanı
// düzelt" ile "biraz sonra tekrar dene"yi ancak koddan ayırt edebiliyor —
// ölçüldü (probes/lock-busy-exit-is-usage.sh): kilit çakışması da kullanım
// hatası da rc=1 dönüyordu, üstelik çakışma yakalanmamış istisna olarak
// yığın izi basıyordu.

/** Kullanım hatası: argümanı düzelt, tekrar denemenin faydası yok. */
export const EXIT_USAGE = 1;
/** Codex bulunamadı: kur. */
export const EXIT_NO_CODEX = 2;
/** Maliyet kapısı: --yes ile onayla. */
export const EXIT_NEEDS_APPROVAL = 3;
/** Bütçe doldu: iş yarım kaldı, veri kaybı yok, tekrar koş. */
export const EXIT_BUDGET = 4;
/**
 * Tarama kilidi başkasında: GEÇİCİ durum, argümanlar doğru. Tek doğru tepki
 * beklemek ve tekrar denemek — bu yüzden kullanım hatasından ayrı kod.
 */
export const EXIT_LOCK_BUSY = 5;
