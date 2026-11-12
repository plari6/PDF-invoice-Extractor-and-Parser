FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY examples/scanned-facture-FA-2026-1187.pdf ./examples/
COPY .env.example ./
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
# API by default; override for batch jobs:
#   docker run --rm -v "$PWD/inbox:/data" -e GEMINI_API_KEY=... image node bin/invoice-extractor.js extract /data -o /data/output
CMD ["node", "bin/invoice-extractor.js", "serve"]
