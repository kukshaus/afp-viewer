import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';

function samplesDir(): string {
  return path.join(process.cwd(), 'AFP-Files');
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileName: string }> },
): Promise<NextResponse> {
  const { fileName } = await params;

  // Sanitize: only allow alphanumeric, dots, underscores, hyphens
  if (!/^[\w.\-]+$/.test(fileName)) {
    return NextResponse.json({ error: 'Invalid file name' }, { status: 400 });
  }

  const filePath = path.join(samplesDir(), fileName);

  // Prevent directory traversal
  if (!filePath.startsWith(samplesDir())) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    await stat(filePath);
    const data = await readFile(filePath);

    return new NextResponse(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
