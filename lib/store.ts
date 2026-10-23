import { promises as fs } from "fs";
import path from "path";
import type { TrackerData } from "./types";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "tracker.json");

export const empty: TrackerData = {
  projects: [],
  tasks: [],
  pings: [],
  inbox: [],
  seenRaw: [],
};

export async function readData(): Promise<TrackerData> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return { ...empty, ...(JSON.parse(raw) as TrackerData) };
  } catch {
    return empty;
  }
}

export async function writeData(data: TrackerData): Promise<number> {
  await fs.mkdir(DIR, { recursive: true });
  // бэкап предыдущей версии, чтобы правка никогда не стоила данных
  try {
    const prev = await fs.readFile(FILE, "utf8");
    await fs.writeFile(FILE + ".bak", prev, "utf8");
  } catch {
    /* первого файла ещё нет */
  }
  const rev = (data.rev ?? 0) + 1;
  await fs.writeFile(FILE, JSON.stringify({ ...data, rev }, null, 2), "utf8");
  return rev;
}
