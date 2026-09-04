# Reproduction tests filed by the tester

One file per defect, named after it: `DEF-0041.test.ts` pins `docs/defects/DEF-0041.md`. The
tester writes them; the developer makes them pass. They run with the rest of the suite
(`npm run test` collects everything under `src/test/`), so the suite count moves by the number
of `it(` blocks in the file — say so in the defect file and in the session entry.

Rules:

- A pin asserts the **requirement's** behaviour, not the code's current shape — it is red on the
  defective build and green on the fixed one, and it must be able to go red again.
- Keep it self-contained: real modules from `@/…`, no mocks of the thing under test, a fixture
  that can break the specific clause (the fixture must contain the case the requirement exists
  for — a suite where every row is one kind cannot tell "reads the field" from "ignores it").
- Once the defect is `verified`, the developer may **promote** the case into the proper test
  file beside the code and delete it here, in the same commit — never leave two copies.
- Never edit another file under `src/test/` from the tester role. The developer owns those.
