'use client';

import { useMemo } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { X } from 'lucide-react';
import type { PageIndexEntry } from '@/lib/afp/types';

interface FontEntry {
  name: string;
  type: string;
  weight: string;
  family: string;
  codePage: string;
}

function decodeEbcdic(view: DataView, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < view.byteLength; i++) {
    const b = view.getUint8(i);
    if (b === 0x00) continue; // null
    else if (b === 0x40) s += ' ';
    // Uppercase A-I, J-R, S-Z
    else if (b >= 0xC1 && b <= 0xC9) s += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) s += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) s += String.fromCharCode(83 + b - 0xE2);
    // Lowercase a-i, j-r, s-z
    else if (b >= 0x81 && b <= 0x89) s += String.fromCharCode(97 + b - 0x81);
    else if (b >= 0x91 && b <= 0x99) s += String.fromCharCode(106 + b - 0x91);
    else if (b >= 0xA2 && b <= 0xA9) s += String.fromCharCode(115 + b - 0xA2);
    // Digits 0-9
    else if (b >= 0xF0 && b <= 0xF9) s += String.fromCharCode(48 + b - 0xF0);
    // Common punctuation
    else if (b === 0x6D) s += '_';
    else if (b === 0x7D) s += "'";
    else if (b === 0x4B) s += '.';
    else if (b === 0x6B) s += ',';
    else if (b === 0x60) s += '-';
    else if (b === 0x61) s += '/';
    else if (b === 0x7B) s += '#';
    else if (b === 0x7C) s += '@';
    else if (b === 0x4D) s += '(';
    else if (b === 0x5D) s += ')';
    else if (b === 0x7E) s += '=';
    else if (b === 0x5C) s += '*';
    else if (b === 0x50) s += '&';
    else if (b === 0x7A) s += ':';
    else if (b === 0x5E) s += ';';
    else if (b === 0x4F) s += '!';
    else if (b >= 0x20 && b < 0x7F) s += String.fromCharCode(b);
  }
  return s.trim();
}

export function DocumentInfo() {
  const docInfoOpen = useAfpViewerStore((s) => s.docInfoOpen);
  const fileData = useAfpViewerStore((s) => s.fileData);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const totalPages = useAfpViewerStore((s) => s.totalPages);
  const currentPage = useAfpViewerStore((s) => s.currentPage);
  const pageIndex = useAfpViewerStore((s) => s.pageIndex);

  // Scan document-level TLEs and NOPs (before first BPG)
  const docMeta = useMemo(() => {
    if (!fileData) return [];
    const view = new DataView(fileData);
    const entries: { type: string; key: string; value: string }[] = [];
    let offset = 0;

    while (offset < fileData.byteLength - 9) {
      if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
      const len = view.getUint16(offset + 1, false);
      if (len < 6 || len > 32766) { offset++; continue; }
      const typeId = view.getUint8(offset + 3).toString(16).toUpperCase().padStart(2, '0') +
                     view.getUint8(offset + 4).toString(16).toUpperCase().padStart(2, '0') +
                     view.getUint8(offset + 5).toString(16).toUpperCase().padStart(2, '0');
      const dl = len - 8;

      // Stop at BDT, BRG, BOC, or BPG — only collect truly top-level metadata
      if (typeId === 'D3A8A8' || typeId === 'D3A8C6' || typeId === 'D3A8CE' || typeId === 'D3A8AD') break;

      // TLE (D3A090) — document-level metadata
      if (typeId === 'D3A090' && dl > 4) {
        let tp = offset + 9;
        const tEnd = offset + 9 + dl;
        let key = '', value = '';
        while (tp + 2 < tEnd) {
          const tLen = view.getUint8(tp);
          const tId = view.getUint8(tp + 1);
          if (tLen < 2 || tp + tLen > tEnd) break;
          if (tId === 0x02 && tLen > 4) key = decodeEbcdic(view, tp + 4, tLen - 4);
          if (tId === 0x36 && tLen > 4) value = decodeEbcdic(view, tp + 4, tLen - 4);
          tp += tLen;
        }
        if (key || value) entries.push({ type: 'TLE', key, value });
      }

      // NOP (D3EEEE) — comment/metadata
      if (typeId === 'D3EEEE' && dl > 0) {
        const text = decodeEbcdic(view, offset + 9, Math.min(dl, 80));
        if (text.length > 2) entries.push({ type: 'NOP', key: '', value: text });
      }

      const next = offset + 1 + len;
      if (next <= offset) break;
      offset = next;
    }
    return entries;
  }, [fileData]);

  const info = useMemo(() => {
    if (!fileData) return null;

    const view = new DataView(fileData);
    const fonts: FontEntry[] = [];
    const seen = new Set<string>();
    let currentBOC = '';
    let currentFamily = '';
    let docName = '';
    const fileSize = fileData.byteLength;

    let offset = 0;
    while (offset < fileData.byteLength - 9) {
      if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
      const len = view.getUint16(offset + 1, false);
      if (len < 6 || len > 32766) { offset++; continue; }
      const typeId = view.getUint8(offset + 3).toString(16).toUpperCase().padStart(2, '0') +
                     view.getUint8(offset + 4).toString(16).toUpperCase().padStart(2, '0') +
                     view.getUint8(offset + 5).toString(16).toUpperCase().padStart(2, '0');
      const dl = len - 8;

      // BDT — document name (first one only)
      if (typeId === 'D3A8A8' && dl >= 8 && !docName) {
        docName = decodeEbcdic(view, offset + 9, 8);
      }

      // BOC — track font containers
      if (typeId === 'D3A8CE' && dl >= 8) {
        currentBOC = decodeEbcdic(view, offset + 9, 8);
        currentFamily = '';
      }

      // CPD — font family name
      if (typeId === 'D3A689' && dl > 10 && currentBOC.startsWith('C0F')) {
        currentFamily = decodeEbcdic(view, offset + 9, Math.min(dl, 32));
      }

      // EOC — finalize font
      if (typeId === 'D3A9CE' && currentBOC && !seen.has(currentBOC)) {
        if (currentBOC.startsWith('C0F') || currentBOC.startsWith('T1')) {
          seen.add(currentBOC);
          const suffix = currentBOC.slice(-2);
          let type = 'Unknown', weight = 'Regular', codePage = '';

          if (currentBOC.startsWith('C0FL')) {
            type = 'Latin';
            weight = { '60': 'Light', '70': 'Medium', '80': 'Bold', '90': 'Light Italic', 'A0': 'Bold Italic', 'B0': 'Semi-Bold', 'C0': 'Condensed', 'E0': 'Cond. Bold' }[suffix] || weight;
          } else if (currentBOC.startsWith('C0FM')) {
            type = 'Math/Symbol';
            weight = { '60': 'Light', '70': 'Medium', '80': 'Bold', '90': 'Italic', 'A0': 'Bold Italic', 'B0': 'Semi-Bold', 'C0': 'Condensed', 'E0': 'Cond. Bold', 'I0': 'Std Italic' }[suffix] || weight;
          } else if (currentBOC.startsWith('T1')) {
            type = 'Code Page';
            weight = '—';
            codePage = currentBOC.includes('1144') ? 'CP297 (French)' : currentBOC.includes('0500') ? 'CP500 (Intl)' : currentBOC;
          }

          fonts.push({ name: currentBOC, type, weight, family: currentFamily, codePage });
        }
      }

      const next = offset + 1 + len;
      if (next <= offset) break;
      offset = next;
    }

    return { docName, fileSize, fonts };
  }, [fileData]);

  if (!docInfoOpen || !info) return null;

  const codePages = info.fonts.filter(f => f.type === 'Code Page');
  const charSets = info.fonts.filter(f => f.type !== 'Code Page');
  const families = [...new Set(charSets.map(f => f.family).filter(Boolean))];

  function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => useAfpViewerStore.setState({ docInfoOpen: false })}>
      <div className="mx-4 max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <h2 className="text-sm font-semibold text-[hsl(var(--foreground))]">Document Information</h2>
          <button onClick={() => useAfpViewerStore.setState({ docInfoOpen: false })} className="rounded p-1 hover:bg-[hsl(var(--muted))]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* General */}
          <section>
            <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">General</h3>
            <div className="mt-1.5 grid grid-cols-[120px_1fr] gap-y-1 text-xs">
              <span className="text-[hsl(var(--muted-foreground))]">File Name</span>
              <span className="font-mono">{fileName || '—'}</span>
              <span className="text-[hsl(var(--muted-foreground))]">File Size</span>
              <span>{formatSize(info.fileSize)}</span>
              <span className="text-[hsl(var(--muted-foreground))]">Pages</span>
              <span>{totalPages}</span>
              {info.docName && <>
                <span className="text-[hsl(var(--muted-foreground))]">Document Name</span>
                <span className="font-mono">{info.docName}</span>
              </>}
            </div>
          </section>


          {/* Document Divider TLE Selector + Document Count */}
          <TleDividerSelector fileData={fileData} pageIndex={pageIndex} />

          {/* Document Metadata (TLE/NOP before first page) */}
          {docMeta.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Document Metadata</h3>
              <div className="mt-1.5 space-y-0.5 text-xs">
                {docMeta.map((m, i) => (
                  <div key={i} className="flex gap-2">
                    {m.key ? (
                      <>
                        <span className="shrink-0 text-[hsl(var(--muted-foreground))]">{m.key}</span>
                        <span className="font-mono truncate">{m.value}</span>
                      </>
                    ) : (
                      <span className="font-mono text-[hsl(var(--muted-foreground))]">{m.value}</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Code Pages */}
          {codePages.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Code Pages</h3>
              <div className="mt-1.5 space-y-0.5">
                {codePages.map(cp => (
                  <div key={cp.name} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-[hsl(var(--foreground))]">{cp.name}</span>
                    <span className="text-[hsl(var(--muted-foreground))]">{cp.codePage}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Font Families */}
          {families.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Font Families</h3>
              <div className="mt-1.5 space-y-0.5 text-xs">
                {families.map(f => (
                  <p key={f} className="text-[hsl(var(--foreground))]">{f}</p>
                ))}
              </div>
            </section>
          )}

          {/* Character Sets */}
          {charSets.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Character Sets ({charSets.length})</h3>
              <div className="mt-1.5 space-y-1 text-xs">
                {charSets.map(f => (
                  <div key={f.name}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[hsl(var(--foreground))]">{f.name}</span>
                      <span className="text-[hsl(var(--muted-foreground))]">{f.type}</span>
                      <span className={f.weight.includes('Bold') ? 'font-bold' : 'text-[hsl(var(--muted-foreground))]'}>{f.weight}</span>
                    </div>
                    {f.family && <p className="ml-1 text-[10px] text-[hsl(var(--muted-foreground))]">{f.family}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function TleDividerSelector({ fileData, pageIndex }: { fileData: ArrayBuffer | null; pageIndex: Array<{ byteOffset: number; byteLength: number }> }) {
  const docDividerTle = useAfpViewerStore((s) => s.docDividerTle);

  const tleKeys = useMemo(() => {
    if (!fileData) return [];
    const keys = new Set<string>();
    const view = new DataView(fileData);
    let offset = 0;
    let pagesSeen = 0;

    while (offset < fileData.byteLength - 9 && pagesSeen < 3) {
      if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
      const len = view.getUint16(offset + 1, false);
      if (len < 6 || len > 32766) { offset++; continue; }
      const t3 = view.getUint8(offset + 3);
      const t4 = view.getUint8(offset + 4);
      const t5 = view.getUint8(offset + 5);

      if (t3 === 0xD3 && t4 === 0xA8 && t5 === 0xAD) pagesSeen++;

      if (t3 === 0xD3 && t4 === 0xA0 && t5 === 0x90) {
        const dl = len - 8;
        let tp = offset + 9;
        const tEnd = offset + 9 + dl;
        while (tp + 4 < tEnd) {
          const tLen = view.getUint8(tp);
          const tId = view.getUint8(tp + 1);
          if (tLen < 2 || tp + tLen > tEnd) break;
          if (tId === 0x02 && tLen > 4) {
            let key = '';
            for (let i = tp + 4; i < tp + tLen; i++) {
              const b = view.getUint8(i);
              if (b === 0x40 || b === 0x6D) key += '_';
              else if (b >= 0xC1 && b <= 0xC9) key += String.fromCharCode(65 + b - 0xC1);
              else if (b >= 0xD1 && b <= 0xD9) key += String.fromCharCode(74 + b - 0xD1);
              else if (b >= 0xE2 && b <= 0xE9) key += String.fromCharCode(83 + b - 0xE2);
              else if (b >= 0xF0 && b <= 0xF9) key += String.fromCharCode(48 + b - 0xF0);
              else if (b >= 0x81 && b <= 0x89) key += String.fromCharCode(97 + b - 0x81);
              else if (b >= 0x91 && b <= 0x99) key += String.fromCharCode(106 + b - 0x91);
              else if (b >= 0xA2 && b <= 0xA9) key += String.fromCharCode(115 + b - 0xA2);
              else if (b === 0x7D) key += "'";
              else if (b === 0x60) key += '-';
            }
            key = key.replace(/_+$/, '').trim();
            if (key.length > 1) keys.add(key);
          }
          tp += tLen;
        }
      }

      const next = offset + 1 + len;
      if (next <= offset) break;
      offset = next;
    }
    return [...keys].sort();
  }, [fileData]);

  if (tleKeys.length === 0) return null;

  return (
    <section>
      <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Document Divider</h3>
      <p className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">
        Select a TLE key that identifies document boundaries:
      </p>
      <select
        value={docDividerTle}
        onChange={(e) => useAfpViewerStore.getState().setDocDividerTle(e.target.value)}
        className="mt-1.5 w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs text-[hsl(var(--foreground))]"
      >
        <option value="">— None (use BDT) —</option>
        {tleKeys.map(k => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      {docDividerTle && (
        <p className="mt-1 text-[10px] text-[hsl(var(--primary))]">
          Documents grouped by &quot;{docDividerTle}&quot;
        </p>
      )}
    </section>
  );
}
