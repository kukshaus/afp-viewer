#!/usr/bin/env python3
"""
AFP Document Splitter — splits an AFP file after page N into two valid documents.

Uses mmap for zero-copy reads. Handles multi-GB files in seconds.

Usage:
    python afp_cut.py input.afp 50          # split after page 50
    python afp_cut.py input.afp 50 -o out   # writes out_part1.afp, out_part2.afp

The preamble (BDT, resources, medium maps, overlays) is copied into both
output files so each is a fully self-contained, valid AFP document.
"""

from __future__ import annotations

import argparse
import mmap
import struct
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

# AFP structured field type IDs (bytes 3-5 after 0x5A marker)
BPG = (0xD3, 0xA8, 0xAD)  # Begin Page
EPG = (0xD3, 0xA9, 0xAD)  # End Page


def scan_pages(mm: mmap.mmap) -> Tuple[List[Tuple[int, int]], int, int]:
    """
    Single-pass scan over the AFP data.

    Returns:
        pages:           list of (bpg_offset, epg_record_end) per page
        preamble_end:    byte offset where first BPG starts (everything before is preamble)
        postamble_start: byte offset after last EPG record (everything after is postamble/EDT)
    """
    pages: List[Tuple[int, int]] = []
    preamble_end = 0
    postamble_start = 0
    current_bpg: Optional[int] = None
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
            if not pages and current_bpg is None:
                preamble_end = offset
            current_bpg = offset
        elif t == EPG and current_bpg is not None:
            record_end = offset + 1 + length
            pages.append((current_bpg, record_end))
            postamble_start = record_end
            current_bpg = None

        next_offset = offset + 1 + length
        if next_offset <= offset:
            break
        offset = next_offset

    return pages, preamble_end, postamble_start


def split_afp(
    input_path: str,
    split_after: int,
    output_prefix: Optional[str] = None,
) -> None:
    path = Path(input_path)
    if not path.exists():
        print(f"Error: {input_path} not found", file=sys.stderr)
        sys.exit(1)

    prefix = output_prefix or path.stem
    out1 = Path(f"{prefix}_part1.afp")
    out2 = Path(f"{prefix}_part2.afp")

    t0 = time.perf_counter()

    with open(path, "rb") as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        file_size = len(mm)

        pages, preamble_end, postamble_start = scan_pages(mm)
        total = len(pages)

        t_scan = time.perf_counter()
        print(f"Scanned {file_size / 1_048_576:.1f} MB — {total} pages in {(t_scan - t0)*1000:.0f} ms")

        if total == 0:
            print("Error: no pages found in the AFP file", file=sys.stderr)
            mm.close()
            sys.exit(1)

        if split_after < 1 or split_after >= total:
            print(
                f"Error: split-after must be 1..{total - 1} (file has {total} pages)",
                file=sys.stderr,
            )
            mm.close()
            sys.exit(1)

        preamble = mm[:preamble_end]
        postamble = mm[postamble_start:]

        # Part 1: preamble + pages 1..split_after + postamble
        p1_start = pages[0][0]
        p1_end = pages[split_after - 1][1]

        # Part 2: preamble + pages split_after+1..N + postamble
        p2_start = pages[split_after][0]
        p2_end = pages[-1][1]

        # Write with large buffer for speed
        BUF = 4 * 1024 * 1024  # 4 MB write buffer

        with open(out1, "wb", buffering=BUF) as o:
            o.write(preamble)
            o.write(mm[p1_start:p1_end])
            o.write(postamble)

        with open(out2, "wb", buffering=BUF) as o:
            o.write(preamble)
            o.write(mm[p2_start:p2_end])
            o.write(postamble)

        mm.close()

    t_done = time.perf_counter()
    s1 = out1.stat().st_size
    s2 = out2.stat().st_size
    print(
        f"Done in {(t_done - t0)*1000:.0f} ms\n"
        f"  {out1.name}  ({split_after} pages, {s1 / 1_048_576:.1f} MB)\n"
        f"  {out2.name}  ({total - split_after} pages, {s2 / 1_048_576:.1f} MB)"
    )


def batch_split_afp(
    input_path: str,
    chunk_size: int,
    output_prefix: Optional[str] = None,
) -> None:
    """Split AFP file every `chunk_size` pages into N valid documents."""
    path = Path(input_path)
    if not path.exists():
        print(f"Error: {input_path} not found", file=sys.stderr)
        sys.exit(1)

    prefix = output_prefix or path.stem
    t0 = time.perf_counter()

    with open(path, "rb") as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        file_size = len(mm)

        pages, preamble_end, postamble_start = scan_pages(mm)
        total = len(pages)

        t_scan = time.perf_counter()
        print(f"Scanned {file_size / 1_048_576:.1f} MB — {total} pages in {(t_scan - t0)*1000:.0f} ms")

        if total == 0:
            print("Error: no pages found in the AFP file", file=sys.stderr)
            mm.close()
            sys.exit(1)

        preamble = mm[:preamble_end]
        postamble = mm[postamble_start:]
        num_parts = (total + chunk_size - 1) // chunk_size
        pad = len(str(num_parts))
        BUF = 4 * 1024 * 1024

        outputs = []
        for i in range(0, total, chunk_size):
            end = min(i + chunk_size, total)
            part_num = str(len(outputs) + 1).zfill(pad)
            out_path = Path(f"{prefix}_part{part_num}.afp")

            start_off = pages[i][0]
            end_off = pages[end - 1][1]

            with open(out_path, "wb", buffering=BUF) as o:
                o.write(preamble)
                o.write(mm[start_off:end_off])
                o.write(postamble)

            outputs.append((out_path, end - i))

        mm.close()

    t_done = time.perf_counter()
    print(f"Done in {(t_done - t0)*1000:.0f} ms — {len(outputs)} files:")
    for out_path, count in outputs:
        sz = out_path.stat().st_size
        print(f"  {out_path.name}  ({count} pages, {sz / 1_048_576:.1f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Split an AFP file into multiple valid documents."
    )
    parser.add_argument("input", help="Input AFP file path")
    parser.add_argument(
        "page", type=int,
        help="Split after this page (single mode), or chunk size with --every",
    )
    parser.add_argument(
        "-o", "--output", default=None, help="Output prefix (default: input stem)"
    )
    parser.add_argument(
        "--every", action="store_true",
        help="Batch mode: split every N pages instead of at a single point",
    )
    args = parser.parse_args()

    if args.every:
        batch_split_afp(args.input, args.page, args.output)
    else:
        split_afp(args.input, args.page, args.output)


if __name__ == "__main__":
    main()
