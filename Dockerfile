FROM node:22-alpine
WORKDIR /app
COPY server.js knowledge.md ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
