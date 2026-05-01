FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV GEMINI_API_KEY=""

COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
