FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

ENV DATA_DIR=/data
ENV PORT=80

EXPOSE 80

CMD ["node", "server.js"]
