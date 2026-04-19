# NgpCraft Live Editor — tests

Fixture-based regression tests for the C → JS transpiler in `js/interpreter.js`.

## Run

```bash
cd NgpCraft_live_editor
node --test tests/
```

Requires Node 20+ (for `node:test` built-in). No external dependencies.

## Adding a fixture

Open `transpile.test.mjs`, add an entry to the `fixtures` array:

```js
{
  name: "short description",
  c: "void main(void) { /* C source */ }",
  expectJs: ["substring that MUST be in transpiled JS"],
  notExpectJs: ["substring that must NOT appear"],
  shouldCompile: true,           // default true; false = lint expected to fire
  expectErrorRule: "HW-3b",      // optional: assert specific lint rule
}
```

For runtime tests (memory state, framebuffer, generator behaviour), use the
`runFramesAssert` form instead — see existing entries.

## Coverage focus

- Smoke transpile (empty main, hello-world)
- Register access rewrites (R8/R16/W8/W16)
- Vsync → yield + main → generator
- Comment stripping
- Enum → const lines
- Pointer rewrites
- Each lint rule: positive case (must fire) + negative case (must not)
- Real-world flagship examples (StarGunner mini patterns) — false-positive guards

## Why fixtures + node --test

- No external test framework dependency.
- Fast (<1s for the whole suite).
- Each fixture is one assertion that captures intent.
- A regression in any rewrite step turns into a failing fixture immediately.
- New behaviour = new fixture, not a debugger session.

## Complementary to validate_transpile.py

`validate_transpile.py` (project root) is an offline Python re-implementation
that cross-checks transpiler structure. These fixtures test the actual JS
implementation with structured assertions — they catch *behaviour* regressions
where the Python re-impl tests *shape* regressions. Use both.
