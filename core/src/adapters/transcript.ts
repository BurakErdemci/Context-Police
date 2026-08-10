// Adapter seam'i. Prototipte tek implementasyon var (Claude Code) ama arayüz
// gün birden tanımlı: sonradan seam açmak pahalıya geliyor (spec K10).
//
// Yeni bir CLI eklemek demek: TranscriptAdapter'ı implemente edip register()
// etmek. Çekirdeğin geri kalanı hangi CLI olduğunu bilmez.

import type { TranscriptAdapter } from "../types.ts";

const registry = new Map<string, TranscriptAdapter>();

export function register(adapter: TranscriptAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAdapter(id: string): TranscriptAdapter {
  const a = registry.get(id);
  if (!a) throw new Error(`bilinmeyen adapter: ${id} (kayıtlı: ${[...registry.keys()].join(", ") || "yok"})`);
  return a;
}

export function listAdapters(): TranscriptAdapter[] {
  return [...registry.values()];
}
