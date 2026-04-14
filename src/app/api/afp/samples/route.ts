import { NextResponse } from 'next/server';
import { readdir, stat } from 'fs/promises';
import path from 'path';

function samplesDir(): string {
  return path.join(process.cwd(), 'AFP-Files');
}

export async function GET(): Promise<NextResponse> {
  try {
    const dir = samplesDir();
    const entries = await readdir(dir);
    const files: Array<{ name: string; size: number }> = [];

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const ext = entry.toLowerCase().split('.').pop();
      if (ext !== 'afp' && ext !== 'afp2') continue;

      const filePath = path.join(dir, entry);
      const info = await stat(filePath);
      if (info.isFile()) {
        files.push({ name: entry, size: info.size });
      }
    }

    return NextResponse.json({ files });
  } catch {
    return NextResponse.json({ files: [] });
  }
}
