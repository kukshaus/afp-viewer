#!/usr/bin/env python3
"""
AFP Document Merger — concatenates multiple AFP files into one.

Two modes:
  Default (concatenate):  Raw byte append. Each file keeps its own BDT/EDT
      envelope. Industry-standard approach — always valid, always fast.
  --single-document:  Merges pages into one BDT/EDT using file 1's envelope.
      Resources from files 2..N are injected into the preamble.

Usage:
    python afp_merge.py file1.afp file2.afp file3.afp -o merged.afp
    python afp_merge.py file1.afp file2.afp --single-document -o merged.afp
"""

from __future__ import annotations

import argparse
import mmap
import struct
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

BPG = (0xD3, 0xA8, 0xAD)
EPG = (0xD3, 0xA9, 0xAD)
BDT = (0xD3, 0xA8, 0xA8)


def count_pages(mm: mmap.mmap) -> int:
    """Quick single-pass BPG count."""
    count = 0
    offset = 0
    size = len(mm)
    while offset < size:
        if mm[offset] != 0x5A:
            offset += 1
            continue
        if offset + 5 > size:
            break
        length = struct.unpack_from(">H", mm, offset + 1)[0]
        if length < 6 or length > 32766:
            offset += 1
            continue
        if (mm[offset + 3], mm[offset + 4], mm[offset + 5]) == BPG:
            count += 1
        nxt = offset + 1 + length
        if nxt <= offset:
            break
        offset = nxt
    return count


def scan_structure(
    mm: mmap.mmap,
) -> Tuple[int, int, List[Tuple[int, int]]]:
    """Return (preamble_end, postamble_start, [(bpg_off, epg_end), ...])."""
    pages: List[Tuple[int, int]] = []
    preamble_end = 0
    postamble_start = len(mm)
    cur_bpg: Optional[int] = None
    offset = 0
    size = len(mm)

    while offset < size:
        if mm[offset] != 0x5A:
            offset += 1
            continue
        if offset + 5 > size:
            break
        length = struct.unpack_from(">H", mm, offset + 1)[0]
        if length < 6 or length > 32766:
            offset += 1
            continue
        t = (mm[offset + 3], mm[offset + 4], mm[offset + 5])
        if t == BPG:
            if not pages and cur_bpg is None:
                preamble_end = offset
            cur_bpg = offset
        elif t == EPG and cur_bpg is not None:
            end = offset + 1 + length
            pages.append((cur_bpg, end))
            postamble_start = end
            cur_bpg = None
        nxt = offset + 1 + length
        if nxt <= offset:
            break
        offset = nxt
    return preamble_end, postamble_start, pages


def extract_resources_after_bdt(mm: mmap.mmap, preamble_end: int) -> bytes:
    """Extract preamble bytes after the BDT record (resources only)."""
    offset = 0
    while offset < preamble_end:
        if mm[offset] != 0x5A:
            offset += 1
            continue
        if offset + 5 > preamble_end:
            break
        length = struct.unpack_from(">H", mm, offset + 1)[0]
        if length < 6 or length > 32766:
            offset += 1
            continue
        t = (mm[offset + 3], mm[offset + 4], mm[offset + 5])
        nxt = offset + 1 + length
        if t == BDT:
            # Everything after BDT up to preamble_end is resources
            return bytes(mm[nxt:preamble_end])
        if nxt <= offset:
            break
        offset = nxt
    return b""


# ── Concatenate mode ─────────────────────────────────────────────────────────


def concat_merge(input_paths: List[str], output_path: str) -> None:
    t0 = time.perf_counter()
    total_pages = 0
    total_bytes = 0
    BUF = 4 * 1024 * 1024

    with open(output_path, "wb", buffering=BUF) as out:
        for path in input_paths:
            p = Path(path)
            if not p.exists():
                print(f"Error: {path} not found", file=sys.stderr)
                sys.exit(1)
            with open(p, "rb") as f:
                mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
                pages = count_pages(mm)
                total_pages += pages
                total_bytes += len(mm)
                print(f"  {p.name}: {pages} pages, {len(mm) / 1_048_576:.1f} MB")
                out.write(mm[:])
                mm.close()

    elapsed = time.perf_counter() - t0
    out_size = Path(output_path).stat().st_size
    print(
        f"\nMerged {len(input_paths)} files -> {output_path}\n"
        f"  {total_pages} pages, {out_size / 1_048_576:.1f} MB in {elapsed*1000:.0f} ms"
    )


# ── Single document mode ─────────────────────────────────────────────────────


def single_doc_merge(input_paths: List[str], output_path: str) -> None:
    t0 = time.perf_counter()
    total_pages = 0
    BUF = 4 * 1024 * 1024

    # Open all files
    handles = []
    mmaps = []
    structures = []
    for path in input_paths:
        p = Path(path)
        if not p.exists():
            print(f"Error: {path} not found", file=sys.stderr)
            sys.exit(1)
        f = open(p, "rb")
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        pre_end, post_start, pages = scan_structure(mm)
        structures.append((pre_end, post_start, pages))
        handles.append(f)
        mmaps.append(mm)
        pg = len(pages)
        total_pages += pg
        print(f"  {p.name}: {pg} pages, {len(mm) / 1_048_576:.1f} MB")

    with open(output_path, "wb", buffering=BUF) as out:
        # Preamble from file 1
        pre_end_0 = structures[0][0]
        out.write(mmaps[0][:pre_end_0])

        # Resources from files 2..N (without BDT)
        for i in range(1, len(mmaps)):
            res = extract_resources_after_bdt(mmaps[i], structures[i][0])
            if res:
                out.write(res)

        # All pages from all files
        for i in range(len(mmaps)):
            for bpg_off, epg_end in structures[i][2]:
                out.write(mmaps[i][bpg_off:epg_end])

        # Postamble from file 1
        post_start_0 = structures[0][1]
        out.write(mmaps[0][post_start_0:])

    # Cleanup
    for mm in mmaps:
        mm.close()
    for f in handles:
        f.close()

    elapsed = time.perf_counter() - t0
    out_size = Path(output_path).stat().st_size
    print(
        f"\nMerged {len(input_paths)} files -> {output_path} (single document)\n"
        f"  {total_pages} pages, {out_size / 1_048_576:.1f} MB in {elapsed*1000:.0f} ms"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Merge multiple AFP files into one."
    )
    parser.add_argument("inputs", nargs="+", help="Input AFP files (in order)")
    parser.add_argument(
        "-o", "--output", default="merged.afp", help="Output file (default: merged.afp)"
    )
    parser.add_argument(
        "--single-document",
        action="store_true",
        help="Merge into a single BDT/EDT document (uses file 1's envelope + resources)",
    )
    args = parser.parse_args()

    if len(args.inputs) < 2:
        print("Error: need at least 2 input files", file=sys.stderr)
        sys.exit(1)

    print(f"Merging {len(args.inputs)} files:")
    if args.single_document:
        single_doc_merge(args.inputs, args.output)
    else:
        concat_merge(args.inputs, args.output)


if __name__ == "__main__":
    main()
