// An agent that starts a grandchild and hangs: the runner's timeout must kill both.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const child = spawn("sleep", ["60"], { stdio: "inherit" });
writeFileSync(join(process.env.FORKER_OUT, "grandchild.pid"), String(child.pid));
setInterval(() => {}, 1000);
