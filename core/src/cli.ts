#!/usr/bin/env node
// Çekirdeğin UI'sız girişi. Tauri kabuğu bunu sidecar olarak başlatacak;
// geliştirme ve ölçüm sırasında doğrudan kullanılır.

import { openStore, defaultStorePath } from "./store/db.ts";
import { claudeCodeAdapter } from "./adapters/claude-code.ts";
import { register } from "./adapters/transcript.ts";
import { scanOnce } from "./scan.ts";
import { listProjects } from "./store/projects.ts";
import { listEvents, countEvents } from "./store/events.ts";

register(claudeCodeAdapter);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";

async function cmdScan(): Promise<void> {
  const storePath = arg("store") ?? defaultStorePath();
  const store = openStore(storePath);
  try {
    const started = Date.now();
    const sum = await scanOnce(store, { adapter: claudeCodeAdapter, root: arg("dir") });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`depo: ${storePath}`);
    console.log(`proje: ${sum.projects}  (çözülemeyen: ${sum.unresolvedProjects})`);
    console.log(`dokunulan oturum: ${sum.sessionsTouched}`);
    console.log(`turn: ${sum.turns}`);
    console.log(
      `okunan: ${mb(sum.bytesRead)} → süzülmüş: ${mb(sum.filteredBytes)}` +
        (sum.filteredBytes > 0 ? `  (${(sum.bytesRead / sum.filteredBytes).toFixed(1)}× küçülme)` : ""),
    );
    console.log(`atlanan satır: ${sum.skipped}  bilinmeyen tip: ${sum.unknown}  bozuk: ${sum.malformed}`);
    if (sum.truncations > 0) console.log(`kısalma tespiti: ${sum.truncations}`);
    console.log(`süre: ${secs} sn`);

    if (sum.unknown > 0) {
      console.log("\n⚠ bilinmeyen satır tipleri (format değişmiş olabilir):");
      const seen = new Set<string>();
      for (const e of listEvents(store, { kind: "unknown_line_type", limit: 50 })) {
        const t = JSON.parse(e.detail ?? "{}").lineType as string;
        if (t && !seen.has(t)) {
          seen.add(t);
          console.log(`  - ${t}`);
        }
      }
    }
  } finally {
    store.close();
  }
}

function cmdStatus(): void {
  const store = openStore(arg("store") ?? defaultStorePath());
  try {
    const projects = listProjects(store);
    console.log(`proje: ${projects.length}`);
    for (const p of projects) console.log(`  ${p.path}${p.memory_dir ? "  [memory ✓]" : ""}`);
    console.log(`\nolaylar: tarama ${countEvents(store, "scan_completed")}, ` +
      `bilinmeyen tip ${countEvents(store, "unknown_line_type")}, ` +
      `bozuk satır ${countEvents(store, "malformed_line")}, ` +
      `kısalma ${countEvents(store, "truncation_detected")}`);
  } finally {
    store.close();
  }
}

const cmd = process.argv[2];
if (cmd === "scan") await cmdScan();
else if (cmd === "status") cmdStatus();
else {
  console.log(`context-police — AI ajan hafızası denetçisi (çekirdek)

kullanım:
  context-police scan   [--dir <transcript kökü>] [--store <db yolu>]
  context-police status [--store <db yolu>]`);
  process.exit(cmd ? 1 : 0);
}
