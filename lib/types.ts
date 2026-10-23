export type Level = "critical" | "high" | "medium" | "low";
/** Приоритет задачи или пинга. Три ступени, чтобы переключать одним кликом. */
export type Prio = "high" | "medium" | "low";
export type Due = "просрочено" | "сегодня" | "завтра" | "на неделе" | "без срока";
export type TaskType = "task" | "ping" | "meeting";

export interface Source {
  file: string;
  line: number;
  raw: string;
}

export interface Project {
  id: string;
  name: string;
  level: Level;
  /** Устарело: шаги теперь это задачи с признаком isStep. Поле оставлено для старых файлов. */
  steps?: string[];
  /** названия чеклистов проекта. Чеклист может быть пустым, это нормально */
  lists?: string[];
  archived?: boolean;
}

export interface Task {
  id: string;
  title: string;
  project?: string;
  due: Due;
  type: TaskType;
  done?: boolean;
  doneAt?: string;
  manual?: boolean;
  /** взята в список на сегодня, независимо от срока */
  today?: boolean;
  /** когда её взяли в день. Нужно, чтобы показывать «висит третий день» */
  todaySince?: string;
  /** дата в формате ГГГГ-ММ-ДД: до неё задача не показывается в дне, с неё появляется */
  plannedFor?: string;
  /** помечена как следующий шаг по проекту, видна в боковой панели */
  isStep?: boolean;
  /** работа стоит и не зависит от Марии: ждём чужого решения или доступа */
  blocked?: boolean;
  parent?: string | null;
  /** кто делает. Пусто значит владелец трекера */
  assignee?: string;
  /** чеклист внутри проекта, например «Запуск Hold» */
  milestone?: string;
  priority?: Prio;
  /** номер, проставленный руками. Ни на что не влияет, просто виден */
  rank?: number;
  /** имя человека, после ответа которого появилась эта задача */
  fromPing?: string;
  source?: Source | null;
  createdAt: string;
}

export interface Ping {
  id: string;
  who: string;
  what: string;
  project?: string;
  priority?: Prio;
  kind: "waiting" | "towrite";
  askedAt: string;
  check: number;
  done?: boolean;
  doneAt?: string;
}

export interface Candidate {
  id: string;
  was: string;
  now: string;
  assignee?: string;
  /** чеклист, в который задача уедет при переносе */
  milestone?: string;
  type: TaskType;
  project: string;
  due: Due;
  flag?: string;
  source: Source;
}

export interface TrackerData {
  projects: Project[];
  tasks: Task[];
  pings: Ping[];
  inbox: Candidate[];
  seenRaw: string[];
  lastScan?: string;
  /** имя владельца, показывается внизу боковой панели */
  owner?: string;
  /** как владелец называет себя в протоколах: такие пункты не уходят на коллегу */
  ownerNames?: string[];
  /** имя папки в рабочем каталоге -> название проекта в трекере */
  projectAliases?: Record<string, string>;
  /** Версия файла. Растёт при каждой записи, защищает от затирания чужих правок. */
  rev?: number;
}
