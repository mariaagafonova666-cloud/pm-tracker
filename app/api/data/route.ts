import { NextResponse } from "next/server";
import { readData, writeData } from "@/lib/store";
import type { TrackerData } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readData());
}

export async function POST(req: Request) {
  const body = (await req.json()) as TrackerData;
  if (!body || !Array.isArray(body.tasks)) {
    return NextResponse.json({ error: "плохой формат" }, { status: 400 });
  }

  // Защита от затирания: если файл успел измениться в другой вкладке,
  // не записываем поверх, а возвращаем актуальные данные.
  const current = await readData();
  if (typeof body.rev === "number" && typeof current.rev === "number" && body.rev !== current.rev) {
    return NextResponse.json(
      { error: "устаревшая версия", current },
      { status: 409 }
    );
  }

  const rev = await writeData(body);
  return NextResponse.json({ ok: true, rev, savedAt: new Date().toISOString() });
}
