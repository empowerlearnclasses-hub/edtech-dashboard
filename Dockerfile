# Node 22+ is required — @supabase/supabase-js needs native WebSocket support that only
# exists from Node 22 onward, even though this app only uses Supabase for Storage (not
# realtime) — the client library initializes its realtime connection internally regardless.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=4500
EXPOSE 4500

CMD ["node", "server.js"]