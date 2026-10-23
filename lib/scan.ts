import { promises as fs } from "fs";
import path from "path";
import type { Candidate, Due, TaskType } from "./types";

/**
 * Папка с заметками о встречах. Только чтение, ничего не меняем.
 * Путь задаётся в данных (`workDir`), по умолчанию папка Work рядом с проектом.
 */
export const defaultWorkDir = () => path.resolve(process.cwd(), "..", "Work");
export const resolveWorkDir = (dir?: string) =>
  dir ? path.resolve(process.cwd(), dir) : defaultWorkDir();

/** Секции, в которых лежат настоящие задачи. */
const SECTION =
  /(action items|задачи и следующие шаги|действия и следующие шаги|следующие шаги|действия(?=\s|$)|next steps|итоги.*задачи)/i;

/**
 * Как владелец трекера называет себя в протоколах. Такие пункты его
 * собственные, а не задачи коллеги с таким именем. Задаётся в данных.
 */
const DEFAULT_SELF: string[] = [];

/** Всё после этих заголовков не разбираем: там сырая расшифровка разговора. */
const CUT = /^(transcript|notes|расшифровка|расшифровку)(?=\s|:|$)/i;

/** Глаголы, по которым пункт опознаётся как пинг, а не как задача. */
const PING =
  /^(спросить|уточнить|согласовать|донести|напомнить|обсудить с|проконтролировать|синхронизироваться|переслать|дозвониться|запросить у)(?=\s|$)/i;

const MEETING = /^(запланировать|назначить|провести встречу|груминг|созвон)/i;

/**
 * «Пётр организовать встречу»: заглавное слово, за которым инфинитив.
 * В протоколах так пишут постоянно, двоеточие ставят не всегда.
 */
const NAME_VERB = /^([А-ЯЁ][а-яё]{2,})\s+[а-яё]+(?:ть|ти|чь)(?=\s|$|[.,;:])/;

/** Слова, которые выглядят как имя, но им не являются. */
const NOT_NAME = new Set([
  "нужно","надо","можно","следует","стоит","важно","срочно","также","затем",
  "далее","после","перед","чтобы","если","когда","пока","сначала","затем",
]);

/** Имя в начале строки: "Пётр: сделать X", "Анна и Пётр: сверить". */
const ASSIGNEE =
  /^([А-ЯЁA-Z][а-яёa-z]+(?:\s+и\s+[А-ЯЁA-Z][а-яёa-z]+)?)\s*:\s*/;

/**
 * Имена папок обычно не совпадают с названиями проектов в трекере.
 * Без таблицы соответствий каждая встреча плодила бы проекты-двойники.
 * Таблица личная, поэтому живёт в данных, а не в коде: ключ `projectAliases`
 * в data/tracker.json, например {"Биллинг Project": "Биллинг"}.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "assets",
  "test-documents",
  ".claude",
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(p, out);
    } else if (e.name.endsWith(".md")) {
      // Файлы dev-tasks это тикеты для разработчиков. Их чекбоксы это
      // критерии приёмки, а не дела Марии.
      if (/^dev-tasks/i.test(e.name)) continue;
      out.push(p);
    }
  }
  return out;
}

function projectOf(file: string, alias: Record<string, string>, root: string): string {
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  if (parts.length === 1) return "Без проекта";
  // самая глубокая папка обычно и есть проект
  const folder = parts[parts.length - 2];
  return alias[folder] ?? folder;
}

function classify(text: string): { type: TaskType; who?: string } {
  if (MEETING.test(text)) return { type: "meeting" };
  if (PING.test(text)) {
    const m = text.match(/\b(?:у|с|до)\s+([А-ЯЁ][а-яё]+[а-яё]*)/);
    return { type: "ping", who: m ? m[1] : undefined };
  }
  return { type: "task" };
}

function dueFrom(text: string): Due {
  // Внимание: \b в JS опирается на латиницу и с кириллицей не срабатывает.
  const has = (w: string) => new RegExp(`(^|[\\s(«"])${w}([\\s.,;:)»"]|$)`, "i").test(text);
  if (has("сегодня")) return "сегодня";
  if (has("завтра")) return "завтра";
  if (has("на неделе") || has("до пятницы") || has("до конца недели")) return "на неделе";
  return "без срока";
}

/** Проекты, которые встречаются в рабочих папках. Для выбора при разборе. */
export async function listProjects(
  alias: Record<string, string> = {},
  workDir?: string
): Promise<string[]> {
  const root = resolveWorkDir(workDir);
  const files = await walk(root);
  return [...new Set(files.map((f) => projectOf(f, alias, root)))].sort((a, b) =>
    a.localeCompare(b, "ru")
  );
}

export interface ScanResult {
  candidates: Candidate[];
  filesRead: number;
  filesSkipped: number;
}

/**
 * Собирает кандидатов в инбокс.
 * @param seenRaw     уже показанные ранее пункты, чтобы не предлагать их снова
 * @param since       разбирать только файлы, изменённые после этой даты
 * @param onlyProject разбирать один проект, а не всё сразу
 */
export async function scanWork(
  seenRaw: string[] = [],
  since?: string,
  onlyProject?: string,
  knownNames: string[] = [],
  opts: { selfNames?: string[]; alias?: Record<string, string>; workDir?: string } = {}
): Promise<ScanResult> {
  const WORK_DIR = resolveWorkDir(opts.workDir);
  const SELF = new Set((opts.selfNames ?? DEFAULT_SELF).map((n) => n.toLowerCase()));
  const alias = opts.alias ?? {};
  // Имена, которые уже встречались в трекере. Позволяют разобрать строку
  // «Пётр организовать встречу», где двоеточия нет.
  const names = knownNames
    .map((n) => n.trim())
    .filter((n) => /^[А-ЯЁA-Z][а-яёa-z]+$/.test(n));
  const files = await walk(WORK_DIR);
  const seen = new Set(seenRaw);
  const sinceMs = since ? Date.parse(since) : 0;
  const candidates: Candidate[] = [];
  let filesRead = 0;
  let filesSkipped = 0;

  for (const file of files) {
    const st = await fs.stat(file);
    if (sinceMs && st.mtimeMs <= sinceMs) {
      filesSkipped++;
      continue;
    }
    filesRead++;

    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n");
    const project = projectOf(file, alias, WORK_DIR);
    if (onlyProject && project !== onlyProject) {
      filesRead--;
      filesSkipped++;
      continue;
    }
    let inSection = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // дошли до расшифровки разговора, дальше не читаем этот файл
      if (CUT.test(line.trim())) break;

      if (/^#{1,6}\s/.test(line)) {
        inSection = SECTION.test(line);
        continue;
      }
      if (!inSection) continue;

      const m = line.match(/^\s*-\s*\[ \]\s*(.+?)\s*$/);
      if (!m) continue;

      let body = m[1];
      if (seen.has(body)) continue;

      const a = body.match(ASSIGNEE);
      let assignee = a ? a[1] : undefined;
      if (a) body = body.slice(a[0].length);
      if (assignee && SELF.has(assignee.toLowerCase())) assignee = undefined;

      if (!assignee) {
        const first = body.split(/[\s,]+/)[0];
        const hit = names.find((n) => n.toLowerCase() === first.toLowerCase());
        const nv = body.match(NAME_VERB);
        const candidate = hit ?? (nv && !NOT_NAME.has(nv[1].toLowerCase()) ? nv[1] : undefined);
        if (candidate) {
          body = body.slice(candidate.length).replace(/^[\s,:-]+/, "");
          if (!SELF.has(candidate.toLowerCase())) assignee = candidate;
        }
      }

      const { type, who } = classify(body);

      candidates.push({
        id: `c_${Buffer.from(file).toString("base64url").slice(-8)}_${i}`,
        was: m[1],
        now: body.charAt(0).toUpperCase() + body.slice(1),
        type,
        project,
        due: dueFrom(body),
        assignee: assignee ?? who,
        flag: who && !assignee ? `адресат вопроса: ${who}` : undefined,
        source: { file: path.relative(WORK_DIR, file), line: i + 1, raw: m[1] },
      });
    }
  }

  return { candidates, filesRead, filesSkipped };
}
