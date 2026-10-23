import { NextResponse } from "next/server";
import { readData, writeData } from "@/lib/store";
import { listProjects, scanWork } from "@/lib/scan";

export const dynamic = "force-dynamic";

/**
 * Разбирает рабочие папки и кладёт кандидатов в инбокс.
 * Ничего не пишет в исходные заметки.
 * ?all=1 разбирает все файлы, а не только изменённые с прошлого раза.
 */
/** Список проектов, которые вообще встречаются в рабочих папках. */
export async function GET() {
  const data = await readData();
  return NextResponse.json({
    projects: await listProjects(data.projectAliases ?? {}, data.workDir),
  });
}

export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  const all = params.get("all") === "1";
  const project = params.get("project") ?? undefined;
  const data = await readData();

  // Первый разбор не должен вываливать полгода истории: без явного
  // "разобрать всё" смотрим только последние две недели.
  const fortnight = new Date(Date.now() - 14 * 86400000).toISOString();
  const since = all ? undefined : data.lastScan ?? fortnight;

  // Имена, которые уже знает трекер: исполнители задач и адресаты пингов.
  const knownNames = [
    ...new Set([
      ...data.tasks.map((t) => t.assignee).filter(Boolean),
      ...data.pings.map((p) => p.who),
    ]),
  ] as string[];

  const { candidates, filesRead, filesSkipped } = await scanWork(
    data.seenRaw,
    project ? undefined : since, // разбор одного проекта смотрит всю его историю
    project,
    knownNames,
    { selfNames: data.ownerNames, alias: data.projectAliases, workDir: data.workDir }
  );

  const known = new Set(data.inbox.map((c) => c.was));
  const fresh = candidates.filter((c) => !known.has(c.was));

  data.inbox = [...data.inbox, ...fresh];
  data.lastScan = new Date().toISOString();
  await writeData(data);

  return NextResponse.json({
    added: fresh.length,
    filesRead,
    filesSkipped,
    inbox: data.inbox.length,
    project: project ?? null,
  });
}
