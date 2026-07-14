# Node + this app's dependencies (pg, exceljs, pdfkit, etc.) — no native compiler needed.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=4500
EXPOSE 4500

CMD ["node", "server.js"]
