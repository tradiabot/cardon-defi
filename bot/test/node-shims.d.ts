// El proyecto solo carga los tipos de Workers; las pruebas que corren en Node declaran lo poco que usan.
declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:module' {
  export function createRequire(path: string): (id: string) => unknown;
}
declare const process: { cwd(): string };
