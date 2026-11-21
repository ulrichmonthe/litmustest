# An image for the docker and harbor environments (runs.environment in evals/litmustest.yaml).
# Build from this example's directory:  docker build -f environments/Dockerfile -t support-agent:latest .
# Not built or run where this was written: docker is not installed there. See environments/README.md.
FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json prompt.md ./
# the trial script needs the Anthropic SDK and yaml (it parses the task file)
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY environments ./environments
# the trial script finds the task by id under evals/tasks; under docker the same files are also mounted at /evals
COPY evals/tasks ./evals/tasks
# a clean golden database baked into the image; every trial copies it into its own trial directory
RUN node src/db.ts seed
