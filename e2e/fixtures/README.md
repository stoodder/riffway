# e2e fixtures

Written by the Riffway authors for the Playwright suite (TASKS.md D2); not copied from any tab site.

| File | Used by |
|---|---|
| `paste-arpeggio.txt` | `import.spec.ts`: pasted on the Import screen, snapped to the grid, saved and played |

The suite also seeds its temp library with committed unit-test fixtures (`tests/fixtures/import/gp/riff.gp`,
`tests/fixtures/ascii/ug-style-riff.txt`) and drops `tests/fixtures/import/gp/capo.gp`; see `e2e/support/env.ts`.
