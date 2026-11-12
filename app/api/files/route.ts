import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { FILES_DIR } from "@/lib/files";
import type { Attachment } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Больше этого не принимаем: трекер локальный, гигабайтные видео ему не нужны. */
const MAX = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "нет файла" }, { status: 400 });
  }
  if (file.size > MAX) {
    return NextResponse.json({ error: "файл больше 25 МБ" }, { status: 413 });
  }

  // У вставленного из буфера скриншота имени нет, придумываем своё
  const original = file.name && file.name !== "image.png" ? file.name : `скриншот-${Date.now()}.png`;
  const clean = original.replace(/[^\w.\-а-яё ]/gi, "_").replace(/^\.+/, "").slice(-80) || "file";
  const id = `${Math.random().toString(36).slice(2, 9)}-${clean}`;

  await fs.mkdir(FILES_DIR, { recursive: true });
  await fs.writeFile(path.join(FILES_DIR, id), Buffer.from(await file.arrayBuffer()));

  const att: Attachment = {
    id,
    name: original,
    type: file.type || "application/octet-stream",
    size: file.size,
    addedAt: new Date().toISOString(),
  };
  return NextResponse.json(att);
}
