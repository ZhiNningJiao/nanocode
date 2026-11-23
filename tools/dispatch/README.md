# tools/dispatch — 派车表

One JSON form per car → checked → task book generated → the existing
dispatch script launched with the right environment → one summary line.

```
node tools/dispatch/dispatch.mjs <form.json> --dry-run [--preview-dir <dir>]   # check + show, nothing written
node tools/dispatch/dispatch.mjs <form.json>                                   # really dispatch (configured host only)
node tools/dispatch/dispatch.mjs steer <tag> <message-file> [--dry-run]
node tools/dispatch/backfill-issue-map.mjs [--write [--include-inferred]]      # one-off: old cars → issues
```

| file | does |
|---|---|
| `form.mjs` | form fields, defaults, shape checks (field reference in its header) |
| `plan.mjs` | every refusal check (paths, tag reuse, tracker lineage, pool, key-shaped text) → plan |
| `pool-pick.mjs` | pool rules (weekly reset soonest first, caps, overage, heavy cars) |
| `taskbook.mjs` + `taskbook.template.md` | task book rendering; fixed sections live in the template |
| `execute.mjs` | the real dispatch sequence (issue → workdir → book → guard list → script) |
| `linear-create.mjs` | the only tracker write: child issue under the line's parent |
| `backfill-issue-map.mjs` | one-off backfill of the tag↔issue map, listing what it can't fill and why |

Config: `config/dispatch.local.json` (gitignored; shape in `config/dispatch.example.json`).
The tracker root, quota readings and cars export are read from the
command-center config — one source for the board and the dispatcher.
Parent chains come from `server/linear-lineage.js`, the same module the
board uses to file cars.

Replaces: the hand-typed dispatch command line and the hand-copied red-line
section. The dispatch script itself stays the one launcher.
