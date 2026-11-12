import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { FILES_DIR, safeId } from "@/lib/files";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = safeId(decodeURIComponent((await params).id));
  if (!id) return NextResponse.json({ error: "плохое имя" }, { status: 400 });
  try {
    const buf = await fs.readFile(path.join(FILES_DIR, id));
    const ext = id.split(".").pop()?.toLowerCase() ?? "";
    return new Response(buf, {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(id.replace(/^[a-z0-9]+-/, ""))}`,
      },
    });
  } catch {
    return NextResponse.json({ error: "файла нет" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = safeId(decodeURIComponent((await params).id));
  if (!id) return NextResponse.json({ error: "плохое имя" }, { status: 400 });
  await fs.rm(path.join(FILES_DIR, id), { force: true });
  return NextResponse.json({ ok: true });
}
