FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

ENV NODE_ENV=production
# Railway injects env at runtime; dotenv is a no-op when variables already exist.
CMD ["node", "-r", "dotenv/config", "server.js"]
