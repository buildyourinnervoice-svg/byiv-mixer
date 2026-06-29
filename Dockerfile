
FROM node:18-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
