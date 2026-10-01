FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

# Игра + API должны быть в образе
COPY server.js index.html ./

ENV DATA_DIR=/data
ENV PORT=80

EXPOSE 80

CMD ["node", "server.js"]
