FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY . .
ENV PORT=8080
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server/server.js"]
