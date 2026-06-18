---
name: angular-component-refactor
description: Consolidate near-duplicate Angular components into one generic component wired by route data
modes: agent
---

# Skill: Consolidate duplicated Angular components

Use when several components are near-identical and differ only by a "type"/dataset.

Steps:

1. **Read all the duplicate components** (`.ts` + `.html` + `.scss`) with `read_files`. Confirm they
   share the same structure and differ only by a variant (e.g. stocks/crypto/cedear).
2. **Create the generic component** with `create_file` (e.g. `market-page/`). Give it a required
   signal input for the variant: `type = input.required<'stocks' | 'crypto' | 'cedear'>()`, and drive
   its data/template off `this.type()` (use `computed()` for derived data, `@if/@switch` in the html).
3. **Enable route → input binding** in `app.config.ts`: import `withComponentInputBinding` from
   `@angular/router` and pass it: `provideRouter(routes, withComponentInputBinding())`.
4. **Update the routes** so each path loads the generic component AND passes the variant via `data`:
   `{ path: 'stocks', data: { type: 'stocks' }, loadComponent: () => import('.../market-page...') }`.
   The `data.type` binds to the `type` input automatically.
5. **Verify** with `run_command`: `npx ng build` (or the project's verify command). Fix any errors.
6. **Delete the now-orphaned old components** ONLY after confirming nothing imports them
   (`grep -rn "StocksComponent\|CryptoComponent" src/`). Delete individual files; `rm -rf` is blocked.
7. Confirm the build still passes after deletion.
