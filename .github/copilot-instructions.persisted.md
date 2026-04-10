# Copilot Custom Development Rules (Persisted)

## Ámbito
Estas reglas aplican a todo el repositorio para Angular/Ionic y TypeScript estricto.

## Angular/Ionic
- Comentarios siempre en inglés.
- Usa `inject()` para dependencias (nunca constructor).
- `standalone: true` y `ChangeDetectionStrategy.OnPush` obligatorios.
- Inyecciones `readonly`, orden: private → protected → public.
- Sintaxis: `private readonly service = inject(Service);`
- Reactividad: `signal()`, `computed()`, `selectSignal()`.
- Inputs: `input()` o `input.required<T>()` (nunca `@Input()`).
- Outputs: `output<T>()` (nunca `@Output()` o `EventEmitter`).
- SignalStore Pattern para NgRx, lógica en `withMethods`.
- Plantillas: `@if`, `@for`, `@switch` (nunca `*ngIf`, `*ngFor`, `*ngSwitch`).
- Prefiere `async/await` para HTTP, Observables solo para streams.
- Cleanup: `takeUntilDestroyed(this.destroyRef)`.
- Prefiere `delay()`/`interval()` sobre `setTimeout/setInterval`.
- Prohibido `any`.
- Usa enums/tipos estrictos para roles y entorno.
- No uses `console.log` excesivo, solo `// TODO:` o `// NOTE:`.
- No crear `.md` salvo que se pida explícitamente.

## TypeScript
- TypeScript estricto, sin `any`.
- Patrones: funcional, inyección de dependencias.
- Clean Code, SOLID.
- Interfaces PascalCase, métodos/variables camelCase, componentes `.component.ts`.
- Prefiere `async/await`.
- Métodos <20 líneas, una sola responsabilidad.
- Renombrar métodos: buscar referencias en Repo Map.
- Comentarios solo si el código no es autoexplicativo.
- Imports claros, relativos, nunca profundos, siempre al inicio.

## Ejemplo de prompt
- "Crea un componente Angular siguiendo las reglas de copilot-instructions.md"
- "Refactoriza este servicio para cumplir con las reglas de inyección y reactividad modernas"
- "Convierte este input/output a la nueva API de signals"

## Ambigüedades
- ¿Aplicar también a tests/scripts/tools?
- ¿Forzar estructura de carpetas o solo convención de archivos?
- ¿Excepciones para migraciones/legacy?
