# Copilot Custom Development Rules - Angular/Ionic

## Core Principles

- Always use English for comments.
- Use `inject()` for Dependency Injection (Never constructor).
- Mandatory `standalone: true` and `ChangeDetectionStrategy.OnPush`.

## 1. Dependency Injection & Access Modifiers

- Always `readonly` for injections.
- Order: private → protected → public.
- Format: `private readonly service = inject(Service);`

## 2. Signals & Modern Reactivity

- Use `signal()`, `computed()`, and `selectSignal()`.
- Inputs: Use `input()` or `input.required<T>()`. **Never @Input()**.
- Outputs: Use `output<T>()`. **Never @Output() or EventEmitter**.

## 3. SignalStore Pattern (NgRx)

- Order: `withDevtools` → `withState` → `withEntities` → `withComputed` → `withMethods`.
- Business logic MUST live in `withMethods`.

## 4. Modern Template Syntax

- Use `@if`, `@for` (with `track`), and `@switch`.
- **Never use *ngIf, *ngFor or \*ngSwitch**.

## 5. Async & RxJS

- Use `async/await` for one-off HTTP calls.
- Use Observables ONLY for streams.
- Always use `takeUntilDestroyed(this.destroyRef)` for cleanup.
- Prefer `delay()` and `interval()` over `setTimeout/setInterval`.

## 6. Type Safety

- Strictly NO `any`.
- Use `SdAccessibilityTags` enum for all HTML roles.
- Use `ClientNames` for environment detection.

## 7. Logging & Documentation

- No excessive `console.log`.
- Only `// TODO:` or `// NOTE:`.
- Do not create `.md` files unless explicitly asked.

# Copilot Custom Development Rules - TypeScript

## Tech Stack Preferences

- **Language**: TypeScript estricto. Evitar el uso de `any`.
- **Patterns**: Programación funcional, Inyección de Dependencias
- **Style**: Clean Code y principios SOLID.

## Coding Rules

- **Naming**:
  - Interfaces con PascalCase (ej: `UserEntry`).
  - Métodos y variables en camelCase.
  - Componentes con el sufijo `.component.ts`.
- **Async**: Preferir `async/await` sobre Promises crudas.
- **Functions**: Métodos pequeños (menos de 20 líneas). Una sola responsabilidad por función.
- **Refactoring**: Al renombrar métodos, buscar siempre las referencias en el "Repo Map" para asegurar cambios atómicos.
- **Comentarios**: Solo cuando el código no es autoexplicativo. Evitar comentarios redundantes.
- **Imports: **Usar rutas relativas claras. Evitar imports profundos (ej: `import { X } from '../../../../../'`). Solo usar imports al principio del archivo.
