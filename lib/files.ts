import path from "path";

/** Вложения лежат рядом с данными и, как и данные, не уезжают в git. */
export const FILES_DIR = path.join(process.cwd(), "data", "files");

/**
 * Имя файла на диске приходит из адреса, поэтому пускаем только то, что
 * выдали сами при загрузке: без слешей и точек в начале, иначе можно
 * выйти из папки и прочитать что угодно.
 */
export function safeId(id: string) {
  return /^[a-z0-9]+-[\w.\-а-яё ]+$/i.test(id) && !id.includes("..") ? id : null;
}
