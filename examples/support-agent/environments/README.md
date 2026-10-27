# Environments

Every trial starts from a clean copy of `seed.sqlite`. Two ways to get one:

- **In process** (default): `freshDb(trialDir)` in `src/db.ts` copies the seed into the trial's directory and opens it. Nothing is shared between trials, and the file is deleted with the trial directory.
- **Harbor** (decision #2, untested): `harbor/` is a Harbor task for the same agent, so the containerized runner can be evaluated on a real example. It builds a container with Node and this directory, resets the database on start, runs the agent against the task's input, and the test reads the end state through the same `snapshot()` the in-process runner uses.

Regenerate the seed with `npm run seed-db` after changing `src/catalog.ts`.
