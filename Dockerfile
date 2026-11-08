FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# CPU inference is enough; skip optional CUDA downloads.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

RUN npm run build

CMD ["node", "dist/server.js"]
