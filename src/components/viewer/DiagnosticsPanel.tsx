'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAfpViewerStore } from '@/store/afpViewerStore';
import { useAfpViewer } from '@/hooks/useAfpViewer';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle,
  X,
  ChevronDown,
  ChevronRight,
  FileWarning,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

type Severity = 'error' | 'warning' | 'info' | 'success';

interface DiagnosticMessage {
  id: string;
  severity: Severity;
  category: string;
  message: string;
  detail?: string;
  offset?: number;
  pageNumber?: number;
}

const SEVERITY_ICONS: Record<Severity, typeof AlertCircle> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
};

const SEVERITY_COLORS: Record<Severity, string> = {
  error: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-blue-500',
  success: 'text-green-500',
};

const SEVERITY_BG: Record<Severity, string> = {
  error: 'bg-red-50 dark:bg-red-950/20',
  warning: 'bg-amber-50 dark:bg-amber-950/20',
  info: 'bg-blue-50 dark:bg-blue-950/20',
  success: 'bg-green-50 dark:bg-green-950/20',
};

/** EBCDIC decode for resource names */
function ebcStr(data: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < data.length; i++) {
    const b = data[i];
    if (b >= 0xC1 && b <= 0xC9) s += String.fromCharCode(65 + b - 0xC1);
    else if (b >= 0xD1 && b <= 0xD9) s += String.fromCharCode(74 + b - 0xD1);
    else if (b >= 0xE2 && b <= 0xE9) s += String.fromCharCode(83 + b - 0xE2);
    else if (b >= 0xF0 && b <= 0xF9) s += String.fromCharCode(48 + b - 0xF0);
    else if (b === 0x40) s += ' ';
    else if (b === 0x4B) s += '.';
    else if (b === 0x6B) s += ',';
    else if (b === 0x60) s += '-';
    else if (b === 0x61) s += '/';
    else s += String.fromCharCode(b);
  }
  return s.trim();
}

/** Run diagnostics on the loaded AFP file */
function analyzeDiagnostics(fileData: ArrayBuffer): DiagnosticMessage[] {
  const msgs: DiagnosticMessage[] = [];
  const view = new DataView(fileData);
  const totalSize = fileData.byteLength;
  let id = 0;

  // Track resources
  const definedResources = new Set<string>();
  const referencedResources = new Map<string, number>(); // name -> offset
  const pageCount = { bpg: 0, brs: 0 };
  const typeCounts = new Map<string, number>();
  let hasBDT = false;
  let hasEDT = false;
  const firstByte = totalSize > 0 ? view.getUint8(0) : 0;
  let fieldCount = 0;
  let corruptFields = 0;
  let unknownTypes = 0;
  let tleCount = 0;
  let ptxCount = 0;

  // Known type IDs
  const knownTypes = new Set([
    'D3A8A5','D3A9A5','D3A8A8','D3A9A8','D3A8AD','D3A9AD','D3A8AF','D3A9AF',
    'D3A8C9','D3A9C9','D3A8C6','D3A9C6','D3A8CE','D3A9CE','D3A87B','D3A97B',
    'D3A89B','D3A99B','D3EE9B','D3EE6B','D3EEEE','D3A8C5','D3A9C5','D3A892',
    'D3A992','D3EE92','D3ACCE','D3EE7B','D3A8C3','D3A9C3','D3EECC','D3A8EB',
    'D3A9EB','D3AEEB','D3A6AF','D3ABC3','D3ABCE','D3AC6B','D3A6C3','D3AFC3',
    'D3B19B','D3ABCA','D3A9CA','D3A8A7','D3A9A7','D3A6EE','D3A87E','D3A090',
    'D3AFEE','D3A8EE','D3AB88','D3ABD8','D3AFD8','D3AF5F','D3B15F','D3B18A',
    'D3EEBB','D3A79B','D3A69B','D3A8BB','D3A9BB','D3A8C7','D3A9C7','D3A66B',
    'D3A6BB','D3ABCC','D3A888','D3A988','D3A88A','D3A98A','D3A885','D3A985',
    'D3A887','D3A987','D3A889','D3A989','D3A8A6','D3A9A6','D3AB89','D3A8C4',
    'D3A9C4','D3A8DF','D3A9DF','D3ABDF','D3A85F','D3A95F','D3EEFB','D3A789',
    'D3AE89','D3AC89','D38C89','D38C87','D3A8CD','D3A9CD','D3A8CC','D3A9CC',
    'D3A6C5','D3B1AF','D3A688','D3A288','D3A788','D3AB8A','D3A8FB','D3A9FB',
    'D3ABFB','D3A6FB',
  ]);

  // Scan file
  let offset = 0;
  while (offset < totalSize) {
    if (view.getUint8(offset) !== 0x5A) { offset++; continue; }
    if (offset + 9 > totalSize) break;
    const length = view.getUint16(offset + 1, false);
    if (length < 6 || length > 32766) {
      corruptFields++;
      offset++;
      continue;
    }

    const b1 = view.getUint8(offset + 3);
    const b2 = view.getUint8(offset + 4);
    const b3 = view.getUint8(offset + 5);
    const typeId = b1.toString(16).toUpperCase().padStart(2, '0') +
      b2.toString(16).toUpperCase().padStart(2, '0') +
      b3.toString(16).toUpperCase().padStart(2, '0');

    fieldCount++;
    typeCounts.set(typeId, (typeCounts.get(typeId) ?? 0) + 1);

    if (!knownTypes.has(typeId)) unknownTypes++;

    // Track specific field types
    const dlen = length - 8;
    const dataStart = offset + 9;

    switch (typeId) {
      case 'D3A8A8': hasBDT = true; break;
      case 'D3A9A8': hasEDT = true; break;
      case 'D3A8AD': pageCount.bpg++; break;
      case 'D3A8AF': pageCount.brs++; break;
      case 'D3A090': tleCount++; break;
      case 'D3EE9B': ptxCount++; break;

      // Resource definitions (BOC, BPS, etc.)
      case 'D3A8CE': // BOC
      case 'D3A85F': // BPS
      case 'D3A8DF': // BOV
      case 'D3A8CC': // BOC variant
        if (dlen >= 8 && dataStart + 8 <= totalSize) {
          const name = ebcStr(new Uint8Array(fileData, dataStart, 8), 0, 8);
          if (name) definedResources.add(name);
        }
        break;

      // Resource references (IOC, IPS, IPO, etc.)
      case 'D3AFC3': // IOC
      case 'D3AF5F': // IPS
      case 'D3AFD8': // IPO
        if (dlen >= 8 && dataStart + 8 <= totalSize) {
          const name = ebcStr(new Uint8Array(fileData, dataStart, 8), 0, 8);
          if (name) referencedResources.set(name, offset);
        }
        break;
    }

    const next = offset + 1 + length;
    if (next <= offset) break;
    offset = next;
  }

  // === Generate diagnostic messages ===

  // File info
  msgs.push({
    id: `diag-${id++}`, severity: 'info', category: 'File',
    message: `File size: ${(totalSize / 1024).toFixed(1)} KB (${totalSize.toLocaleString()} bytes)`,
  });

  msgs.push({
    id: `diag-${id++}`, severity: 'info', category: 'Structure',
    message: `${fieldCount.toLocaleString()} structured fields, ${typeCounts.size} unique types`,
  });

  // Validity checks
  if (firstByte !== 0x5A) {
    msgs.push({
      id: `diag-${id++}`, severity: 'error', category: 'Validation',
      message: `Invalid AFP: first byte is 0x${firstByte.toString(16).toUpperCase()}, expected 0x5A`,
    });
  } else {
    msgs.push({
      id: `diag-${id++}`, severity: 'success', category: 'Validation',
      message: 'Valid AFP magic byte (0x5A)',
    });
  }

  if (!hasBDT) {
    msgs.push({
      id: `diag-${id++}`, severity: 'warning', category: 'Structure',
      message: 'No BDT (Begin Document) found — file may use non-standard structure',
    });
  }

  if (!hasEDT) {
    msgs.push({
      id: `diag-${id++}`, severity: 'warning', category: 'Structure',
      message: 'No EDT (End Document) found — file may be truncated',
    });
  }

  // Page info
  const totalPages = Math.max(pageCount.bpg, pageCount.brs);
  msgs.push({
    id: `diag-${id++}`, severity: 'info', category: 'Pages',
    message: `${totalPages} pages detected (${pageCount.bpg} BPG, ${pageCount.brs} BRS)`,
  });

  if (pageCount.brs > pageCount.bpg && pageCount.bpg > 0) {
    msgs.push({
      id: `diag-${id++}`, severity: 'info', category: 'Pages',
      message: `Multiple BRS per BPG (${(pageCount.brs / pageCount.bpg).toFixed(1)} avg) — composite pages`,
    });
  }

  // TLE info
  if (tleCount > 0) {
    msgs.push({
      id: `diag-${id++}`, severity: 'info', category: 'Metadata',
      message: `${tleCount} TLE (Tag Logical Element) metadata fields`,
    });
  }

  // Resource validation
  msgs.push({
    id: `diag-${id++}`, severity: 'info', category: 'Resources',
    message: `${definedResources.size} inline resources defined, ${referencedResources.size} resources referenced`,
  });

  // Check for missing resources
  for (const [name, refOffset] of referencedResources) {
    if (!definedResources.has(name)) {
      msgs.push({
        id: `diag-${id++}`, severity: 'error', category: 'Resources',
        message: `Missing resource: "${name}" is referenced but not defined in the AFP file`,
        detail: `Referenced at offset ${refOffset}. This resource must be provided externally (resource library).`,
        offset: refOffset,
      });
    }
  }

  // Check for unused resources
  for (const name of definedResources) {
    if (!referencedResources.has(name)) {
      msgs.push({
        id: `diag-${id++}`, severity: 'warning', category: 'Resources',
        message: `Unused resource: "${name}" is defined but never referenced`,
        detail: 'This resource occupies file space but is not used by any page.',
      });
    }
  }

  // Corrupt fields
  if (corruptFields > 0) {
    msgs.push({
      id: `diag-${id++}`, severity: 'error', category: 'Integrity',
      message: `${corruptFields} corrupt structured field(s) detected`,
      detail: 'Fields with invalid length values were skipped during parsing.',
    });
  } else {
    msgs.push({
      id: `diag-${id++}`, severity: 'success', category: 'Integrity',
      message: 'No corrupt structured fields detected',
    });
  }

  // Unknown types
  if (unknownTypes > 0) {
    msgs.push({
      id: `diag-${id++}`, severity: 'warning', category: 'Compatibility',
      message: `${unknownTypes} structured field(s) with unrecognized type IDs`,
      detail: 'These fields may use proprietary extensions or newer AFP specifications.',
    });
  }

  // PTX text blocks
  if (ptxCount > 0) {
    msgs.push({
      id: `diag-${id++}`, severity: 'info', category: 'Content',
      message: `${ptxCount} presentation text (PTX) blocks`,
    });
  }

  return msgs;
}

export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const { fileData } = useAfpViewer();
  const status = useAfpViewerStore((s) => s.status);
  const fileName = useAfpViewerStore((s) => s.fileName);
  const [messages, setMessages] = useState<DiagnosticMessage[]>([]);
  const [filter, setFilter] = useState<Severity | 'all'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState(false);

  const runAnalysis = useCallback(() => {
    if (!fileData || status !== 'ready') return;
    setAnalyzing(true);
    // Run async to not block UI
    setTimeout(() => {
      const results = analyzeDiagnostics(fileData);
      setMessages(results);
      setAnalyzing(false);
    }, 50);
  }, [fileData, status]);

  useEffect(() => {
    runAnalysis();
  }, [runAnalysis]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtered = filter === 'all' ? messages : messages.filter((m) => m.severity === filter);
  const counts = {
    error: messages.filter((m) => m.severity === 'error').length,
    warning: messages.filter((m) => m.severity === 'warning').length,
    info: messages.filter((m) => m.severity === 'info').length,
    success: messages.filter((m) => m.severity === 'success').length,
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 z-50 flex flex-col border-t border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-lg" style={{ height: '33vh' }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
        <div className="flex items-center gap-2">
          <FileWarning className="h-4 w-4 text-[hsl(var(--primary))]" />
          <h2 className="text-sm font-semibold">AFP Diagnostics</h2>
          {fileName && (
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              — {fileName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={runAnalysis} disabled={analyzing}>
            <RefreshCw className={`h-3.5 w-3.5 ${analyzing ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-1.5">
        {(['all', 'error', 'warning', 'info', 'success'] as const).map((sev) => {
          const count = sev === 'all' ? messages.length : counts[sev];
          const Icon = sev === 'all' ? Info : SEVERITY_ICONS[sev];
          return (
            <button
              key={sev}
              onClick={() => setFilter(sev)}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                filter === sev
                  ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                  : 'hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]'
              }`}
            >
              <Icon className="h-3 w-3" />
              {sev === 'all' ? 'All' : sev.charAt(0).toUpperCase() + sev.slice(1)} ({count})
            </button>
          );
        })}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto">
        {filtered.map((msg) => {
          const Icon = SEVERITY_ICONS[msg.severity];
          const isExpanded = expandedIds.has(msg.id);

          return (
            <div
              key={msg.id}
              className={`border-b border-[hsl(var(--border))]/30 ${SEVERITY_BG[msg.severity]}`}
            >
              <button
                onClick={() => msg.detail && toggleExpand(msg.id)}
                className="flex w-full items-start gap-2 px-4 py-2 text-left"
              >
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${SEVERITY_COLORS[msg.severity]}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--muted-foreground))]">
                      {msg.category}
                    </span>
                    {msg.offset !== undefined && (
                      <span className="font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
                        @{msg.offset}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-[hsl(var(--foreground))]">{msg.message}</p>
                </div>
                {msg.detail && (
                  isExpanded
                    ? <ChevronDown className="mt-1 h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
                    : <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
                )}
              </button>
              {msg.detail && isExpanded && (
                <div className="px-10 pb-2">
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))]">{msg.detail}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
