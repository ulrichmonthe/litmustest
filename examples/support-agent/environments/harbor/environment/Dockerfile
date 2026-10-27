FROM node:22-slim
WORKDIR /app
COPY . /app
RUN npm install --omit=dev --no-audit --no-fund
# a clean database for this container; the trial copies it again, so a retry inside the container is also clean
RUN node src/db.ts seed
ENV ANTHROPIC_API_KEY=""
