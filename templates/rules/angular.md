<!-- Installed by `/rules install angular`. This file is YOURS: edit it, version it with the
     project, delete what does not apply. REI reads <workspace>/.rei/rules.md and injects it into
     every coding turn — so keep it short, and keep it about THIS repo. -->

### Angular Project Rules (mandatory — violations are bugs):
- Control flow: use `@if`, `@for (item of list; track item.id)`, `@switch`. NEVER use *ngIf, *ngFor, *ngSwitch.
- Components: always `standalone: true` and `ChangeDetectionStrategy.OnPush`.
- Inputs: use `input()` or `input.required<T>()`. NEVER use the `@Input()` decorator.
- Outputs: use `output<T>()`. NEVER use `@Output()` or `EventEmitter`.
- Reactivity: use `signal()`, `computed()`, `effect()` from `@angular/core`.
- Dependency injection: use `inject()`. NEVER use constructor parameter injection.
- Async: `async/await` for one-off HTTP calls. Observables only for streams.
- Strict types: no `any`. Use TypeScript strict mode.
- Atomicity (planning): a component (class + template + styles) is ONE atomic unit — never split its
  files across separate stages. An orphan `.html`/`.scss` without its `.ts` gives a false-green
  `ngc` check, because the template is only type-validated once the component class references it.
