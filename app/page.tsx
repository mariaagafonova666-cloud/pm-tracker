"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, Due, Ping, Prio, Project, Task, TrackerData } from "@/lib/types";

const DUES: Due[] = ["просрочено", "сегодня", "завтра", "на неделе", "без срока"];
const TYPES = [
  { v: "task", l: "задача" },
  { v: "ping", l: "пинг" },
  { v: "meeting", l: "встреча" },
] as const;

const uid = () => Math.random().toString(36).slice(2, 9);

/** Сколько в проекте открытых задач, не помеченных шагом. */
function unsortedCountHelper(visible: Task[], view: string | null) {
  return view ? visible.filter((t) => !t.isStep && !t.done).length : 0;
}

const PRIO_NEXT: Record<Prio, Prio> = { high: "medium", medium: "low", low: "high" };
const PRIO_LABEL: Record<Prio, string> = {
  high: "высокий приоритет",
  medium: "средний приоритет",
  low: "низкий приоритет",
};
const PRIO_RANK: Record<Prio, number> = { high: 0, medium: 1, low: 2 };
const DUE_RANK: Record<Due, number> = {
  "просрочено": 0,
  "сегодня": 1,
  "завтра": 2,
  "на неделе": 3,
  "без срока": 4,
};

function dueClass(d: Due) {
  if (d === "сегодня" || d === "просрочено") return "due";
  if (d === "завтра") return "soon";
  return "";
}

/** Закрыто ли это сегодня. Сравниваем календарный день, а не 24 часа. */
function closedToday(iso?: string) {
  if (!iso) return false;
  const a = new Date(iso);
  const b = new Date();
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Сегодняшняя дата в виде ГГГГ-ММ-ДД по местному времени. */
function todayISO() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftISO(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** «30 сентября», «завтра», «в понедельник» для отложенной задачи. */
/** «1 задача», «2 задачи», «5 задач»: русские числительные. */
function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function plannedLabel(iso: string) {
  const t = todayISO();
  if (iso <= t) return "сегодня";
  if (iso === shiftISO(1)) return "завтра";
  const d = new Date(iso + "T12:00:00");
  const days = Math.round((d.getTime() - new Date(t + "T12:00:00").getTime()) / 86400000);
  const label = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  if (days <= 6) return d.toLocaleDateString("ru-RU", { weekday: "long" }) + ", " + label;
  return label;
}

/** Сколько календарных дней задача лежит в дневном списке. */
function daysInDay(t: Task) {
  const from = t.todaySince ?? t.createdAt;
  if (!from) return 0;
  const a = new Date(from);
  a.setHours(0, 0, 0, 0);
  const b = new Date();
  b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

function carriedLabel(n: number) {
  if (n === 1) return "со вчера";
  if (n < 5) return `висит ${n} дня`;
  return `висит ${n} дней`;
}

function daysSince(iso: string) {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86400000));
}

function agoLabel(n: number) {
  if (n === 0) return "спросила сегодня";
  if (n === 1) return "со вчера";
  return `${n} дн. молчит`;
}

function checkLabel(n: number) {
  if (n === 0) return "проверить сегодня";
  if (n === 1) return "проверить завтра";
  return `проверить через ${n} дн.`;
}

export default function Page() {
  const [data, setData] = useState<TrackerData | null>(null);
  type SaveState = { kind: "idle" | "saving" | "saved" | "error" | "conflict"; msg?: string };
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [inboxOpen, setInboxOpen] = useState(false);
  /** null это дневной вид, иначе имя открытого проекта */
  const [view, setView] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<"manual" | "priority" | "due">("manual");
  const [history, setHistory] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [stepText, setStepText] = useState("");
  /** id закрываемого пинга, по которому спрашиваем про следующий шаг */
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [followText, setFollowText] = useState("");
  /** id задачи, под которой сейчас пишем подзадачу */
  const [subFor, setSubFor] = useState<string | null>(null);
  const [subText, setSubText] = useState("");
  /** id задачи, которой сейчас выбираем дату переноса */
  const [deferFor, setDeferFor] = useState<string | null>(null);
  const [showDeferred, setShowDeferred] = useState(false);
  /** имя чеклиста, в который сейчас добавляем, и текст новой строки */
  const [listAdd, setListAdd] = useState<Record<string, string>>({});
  const [newList, setNewList] = useState("");
  const [bulkList, setBulkList] = useState("");
  /** id задачи, которой выбираем чеклист */
  const [listFor, setListFor] = useState<string | null>(null);
  /** открыт диалог завершения проекта */
  const [finishing, setFinishing] = useState(false);
  /** id задачи, которой выбираем родителя */
  const [nestFor, setNestFor] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const [ni, setNi] = useState("");
  const [np, setNp] = useState("");
  const [nd, setNd] = useState<Due>("без срока");
  const [pi, setPi] = useState("");
  const [pk, setPk] = useState<"waiting" | "towrite">("waiting");
  const [pd, setPd] = useState(3);

  const dragTask = useRef<string | null>(null);
  const dragProj = useRef<string | null>(null);
  const firstLoad = useRef(true);
  /**
   * Последняя известная версия файла. Держим отдельно от состояния: иначе два
   * быстрых изменения подряд отправляют старую версию и получают ложный конфликт.
   */
  const revRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    fetch("/api/data")
      .then((r) => r.json())
      .then((d: TrackerData) => {
        revRef.current = d.rev;
        setData(d);
      });
  }, []);

  // сохраняем при любом изменении, с небольшой задержкой
  useEffect(() => {
    if (!data) return;
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    const t = setTimeout(async () => {
      setSave({ kind: "saving" });

      const send = (rev?: number) =>
        fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...data, rev }),
        });

      try {
        let r = await send(revRef.current);

        // Устаревшая версия. Для одного человека это почти всегда вторая,
        // забытая вкладка, а не чужая работа. Забираем свежий номер версии
        // и повторяем один раз, чтобы активная вкладка не теряла правки.
        if (r.status === 409) {
          const fresh: TrackerData = await fetch("/api/data").then((x) => x.json());
          revRef.current = fresh.rev;
          r = await send(fresh.rev);
        }

        if (r.status === 409) {
          setSave({
            kind: "conflict",
            msg: "Не получается сохранить: данные меняются в другой вкладке. Закрой лишние вкладки трекера и обнови страницу.",
          });
          return;
        }
        if (!r.ok) throw new Error(`сервер ответил ${r.status}`);

        const j = await r.json();
        revRef.current = j.rev;
        setSave({ kind: "saved" });
        setTimeout(() => setSave((s) => (s.kind === "saved" ? { kind: "idle" } : s)), 1200);
      } catch {
        setSave({
          kind: "error",
          msg:
            "Изменения не сохранены: сервер не отвечает. Ничего не закрывай, подними сервер и нажми «повторить».",
        });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [data]);

  const retrySave = useCallback(() => {
    // лёгкое касание состояния, чтобы эффект сохранения сработал заново
    setData((prev) => (prev ? { ...prev } : prev));
  }, []);

  // Если закрыть или перезагрузить страницу сразу после правки, отложенное
  // сохранение не успеет уйти. Дописываем данные отдельным каналом, который
  // браузер доставляет даже при уходе со страницы.
  useEffect(() => {
    const flush = () => {
      if (!data) return;
      try {
        navigator.sendBeacon(
          "/api/data",
          new Blob([JSON.stringify({ ...data, rev: revRef.current })], {
            type: "application/json",
          })
        );
      } catch {
        /* браузер не поддерживает, переживём */
      }
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [data]);

  const patch = useCallback((fn: (d: TrackerData) => TrackerData) => {
    setData((prev) => (prev ? fn(structuredClone(prev)) : prev));
  }, []);

  if (!data) return <div className="loading">Загружаю трекер…</div>;

  const kidsOf = (id: string) => data.tasks.filter((t) => t.parent === id);

  /**
   * Задача попадает в день, если её туда взяли или если срок поджимает.
   * Закрытая задача видна только в день, когда её закрыли: назавтра список чистый,
   * а сделанное никуда не пропадает, оно остаётся в проекте.
   */
  const isToday = (t: Task) => {
    if (t.done) return closedToday(t.doneAt);
    // Перенесённая задача ждёт своей даты и в дне не мешается.
    if (t.plannedFor) return t.plannedFor <= todayISO();
    return t.today || t.due === "сегодня" || t.due === "просрочено";
  };

  /** Отложенные на будущее: не в дне, но и не потеряны. */
  const deferred = data.tasks
    .filter((t) => !t.done && t.plannedFor && t.plannedFor > todayISO())
    .sort((a, b) => (a.plannedFor! < b.plannedFor! ? -1 : 1));

  const visible = view
    ? data.tasks.filter((t) => t.project === view)
    : data.tasks.filter(isToday);
  // В проектном виде показываем все задачи проекта плоским списком: подзадача
  // может принадлежать проекту, а её родитель (например встреча) нет.
  // В проектном виде шаги показаны отдельным блоком сверху, поэтому в основном
  // списке их не дублируем: там всё остальное, включая закрытое.
  const unsorted = view
    ? visible.filter((t) => !t.isStep && !t.milestone)
    : visible.filter((t) => !t.parent);
  const ordered =
    sortMode === "manual"
      ? unsorted
      : [...unsorted].sort((a, b) =>
          sortMode === "priority"
            ? PRIO_RANK[a.priority ?? "medium"] - PRIO_RANK[b.priority ?? "medium"]
            : DUE_RANK[a.due] - DUE_RANK[b.due]
        );

  // Закрытое всегда внизу, каким бы ни был порядок выше. Сортировка стабильная,
  // поэтому взаимный порядок внутри групп сохраняется.
  const roots = [...ordered].sort((a, b) => Number(!!a.done) - Number(!!b.done));

  const openCount = visible.filter((t) => !t.done).length;
  const restOpen = unsortedCountHelper(visible, view);
  const overdue = data.tasks.filter((t) => !t.done && t.due === "просрочено").length;
  /** Пинги открытого проекта, либо все, если открыт дневной вид. */
  const inView = (p: Ping) => !view || p.project === view;
  const livePings = data.pings.filter((p) => !p.done && inView(p));
  const donePings = data.pings.filter(
    (p) => p.done && closedToday(p.doneAt) && inView(p)
  );
  const backlog = data.tasks.filter((t) => !t.done && !isToday(t)).length;

  /**
   * История: что происходило в каждый день. Берём дату закрытия, а для
   * незакрытых дату появления. Так день выглядит как страница в ежедневнике.
   */
  const byDay = () => {
    const map = new Map<string, { closed: Task[]; added: Task[] }>();
    const key = (iso: string) => iso.slice(0, 10);
    for (const t of data.tasks) {
      if (t.done && t.doneAt) {
        const k = key(t.doneAt);
        if (!map.has(k)) map.set(k, { closed: [], added: [] });
        map.get(k)!.closed.push(t);
      } else if (t.createdAt) {
        const k = key(t.createdAt);
        if (!map.has(k)) map.set(k, { closed: [], added: [] });
        map.get(k)!.added.push(t);
      }
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  };

  function dayTitle(k: string) {
    const d = new Date(k + "T12:00:00");
    const today = new Date();
    const yest = new Date(Date.now() - 86400000);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const label = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    if (same(d, today)) return `Сегодня, ${label}`;
    if (same(d, yest)) return `Вчера, ${label}`;
    return d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  }

  /** Следующие шаги проекта это его задачи с признаком isStep. */
  const stepsOf = (name: string) =>
    data.tasks.filter((t) => t.isStep && !t.done && t.project === name);

  /** Чеклисты проекта: уникальные метки у его задач, в порядке появления. */
  /** Все чеклисты по всем проектам, для подсказок при разборе. */
  const allLists = [...new Set(data.tasks.map((t) => t.milestone).filter(Boolean))] as string[];

  const liveProjects = data.projects.filter((p) => !p.archived);
  const archivedProjects = data.projects.filter((p) => p.archived);

  const listsOf = (name: string) => {
    const out = [...(data.projects.find((p) => p.name === name)?.lists ?? [])];
    for (const t of data.tasks)
      if (t.project === name && t.milestone && !out.includes(t.milestone)) out.push(t.milestone);
    return out;
  };
  const inList = (name: string, list: string) =>
    data.tasks.filter((t) => t.project === name && t.milestone === list);

  /** Проект считается заблокированным, если внутри есть незакрытая заблокированная задача. */
  const blockedIn = (name: string) =>
    data.tasks.filter((t) => t.blocked && !t.done && t.project === name);

  /* ---------- задачи ---------- */

  function addTask() {
    const title = ni.trim();
    if (!title) return;
    patch((d) => {
      d.tasks.push({
        id: uid(),
        title,
        project: np || view || undefined,
        due: nd,
        type: "task",
        manual: true,
        today: !view,
        todaySince: view ? undefined : new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      return d;
    });
    setNi("");
    setNp("");
    setNd("без срока");
  }

  function toggle(id: string) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t) {
        t.done = !t.done;
        t.doneAt = t.done ? new Date().toISOString() : undefined;
      }
      return d;
    });
  }

  function toggleToday(id: string) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) return d;
      t.today = !t.today;
      t.todaySince = t.today ? new Date().toISOString() : undefined;
      return d;
    });
  }

  /** Номер задачи. Только для глаз, в сортировке не участвует. */
  function setRank(id: string, raw: string) {
    const n = raw.replace(/\D/g, "").slice(0, 3);
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) return d;
      if (n === "") delete t.rank;
      else t.rank = Number(n);
      return d;
    });
  }

  function cyclePrio(id: string) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t) t.priority = PRIO_NEXT[t.priority ?? "medium"];
      return d;
    });
  }

  /** Подзадача наследует проект родителя и живёт внутри него. */
  function addSub(parent: Task) {
    const title = subText.trim();
    if (!title) {
      setSubFor(null);
      return;
    }
    patch((d) => {
      const at = d.tasks.findIndex((x) => x.id === parent.id);
      d.tasks.splice(at + 1 + d.tasks.filter((x) => x.parent === parent.id).length, 0, {
        id: uid(),
        title,
        project: parent.project,
        due: "без срока",
        type: "task",
        parent: parent.id,
        priority: "medium",
        createdAt: new Date().toISOString(),
      });
      return d;
    });
    setSubText("");
  }

  /** Перенести задачу на дату. Пустая строка возвращает её в текущий день. */
  function defer(id: string, iso: string | null) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) return d;
      if (iso) {
        t.plannedFor = iso;
      } else {
        delete t.plannedFor;
        t.today = true;
        t.todaySince = new Date().toISOString();
      }
      return d;
    });
    setDeferFor(null);
  }

  /** Строка вида «Влад: сделать X» разбирается на исполнителя и задачу. */
  function splitAssignee(raw: string): { assignee?: string; title: string } {
    const m = raw.match(/^([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)\s*:\s*(.+)$/);
    return m ? { assignee: m[1], title: m[2] } : { title: raw };
  }

  function addToList(list: string) {
    const raw = (listAdd[list] ?? "").trim();
    if (!raw || !view) return;
    const { assignee, title } = splitAssignee(raw);
    patch((d) => {
      d.tasks.push({
        id: uid(),
        title,
        project: view,
        milestone: list,
        assignee,
        due: "без срока",
        type: "task",
        priority: "medium",
        createdAt: new Date().toISOString(),
      });
      return d;
    });
    setListAdd((s) => ({ ...s, [list]: "" }));
  }

  /** Чеклист это просто имя у проекта. Пустой чеклист существовать может. */
  function createList() {
    const name = newList.trim();
    if (!name || !view) return;
    patch((d) => {
      const p = d.projects.find((x) => x.name === view);
      if (!p) return d;
      p.lists = p.lists ?? [];
      if (!p.lists.includes(name)) p.lists.push(name);
      return d;
    });
    setNewList("");
  }

  /** Поставить напоминание спросить человека про его задачу. */
  function pingAbout(t: Task) {
    patch((d) => {
      d.pings.unshift({
        id: uid(),
        who: t.assignee ?? "",
        what: t.title,
        kind: "waiting",
        project: t.project,
        priority: t.priority ?? "medium",
        askedAt: new Date().toISOString(),
        check: 2,
      });
      return d;
    });
  }

  /**
   * Завершить проект. Открытые задачи не пропадают молча: либо закрываются
   * вместе с ним, либо остаются жить без проекта.
   */
  function finishProject(name: string, withTasks: "close" | "detach") {
    patch((d) => {
      const now = new Date().toISOString();
      for (const t of d.tasks) {
        if (t.project !== name || t.done) continue;
        if (withTasks === "close") {
          t.done = true;
          t.doneAt = now;
        } else {
          delete t.project;
          delete t.milestone;
          delete t.isStep;
        }
      }
      const p = d.projects.find((x) => x.name === name);
      if (p) p.archived = true;
      return d;
    });
    setFinishing(false);
    setView(null);
  }

  function restoreProject(id: string) {
    patch((d) => {
      const p = d.projects.find((x) => x.id === id);
      if (p) delete p.archived;
      return d;
    });
  }

  /** Может ли задача стать подзадачей: только верхний уровень и без своих детей. */
  const canNest = (t: Task) =>
    !t.done && !t.parent && data.tasks.every((x) => x.parent !== t.id);

  /**
   * Кандидаты в родители: открытые задачи верхнего уровня, которые сейчас в дне
   * или в том же проекте. Проект при вложении не меняется, поэтому вкладывать
   * можно куда угодно из того, что перед глазами.
   */
  const parentsFor = (t: Task) =>
    data.tasks.filter(
      (x) =>
        !x.done &&
        !x.parent &&
        x.id !== t.id &&
        (isToday(x) || (x.project ?? null) === (t.project ?? null))
    );

  /** Вложить задачу в другую. Проект не меняется, остаётся свой. */
  function nest(childId: string, parentId: string) {
    patch((d) => {
      const c = d.tasks.find((x) => x.id === childId);
      if (!c) return d;
      c.parent = parentId;
      delete c.today;
      delete c.todaySince;
      // встать сразу под родителем, чтобы не искать её в конце списка
      const ci = d.tasks.findIndex((x) => x.id === childId);
      const [moved] = d.tasks.splice(ci, 1);
      const pi = d.tasks.findIndex((x) => x.id === parentId);
      const after = d.tasks.filter((x) => x.parent === parentId).length;
      d.tasks.splice(pi + 1 + after, 0, moved);
      return d;
    });
    setNestFor(null);
  }

  /** Вынуть подзадачу обратно в самостоятельные. */
  function unnest(id: string) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) return d;
      delete t.parent;
      t.today = true;
      t.todaySince = new Date().toISOString();
      return d;
    });
  }

  function toggleBlocked(id: string) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t) t.blocked = !t.blocked;
      return d;
    });
  }

  /** Пометить существующую задачу чеклистом. Копия не создаётся. */
  function setMilestone(id: string, name: string | null) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) return d;
      if (name && name.trim()) t.milestone = name.trim();
      else delete t.milestone;
      return d;
    });
    setListFor(null);
  }

  function toggleStep(id: string) {
    patch((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (t) t.isStep = !t.isStep;
      return d;
    });
  }

  /** Поднять задачу в самый верх списка. Порядок в файле и есть ручной порядок. */
  function pinTop(id: string) {
    patch((d) => {
      const i = d.tasks.findIndex((t) => t.id === id);
      if (i > 0) d.tasks.unshift(d.tasks.splice(i, 1)[0]);
      return d;
    });
    if (sortMode !== "manual") setSortMode("manual");
  }

  function removeTask(id: string) {
    patch((d) => {
      d.tasks = d.tasks.filter((t) => t.id !== id && t.parent !== id);
      return d;
    });
  }

  function dropTask(overId: string) {
    const from = dragTask.current;
    if (!from || from === overId) return;
    patch((d) => {
      const fi = d.tasks.findIndex((t) => t.id === from);
      const moving = d.tasks.splice(fi, 1)[0];
      const ti = d.tasks.findIndex((t) => t.id === overId);
      d.tasks.splice(ti, 0, moving);
      return d;
    });
  }

  /* ---------- проекты ---------- */

  function dropProject(overId: string) {
    const from = dragProj.current;
    if (!from || from === overId) return;
    patch((d) => {
      const fi = d.projects.findIndex((p) => p.id === from);
      const moving = d.projects.splice(fi, 1)[0];
      const ti = d.projects.findIndex((p) => p.id === overId);
      d.projects.splice(ti, 0, moving);
      return d;
    });
  }

  /* ---------- пинги ---------- */

  /** Шаг это обычная задача с признаком isStep, а не отдельная запись. */
  function addStep(toToday: boolean) {
    const text = stepText.trim();
    if (!text || !view) return;
    patch((d) => {
      d.tasks.push({
        id: uid(),
        title: text,
        project: view,
        due: toToday ? "сегодня" : "без срока",
        type: "task",
        isStep: true,
        today: toToday,
        todaySince: toToday ? new Date().toISOString() : undefined,
        priority: "medium",
        createdAt: new Date().toISOString(),
      });
      return d;
    });
    setStepText("");
  }

  /** Закрываем пинг и спрашиваем, что делать после ответа. */
  function closePing(id: string) {
    pingPatch(id, (x) => {
      x.done = true;
      x.doneAt = new Date().toISOString();
    });
    setFollowUp(id);
    setFollowText("");
  }

  /** Создаём задачу, которая появилась из ответа на пинг. */
  function createFollowUp(p: Ping) {
    const title = followText.trim();
    if (!title) {
      setFollowUp(null);
      return;
    }
    patch((d) => {
      d.tasks.push({
        id: uid(),
        title,
        project: p.project,
        due: "сегодня",
        type: "task",
        today: true,
        todaySince: new Date().toISOString(),
        priority: p.priority ?? "medium",
        fromPing: p.who,
        createdAt: new Date().toISOString(),
      });
      return d;
    });
    setFollowUp(null);
    setFollowText("");
  }

  function addPing() {
    const raw = pi.trim();
    if (!raw) return;
    const m = raw.match(/^([^,:]+)[,:]\s*(.+)$/);
    patch((d) => {
      d.pings.unshift({
        id: uid(),
        who: m ? m[1].trim() : raw,
        what: m ? m[2].trim() : "",
        kind: pk,
        project: view ?? undefined,
        priority: "medium",
        askedAt: new Date().toISOString(),
        check: pd,
      });
      return d;
    });
    setPi("");
  }

  function pingPatch(id: string, fn: (p: Ping) => void) {
    patch((d) => {
      const p = d.pings.find((x) => x.id === id);
      if (p) fn(p);
      return d;
    });
  }

  /* ---------- инбокс ---------- */

  async function scan(opts: { all?: boolean; project?: string } = {}) {
    setScanning(true);
    setScanNote(null);
    try {
      const q = opts.project
        ? `?project=${encodeURIComponent(opts.project)}`
        : opts.all
        ? "?all=1"
        : "";
      const r = await fetch(`/api/scan${q}`, { method: "POST" });
      const j = await r.json();
      const fresh: TrackerData = await fetch("/api/data").then((x) => x.json());
      revRef.current = fresh.rev;
      firstLoad.current = true;
      setData(fresh);
      const where = j.project ? `по проекту ${j.project}` : "в новых заметках";
      setScanNote(
        j.added
          ? `Нашла ${j.added} кандидатов ${where}, прочитано файлов: ${j.filesRead}`
          : `Новых задач ${where} нет, прочитано файлов: ${j.filesRead}`
      );
      if (j.added) setInboxOpen(true);
    } finally {
      setScanning(false);
    }
  }

  function candPatch(id: string, fn: (c: Candidate) => void) {
    patch((d) => {
      const c = d.inbox.find((x) => x.id === id);
      if (c) fn(c);
      return d;
    });
  }

  function take(id: string) {
    patch((d) => {
      const c = d.inbox.find((x) => x.id === id);
      if (!c) return d;

      // Разбор может принести проект, которого нет на доске. Без этого
      // задача уезжала в невидимое место: открыть такой проект было негде.
      if (c.project && !d.projects.some((p) => p.name === c.project)) {
        d.projects.push({ id: uid(), name: c.project, level: "medium", steps: [] });
      }
      if (c.type === "ping") {
        d.pings.unshift({
          id: uid(),
          who: c.flag?.replace(/^адресат вопроса:\s*/, "") || c.now.split(/[,:]/)[0],
          what: c.now,
          kind: "waiting",
          askedAt: new Date().toISOString(),
          check: 1,
        });
      } else {
        d.tasks.push({
          id: uid(),
          title: c.now,
          project: c.project,
          milestone: c.milestone || undefined,
          assignee: c.assignee,
          due: c.due,
          type: c.type,
          source: c.source,
          priority: "medium",
          createdAt: new Date().toISOString(),
        });
      }
      d.seenRaw.push(c.was);
      d.inbox = d.inbox.filter((x) => x.id !== id);
      return d;
    });
  }

  function skip(id: string) {
    patch((d) => {
      const c = d.inbox.find((x) => x.id === id);
      if (c) d.seenRaw.push(c.was);
      d.inbox = d.inbox.filter((x) => x.id !== id);
      return d;
    });
  }

  /* ---------- разметка ---------- */

  const TaskRow = ({ t, child }: { t: Task; child?: boolean }) => (
    <div
      className={`t${t.done ? " is-done" : ""}`}
      draggable={!child}
      onDragStart={() => (dragTask.current = t.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => dropTask(t.id)}
    >
      {!child && <span className="grip">⠇</span>}
      <span
        className={`tp tp-${t.priority ?? "medium"}`}
        title={`${PRIO_LABEL[t.priority ?? "medium"]}, клик меняет`}
        onClick={() => cyclePrio(t.id)}
      />
      <span className={`bx${t.done ? " done" : ""}`} onClick={() => toggle(t.id)} />
      <div className="body">
        <div className="ttl">{t.title}</div>
        <div className="meta">
          <span className={dueClass(t.due)}>{t.due}</span>
          {t.project && <span className="chip">{t.project}</span>}
          {t.assignee && <span className="chip who-chip">{t.assignee}</span>}
          {t.milestone && <span className="chip mile">{t.milestone}</span>}
          {t.type === "meeting" && <span className="chip">повестка</span>}
          {t.blocked && !t.done && <span className="chip blockchip">блокер</span>}
          {t.plannedFor && !t.done && (
            <span className="chip planned">на {plannedLabel(t.plannedFor)}</span>
          )}
          {!view && !t.done && daysInDay(t) > 0 && (
            <span className={`chip carried${daysInDay(t) >= 5 ? " old" : ""}`}>
              {carriedLabel(daysInDay(t))}
            </span>
          )}
          {t.fromPing && <span className="chip src">после ответа: {t.fromPing}</span>}
          {t.done &&
            (() => {
              const left = data.tasks.filter((x) => x.parent === t.id && !x.done).length;
              return left ? (
                <span className="chip carried">
                  внутри {left} {plural(left, "незакрытый пункт", "незакрытых пункта", "незакрытых пунктов")}
                </span>
              ) : null;
            })()}
          {t.done && t.doneAt && !closedToday(t.doneAt) && (
            <span className="chip">
              закрыто {new Date(t.doneAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
            </span>
          )}
          {t.source && (
            <span className="chip src" title={`${t.source.file}, строка ${t.source.line}`}>
              из заметки
            </span>
          )}
          {view && !t.done && (
            <button className="mini" onClick={() => toggleToday(t.id)}>
              {t.today ? "убрать из сегодня" : "на сегодня"}
            </button>
          )}
          {!t.done && (
            <button
              className="mini"
              onClick={() => setDeferFor(deferFor === t.id ? null : t.id)}
              title="показать эту задачу в другой день"
            >
              перенести
            </button>
          )}
          {!t.done && (
            <button
              className={`mini${t.blocked ? " blockon" : ""}`}
              onClick={() => toggleBlocked(t.id)}
              title={
                t.blocked
                  ? "снять блокер: работа снова зависит от тебя"
                  : "отметить блокер: работа стоит и зависит не от тебя"
              }
            >
              {t.blocked ? "снять блокер" : "в блокер"}
            </button>
          )}
          {child && !t.done && (
            <button className="mini" onClick={() => unnest(t.id)} title="сделать самостоятельной">
              вынуть
            </button>
          )}
          {!child && !t.done && !canNest(t) && (
            <button className="mini" disabled title="внутри уже есть подзадачи">
              вложить
            </button>
          )}
          {!child && !t.done && canNest(t) && parentsFor(t).length > 0 && (
            <button
              className="mini"
              onClick={() => setNestFor(nestFor === t.id ? null : t.id)}
              title="сделать подзадачей другой задачи"
            >
              вложить
            </button>
          )}
          {!child && !t.done && (
            <button
              className="mini"
              onClick={() => {
                setSubFor(subFor === t.id ? null : t.id);
                setSubText("");
              }}
              title="добавить пункт внутрь задачи"
            >
              + подзадача
            </button>
          )}
          {t.project && !t.done && (
            <button
              className={`mini${t.milestone ? " onday" : ""}`}
              onClick={() => setListFor(listFor === t.id ? null : t.id)}
              title={t.milestone ? "сменить или убрать чеклист" : "добавить в чеклист проекта"}
            >
              {t.milestone ? "✓ в чеклисте" : "в чеклист"}
            </button>
          )}
          {t.project && !t.done && (
            <button
              className={`mini star${t.isStep ? " on" : ""}`}
              onClick={() => toggleStep(t.id)}
              title={t.isStep ? "убрать из шагов проекта" : "сделать следующим шагом проекта"}
            >
              {t.isStep ? "★ шаг проекта" : "☆ в шаги"}
            </button>
          )}
        </div>
      </div>
      {!t.done && (
        <input
          className={`rank${t.rank == null ? " empty" : ""}`}
          value={t.rank ?? ""}
          onChange={(e) => setRank(t.id, e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          draggable={false}
          inputMode="numeric"
          placeholder="#"
          title="номер, который ставишь ты"
        />
      )}
      {!child && !t.done && (
        <button className="totop" onClick={() => pinTop(t.id)} title="В самый верх">
          ↑
        </button>
      )}
      <button className="del" onClick={() => removeTask(t.id)} title="Удалить">
        ×
      </button>
      {nestFor === t.id && (
        <div className="deferbox nestbox">
          <span className="dl">Сделать подзадачей</span>
          {t.today && (
            <span className="warn">
              задача сейчас в дне, после вложения будет видна только внутри родителя
            </span>
          )}
          <div className="plist">
            {(() => {
              const all = parentsFor(t);
              const inDay = all.filter((p) => isToday(p));
              const inProject = all.filter((p) => !isToday(p));
              const btn = (p: Task) => (
                <button key={p.id} className="mini" onClick={() => nest(t.id, p.id)}>
                  {p.title.length > 44 ? p.title.slice(0, 44) + "…" : p.title}
                  {p.project && <span className="pin">{p.project}</span>}
                </button>
              );
              return (
                <>
                  {inDay.length > 0 && <div className="pgrp">Задачи дня</div>}
                  {inDay.map(btn)}
                  {inProject.length > 0 && (
                    <div className="pgrp">
                      {t.project ? `Проект ${t.project}` : "Без проекта"}
                    </div>
                  )}
                  {inProject.map(btn)}
                </>
              );
            })()}
          </div>
          <button className="mini" onClick={() => setNestFor(null)}>
            отмена
          </button>
        </div>
      )}
      {listFor === t.id && (
        <div className="deferbox">
          <span className="dl">Чеклист проекта {t.project}</span>
          {listsOf(t.project!).map((l) => (
            <button
              key={l}
              className={`mini${t.milestone === l ? " onday" : ""}`}
              onClick={() => setMilestone(t.id, l)}
            >
              {l}
            </button>
          ))}
          <input
            className="mlist"
            list="all-lists"
            defaultValue=""
            placeholder="или новый чеклист"
            onKeyDown={(e) => {
              if (e.key === "Enter") setMilestone(t.id, (e.target as HTMLInputElement).value);
            }}
          />
          {t.milestone && (
            <button className="mini" onClick={() => setMilestone(t.id, null)}>
              убрать из чеклиста
            </button>
          )}
        </div>
      )}
      {deferFor === t.id && (
        <div className="deferbox">
          <span className="dl">Показать снова</span>
          <button className="mini" onClick={() => defer(t.id, shiftISO(1))}>
            завтра
          </button>
          <button className="mini" onClick={() => defer(t.id, shiftISO(2))}>
            послезавтра
          </button>
          <button className="mini" onClick={() => defer(t.id, shiftISO(7))}>
            через неделю
          </button>
          <input
            type="date"
            min={shiftISO(1)}
            value={t.plannedFor ?? ""}
            onChange={(e) => e.target.value && defer(t.id, e.target.value)}
          />
          {t.plannedFor && (
            <button className="mini" onClick={() => defer(t.id, null)}>
              вернуть в сегодня
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <datalist id="all-lists">
        {allLists.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {(save.kind === "error" || save.kind === "conflict") && (
        <div className={`banner ${save.kind}`}>
          <span>{save.msg}</span>
          {save.kind === "error" ? (
            <button className="take" onClick={retrySave}>
              Повторить
            </button>
          ) : (
            <button className="take" onClick={() => location.reload()}>
              Обновить страницу
            </button>
          )}
        </div>
      )}
      <aside>
        <div className="brand">Трекер</div>
        <div
          className={`it today-link${view === null && !history ? " on" : ""}`}
          onClick={() => {
            setHistory(false);
            setView(null);
          }}
        >
          <span className="nm">Сегодня</span>
          <span className="n">{data.tasks.filter((t) => isToday(t) && !t.done).length}</span>
        </div>
        <div
          className={`it today-link${history ? " on" : ""}`}
          onClick={() => {
            setHistory(true);
            setView(null);
          }}
        >
          <span className="nm">История по дням</span>
        </div>
        <div className="nav-h" style={{ marginTop: 14 }}>
          <span>Проекты</span>
          <span>перетащи</span>
        </div>
        {liveProjects.map((p: Project) => (
          <div
            key={p.id}
            className="proj"
            draggable
            onDragStart={() => (dragProj.current = p.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dropProject(p.id)}
          >
            <div
              className={`it${view === p.name ? " on" : ""}`}
              onClick={() => {
                setHistory(false);
                setView(view === p.name ? null : p.name);
              }}
            >
              <span className={`pr ${p.level}`} />
              <span className="nm">{p.name}</span>
              {blockedIn(p.name).length > 0 && (
                <span
                  className="blk"
                  title={blockedIn(p.name)
                    .map((t) => t.title)
                    .join("\n")}
                >
                  блокер {blockedIn(p.name).length > 1 ? blockedIn(p.name).length : ""}
                </span>
              )}
              <span className="n">
                {data.tasks.filter((t) => t.project === p.name && !t.done).length}
              </span>
            </div>
            <div className="steps">
              {stepsOf(p.name).length ? (
                stepsOf(p.name).map((t) => (
                  <div key={t.id} className={t.today ? "inday" : undefined}>
                    {t.title}
                  </div>
                ))
              ) : (
                <div className="none">шаги пока не заданы</div>
              )}
            </div>
          </div>
        ))}
        {archivedProjects.length > 0 && (
          <div className="archive">
            <button className="deftoggle" onClick={() => setShowArchive((v) => !v)}>
              {showArchive ? "▾" : "▸"} Завершённые: {archivedProjects.length}
            </button>
            {showArchive &&
              archivedProjects.map((p) => (
                <div className="arow" key={p.id}>
                  <span>{p.name}</span>
                  <button className="mini" onClick={() => restoreProject(p.id)}>
                    вернуть
                  </button>
                </div>
              ))}
          </div>
        )}

        <div className="foot">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8c948f" strokeWidth="1.6">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
          </svg>
          <span>{data.owner ?? "Я"}</span>
        </div>
      </aside>

      <main>
        <div className="tools">
          <span className={`saved${save.kind === "saved" ? " on" : ""}`}>сохранено</span>
          {view && (
            <button className="ghost" onClick={() => setView(null)}>
              ← на сегодня
            </button>
          )}
          {view && (
            <button className="ghost" onClick={() => setFinishing((v) => !v)}>
              завершить проект
            </button>
          )}
          <button
            className="ghost"
            onClick={() => scan(view ? { project: view } : {})}
            disabled={scanning}
          >
            {scanning ? "читаю папки…" : view ? `разобрать ${view}` : "разобрать новое"}
          </button>
        </div>
        {history ? (
          <>
            <h1>История по дням</h1>
            <div className="sub">
              Что закрыто и что появилось в каждый день. Как в твоём документе, только
              заполняется само.
            </div>
            {!byDay().length && (
              <div className="empty">
                <b>Пока пусто</b>
                История наберётся за несколько дней работы.
              </div>
            )}
            {byDay().map(([day, g]) => (
              <div className="dayblock" key={day}>
                <h2>
                  <span>{dayTitle(day)}</span>
                  <span>
                    {g.closed.length ? `сделано ${g.closed.length}` : ""}
                    {g.closed.length && g.added.length ? " · " : ""}
                    {g.added.length ? `добавлено ${g.added.length}` : ""}
                  </span>
                </h2>
                <div className="sec">
                  {g.closed.map((t) => (
                    <div className="t is-done" key={t.id}>
                      <span className="bx done" onClick={() => toggle(t.id)} />
                      <div className="body">
                        <div className="ttl">{t.title}</div>
                        <div className="meta">
                          {t.project && <span className="chip">{t.project}</span>}
          {t.assignee && <span className="chip who-chip">{t.assignee}</span>}
          {t.milestone && <span className="chip mile">{t.milestone}</span>}
                          {t.fromPing && (
                            <span className="chip src">после ответа: {t.fromPing}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {g.added.map((t) => (
                    <div className="t" key={t.id}>
                      <span className="bx" onClick={() => toggle(t.id)} />
                      <div className="body">
                        <div className="ttl">{t.title}</div>
                        <div className="meta">
                          <span className="chip">появилась в этот день</span>
                          {t.project && <span className="chip">{t.project}</span>}
          {t.assignee && <span className="chip who-chip">{t.assignee}</span>}
          {t.milestone && <span className="chip mile">{t.milestone}</span>}
                          <span className={dueClass(t.due)}>{t.due}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : (
        <>
        {view && finishing && (
          <div className="finishbox">
            {(() => {
              const left = data.tasks.filter((t) => t.project === view && !t.done).length;
              return left ? (
                <>
                  <b>
                    В проекте {left}{" "}
                    {plural(left, "незакрытая задача", "незакрытые задачи", "незакрытых задач")}.
                    Что с ними?
                  </b>
                  <p>
                    Молча унести их в архив нельзя: они потеряются, и ты узнаешь об этом через
                    месяц.
                  </p>
                  <div className="fb">
                    <button className="skip" onClick={() => setFinishing(false)}>
                      отмена
                    </button>
                    <button className="skip" onClick={() => finishProject(view, "detach")}>
                      оставить без проекта
                    </button>
                    <button className="take" onClick={() => finishProject(view, "close")}>
                      закрыть всё и завершить
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <b>Все задачи закрыты. Завершаем проект?</b>
                  <p>Он уйдёт в «Завершённые» внизу панели, вернуть можно одной кнопкой.</p>
                  <div className="fb">
                    <button className="skip" onClick={() => setFinishing(false)}>
                      отмена
                    </button>
                    <button className="take" onClick={() => finishProject(view, "close")}>
                      завершить
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        <h1>
          {view ??
            new Date().toLocaleDateString("ru-RU", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
        </h1>
        <div className="sub">
          {view
            ? `${openCount} открытых: ${stepsOf(view).length} в шагах, ${restOpen} в бэклоге`
            : `${openCount} на сегодня, просрочено ${overdue}, в проектах ждёт ${backlog}`}
          {scanNote ? ` · ${scanNote}` : ""}
        </div>

        {view && (
          <div className="stepbox">
            <h2>
              <span>Следующие шаги</span>
              <span>{stepsOf(view).length}</span>
            </h2>
            {!stepsOf(view).length && (
              <div className="steprow dim">
                <span>Шагов пока нет. Шаг это задача, помеченная звёздочкой.</span>
              </div>
            )}
            {stepsOf(view).map((t) => (
              <div className="steprow" key={t.id}>
                <span
                  className={`bx${t.done ? " done" : ""}`}
                  onClick={() => toggle(t.id)}
                  title="закрыть"
                />
                <span>{t.title}</span>
                {t.today ? (
                  <span className="chip">в дне</span>
                ) : (
                  <button className="mini" onClick={() => toggleToday(t.id)}>
                    на сегодня
                  </button>
                )}
                <button className="del" onClick={() => toggleStep(t.id)} title="Убрать из шагов">
                  ×
                </button>
              </div>
            ))}
            <div className="steprow2">
              <input
                className="stepinput"
                value={stepText}
                onChange={(e) => setStepText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addStep(false)}
                placeholder="Новый шаг по проекту, Enter добавит в задачи проекта"
              />
              <button className="mini" onClick={() => addStep(true)} disabled={!stepText.trim()}>
                сразу в день
              </button>
            </div>
          </div>
        )}

        {view &&
          listsOf(view).map((list) => {
            const items = inList(view, list);
            const done = items.filter((t) => t.done).length;
            return (
              <div className="stepbox" key={list}>
                <h2>
                  <span>{list}</span>
                  <span>
                    {done} из {items.length}
                  </span>
                </h2>
                <div className="bar">
                  <i style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
                </div>
                {!items.length && (
                  <div className="steprow dim">
                    <span>
                      Пусто. Добавь пункт ниже или помечай существующие задачи кнопкой «в
                      чеклист».
                    </span>
                  </div>
                )}
                {items.map((t) => (
                  <div className={`steprow${t.done ? " isdone" : ""}`} key={t.id}>
                    <span
                      className={`bx${t.done ? " done" : ""}`}
                      onClick={() => toggle(t.id)}
                      title="закрыть"
                    />
                    <span>{t.title}</span>
                    {t.assignee ? (
                      <span className="chip who-chip">{t.assignee}</span>
                    ) : (
                      <span className="chip">я</span>
                    )}
                    {!t.done && t.assignee && (
                      <button
                        className="mini"
                        onClick={() => pingAbout(t)}
                        title="поставить напоминание спросить"
                      >
                        пингануть
                      </button>
                    )}
                    {!t.done && !t.assignee && t.today && (
                      <button
                        className="mini onday"
                        onClick={() => toggleToday(t.id)}
                        title="убрать из дневного списка, из чеклиста не денется"
                      >
                        в дне
                      </button>
                    )}
                    {!t.done && !t.assignee && !t.today && (
                      <button className="mini" onClick={() => toggleToday(t.id)}>
                        на сегодня
                      </button>
                    )}
                    {!t.done && t.assignee && !t.today && (
                      <button
                        className="mini"
                        onClick={() => toggleToday(t.id)}
                        title="держать перед глазами в дневном списке"
                      >
                        мне в день
                      </button>
                    )}
                    {!t.done && t.assignee && t.today && (
                      <button className="mini onday" onClick={() => toggleToday(t.id)}>
                        в дне
                      </button>
                    )}
                    <button className="del" onClick={() => removeTask(t.id)} title="Удалить">
                      ×
                    </button>
                  </div>
                ))}
                <input
                  className="stepinput"
                  value={listAdd[list] ?? ""}
                  onChange={(e) => setListAdd((s) => ({ ...s, [list]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && addToList(list)}
                  placeholder="Новый пункт. «Влад: сделать X» запишет задачу на Влада"
                />
              </div>
            );
          })}

        {view && (
          <div className="newlist">
            <input
              value={newList}
              onChange={(e) => setNewList(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createList()}
              placeholder="+ новый чеклист, например «Запуск Hold»"
            />
          </div>
        )}

        <h2>
          <span>{view ? "Остальные задачи проекта" : "Сегодня"}</span>
          <span>
            <select
              className="sortsel"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
            >
              <option value="manual">мой порядок</option>
              <option value="priority">по приоритету</option>
              <option value="due">по сроку</option>
            </select>{" "}
            {view ? restOpen : openCount}
          </span>
        </h2>
        <div className="sec">
          {!roots.length && (
            <div className="empty" style={{ padding: 28 }}>
              {view
                ? "Кроме шагов, по проекту задач нет. Добавь ниже."
                : "На сегодня ничего не взято."}
            </div>
          )}
          {roots.map((t) => (
            <div key={t.id}>
              <TaskRow t={t} />
              {!view && (kidsOf(t.id).length > 0 || subFor === t.id) && (
                <div className="kids">
                  {kidsOf(t.id).map((k) => (
                    <TaskRow key={k.id} t={k} child />
                  ))}
                  {subFor === t.id && (
                    <input
                      className="subinput"
                      autoFocus
                      value={subText}
                      onChange={(e) => setSubText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addSub(t);
                        if (e.key === "Escape") setSubFor(null);
                      }}
                      onBlur={() => !subText.trim() && setSubFor(null)}
                      placeholder="Пункт внутри задачи, Enter добавит"
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {!view && deferred.length > 0 && (
          <div className="deferred">
            <button className="deftoggle" onClick={() => setShowDeferred((v) => !v)}>
              {showDeferred ? "▾" : "▸"} Отложено на потом: {deferred.length}
            </button>
            {showDeferred && (
              <div className="sec">
                {deferred.map((t) => (
                  <div className="t" key={t.id}>
                    <span
                      className={`tp tp-${t.priority ?? "medium"}`}
                      onClick={() => cyclePrio(t.id)}
                    />
                    <div className="body">
                      <div className="ttl">{t.title}</div>
                      <div className="meta">
                        <span className="chip planned">
                          вернётся {plannedLabel(t.plannedFor!)}
                        </span>
                        {t.project && <span className="chip">{t.project}</span>}
          {t.assignee && <span className="chip who-chip">{t.assignee}</span>}
          {t.milestone && <span className="chip mile">{t.milestone}</span>}
                        <button className="mini" onClick={() => defer(t.id, null)}>
                          вернуть в сегодня
                        </button>
                      </div>
                    </div>
                    <button className="del" onClick={() => removeTask(t.id)} title="Удалить">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="newrow">
          <input
            value={ni}
            onChange={(e) => setNi(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTask()}
            placeholder={view ? `Что нужно по проекту ${view}?` : "Что нужно сделать? Enter"}
          />
          <button
            className="mini"
            onClick={() => setShowDetails((v) => !v)}
            title="проект и срок, если нужны"
          >
            {showDetails ? "свернуть" : "детали"}
          </button>
        </div>
        {showDetails && (
          <div className="newrow detailrow">
            {!view && (
              <select value={np} onChange={(e) => setNp(e.target.value)}>
                <option value="">без проекта</option>
                {data.projects.map((p) => (
                  <option key={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <select value={nd} onChange={(e) => setNd(e.target.value as Due)}>
              {DUES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
        )}
        <div className="hint">
          {view
            ? "Задача уйдёт в бэклог проекта: не в шаги и не в день. Звёздочка сделает её шагом, кнопка «на сегодня» вытащит в день."
            : "Без проекта и срока: просто напиши и нажми Enter. Такая задача живёт только в дне и нигде не копится."}
        </div>
        </>
        )}
      </main>

      <div className="rail">
        <div className="inbox">
          <div className="h">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2b8a3e" strokeWidth="1.6">
              <path d="M3 12h4l2 4 4-10 2 6h6" />
            </svg>
            <span>{data.inbox.length ? `Разобрать ${data.inbox.length}` : "Инбокс пуст"}</span>
          </div>
          <p>
            {data.inbox.length
              ? "Кандидаты из твоих заметок со встреч. Посмотришь, что брать?"
              : "Положи новую заметку в папку проекта и нажми «разобрать новое»."}
          </p>
          <button className="btn" onClick={() => setInboxOpen(true)} disabled={!data.inbox.length}>
            Открыть инбокс
          </button>
          <button
            className="btn sec2"
            onClick={() => scan({ project: view ?? undefined })}
            disabled={scanning || !view}
            title={view ? `разобрать историю проекта ${view}` : "открой проект слева"}
          >
            {view ? `Разобрать ${view}` : "Разбор по проекту"}
          </button>
        </div>

        <h2>
          <span>{view ? `Пинги по проекту` : "Пингануть"}</span>
          <span>{livePings.length}</span>
        </h2>

        {(["waiting", "towrite"] as const).map((kind) => {
          const arr = livePings
            .filter((p) => p.kind === kind)
            .sort(
              (a, b) =>
                PRIO_RANK[a.priority ?? "medium"] - PRIO_RANK[b.priority ?? "medium"] ||
                Date.parse(a.askedAt) - Date.parse(b.askedAt)
            );
          if (!arr.length) return null;
          return (
            <div key={kind}>
              <div className="grp">{kind === "waiting" ? "Жду ответа" : "Написать мне"}</div>
              {arr.map((p) => {
                const n = daysSince(p.askedAt);
                return (
                  <div className="pg" key={p.id}>
                    <span
                      className={`tp tp-${p.priority ?? "medium"}`}
                      title={`${PRIO_LABEL[p.priority ?? "medium"]}, клик меняет`}
                      onClick={() =>
                        pingPatch(p.id, (x) => (x.priority = PRIO_NEXT[x.priority ?? "medium"]))
                      }
                    />
                    <div className="pbody">
                      <div className="pline">
                        <span className="who">{p.who}</span>{" "}
                        {p.what}
                      </div>
                      <div className="pmeta">
                        <span className={n >= 4 ? "late" : undefined}>{agoLabel(n)}</span>
                        <span className="dot">·</span>
                        <span className={p.check === 0 ? "now" : undefined}>
                          {checkLabel(p.check)}
                        </span>
                        {!view && p.project && (
                          <>
                            <span className="dot">·</span>
                            <span className="pproj">{p.project}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="pa">
                      <button className="pdone" title="закрыть" onClick={() => closePing(p.id)}>
                        ✓
                      </button>
                      <select
                        className="psn"
                        title="перенести проверку"
                        value={p.check}
                        onChange={(e) => pingPatch(p.id, (x) => (x.check = +e.target.value))}
                      >
                        <option value={0}>сег</option>
                        <option value={1}>завтра</option>
                        <option value={2}>+2 дня</option>
                        <option value={3}>+3 дня</option>
                        <option value={7}>+неделя</option>
                      </select>
                      <button
                        className="pdel"
                        title="Удалить"
                        onClick={() =>
                          patch((d) => {
                            d.pings = d.pings.filter((x) => x.id !== p.id);
                            return d;
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="gap" />
            </div>
          );
        })}

        {donePings.length > 0 && (
          <>
            <div className="grp">Закрыто сегодня</div>
            {donePings.map((p) => (
                <div className="pg isdone" key={p.id}>
                  <span className="tp tp-low" />
                  <div className="pbody">
                    <div className="pline">
                      <span className="who">{p.who}</span> {p.what}
                    </div>
                    <div className="pmeta">
                      <span>закрыто, завтра не покажется</span>
                    </div>
                    {followUp === p.id ? (
                      <div className="follow">
                        <div className="fh">Ответ получен. Что теперь сделать?</div>
                        <input
                          autoFocus
                          value={followText}
                          onChange={(e) => setFollowText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createFollowUp(p);
                            if (e.key === "Escape") setFollowUp(null);
                          }}
                          placeholder={p.what || "Например: внести правки в макет"}
                        />
                        <div className="fb">
                          <button className="skip" onClick={() => setFollowUp(null)}>
                            ничего не нужно
                          </button>
                          <button className="take" onClick={() => createFollowUp(p)}>
                            Создать задачу
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="mini" onClick={() => setFollowUp(p.id)}>
                        + задача после ответа
                      </button>
                    )}
                  </div>
                  <div className="pa">
                    <button
                      className="pdone"
                      title="вернуть"
                      onClick={() => pingPatch(p.id, (x) => (x.done = false))}
                    >
                      ↩
                    </button>
                    <button
                      className="pdel"
                      onClick={() =>
                        patch((d) => {
                          d.pings = d.pings.filter((x) => x.id !== p.id);
                          return d;
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                </div>
            ))}
          </>
        )}

        <div className="padd">
          <input
            value={pi}
            onChange={(e) => setPi(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPing()}
            placeholder="Кого и о чём: Пётр, статус интеграции"
          />
          <div className="r">
            <select value={pk} onChange={(e) => setPk(e.target.value as "waiting" | "towrite")}>
              <option value="waiting">жду ответа</option>
              <option value="towrite">написать мне</option>
            </select>
            <select value={pd} onChange={(e) => setPd(+e.target.value)}>
              <option value={1}>проверить завтра</option>
              <option value={3}>через 3 дня</option>
              <option value={7}>через неделю</option>
            </select>
          </div>
        </div>
      </div>

      {inboxOpen && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && setInboxOpen(false)}>
          <div className="md">
            <div className="md-h">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2b8a3e" strokeWidth="1.6">
                <path d="M3 12h4l2 4 4-10 2 6h6" />
              </svg>
              <div style={{ flex: 1 }}>
                <h3>Инбокс, {data.inbox.length} кандидатов</h3>
                <div className="src2">
                  Читаются только структурированные секции заметок. Расшифровки разговоров и файлы
                  dev-tasks не разбираются.
                </div>
              </div>
              <button className="x" onClick={() => setInboxOpen(false)}>
                ×
              </button>
            </div>
            <div className="md-b">
              {!data.inbox.length && (
                <div className="empty">
                  <b>Инбокс пуст</b>
                  Всё разобрано.
                </div>
              )}
              {data.inbox.map((c) => (
                <div className="cand" key={c.id}>
                  <div className="was">
                    <b>в заметке было</b>
                    {c.was}
                  </div>
                  <input
                    className="ttl-e"
                    value={c.now}
                    onChange={(e) => candPatch(c.id, (x) => (x.now = e.target.value))}
                  />
                  <div className="ctrls">
                    <select
                      value={c.type}
                      onChange={(e) => candPatch(c.id, (x) => (x.type = e.target.value as Task["type"]))}
                    >
                      {TYPES.map((t) => (
                        <option key={t.v} value={t.v}>
                          {t.l}
                        </option>
                      ))}
                    </select>
                    <select
                      value={c.project}
                      onChange={(e) => candPatch(c.id, (x) => (x.project = e.target.value))}
                    >
                      <option value="">без проекта</option>
                      {liveProjects.map((p) => (
                        <option key={p.id}>{p.name}</option>
                      ))}
                      {!data.projects.some((p) => p.name === c.project) && c.project && (
                        <option>{c.project}</option>
                      )}
                    </select>
                    <select
                      value={c.due}
                      onChange={(e) => candPatch(c.id, (x) => (x.due = e.target.value as Due))}
                    >
                      {DUES.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    <input
                      className="mlist"
                      list="all-lists"
                      value={c.milestone ?? ""}
                      onChange={(e) => candPatch(c.id, (x) => (x.milestone = e.target.value))}
                      placeholder="чеклист"
                    />
                    {c.assignee && <span className="chip who-chip">{c.assignee}</span>}
                    {c.flag && <span className="flag">{c.flag}</span>}
                    <span className="acts">
                      <button className="skip" onClick={() => skip(c.id)}>
                        Не надо
                      </button>
                      <button className="take" onClick={() => take(c.id)}>
                        Взять
                      </button>
                    </span>
                  </div>
                  <div className="was" style={{ marginTop: 8, marginBottom: 0 }}>
                    {c.source.file}, строка {c.source.line}
                  </div>
                </div>
              ))}
            </div>
            <div className="md-f">
              <span>
                {data.inbox.length ? `осталось разобрать: ${data.inbox.length}` : "разобрано всё"}
              </span>
              <input
                className="mlist"
                list="all-lists"
                value={bulkList}
                onChange={(e) => setBulkList(e.target.value)}
                placeholder="всё в чеклист"
                style={{ marginLeft: "auto" }}
              />
              <button
                className="btn"
                style={{ marginTop: 0 }}
                disabled={!data.inbox.length}
                onClick={() => {
                  const ids = data.inbox.map((c) => c.id);
                  if (bulkList.trim())
                    ids.forEach((id) => candPatch(id, (x) => (x.milestone = bulkList.trim())));
                  setTimeout(() => ids.forEach((id) => take(id)), 0);
                }}
              >
                Взять всё оставшееся
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
