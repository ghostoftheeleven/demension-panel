/**
 * Переменная окружения панели: DEMENTIA_<имя>, а если её нет — прежнее имя DEMENSION_<имя> (проект назывался
 * Demension до v0.1.4; в server/.env уже работающих панелей могут остаться старые имена).
 */
export function panelEnv(name: string): string | undefined {
  return process.env[`DEMENTIA_${name}`] ?? process.env[`DEMENSION_${name}`];
}
