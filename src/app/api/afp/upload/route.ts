/**
 * POST /api/afp/upload
 *
 * Accepts a multipart form-data upload with a 'file' field containing an AFP
 * document. Validates the magic byte, enforces a 2 GB size limit, saves the
 * file to /uploads/{fileId}.afp, and returns metadata.
 */

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/** 2 GB max file size. */
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

/** AFP magic byte that must appear as the first byte. */
const AFP_MAGIC_BYTE = 0x5a;

/** Average AFP page size estimate used for rough page count. */
const AVG_BYTES_PER_PAGE = 2048;

/** CORS headers applied to every response. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function uploadsDir(): string {
  return path.join(process.cwd(), 'uploads');
}

function sanitizeFileName(name: string): string {
  // Strip path separators and null bytes to prevent traversal attacks.
  return name.replace(/[/\\:\0]/g, '_');
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Content-Type must be multipart/form-data' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing required "file" field in form data' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // --- Size validation ---
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File exceeds maximum allowed size of 2 GB (received ${file.size} bytes)`,
        },
        { status: 413, headers: CORS_HEADERS },
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { error: 'Uploaded file is empty' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // --- Read bytes and validate AFP magic byte ---
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes[0] !== AFP_MAGIC_BYTE) {
      return NextResponse.json(
        {
          error: `Invalid AFP file: first byte is 0x${bytes[0].toString(16).toUpperCase().padStart(2, '0')}, expected 0x5A`,
        },
        { status: 422, headers: CORS_HEADERS },
      );
    }

    // --- Generate file ID and save ---
    const fileId = crypto.randomUUID();
    const dir = uploadsDir();
    await mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${fileId}.afp`);
    await writeFile(filePath, bytes);

    const originalName = sanitizeFileName(file.name || 'untitled.afp');
    const estimatedPages = Math.max(1, Math.round(file.size / AVG_BYTES_PER_PAGE));

    return NextResponse.json(
      {
        fileId,
        size: file.size,
        fileName: originalName,
        estimatedPages,
      },
      { status: 201, headers: CORS_HEADERS },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error during upload';
    console.error('AFP upload error:', message);
    return NextResponse.json(
      { error: 'Internal server error during file upload' },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
