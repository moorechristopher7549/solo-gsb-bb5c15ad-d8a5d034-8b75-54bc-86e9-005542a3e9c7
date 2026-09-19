FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依赖安装纳入镜像构建，启动即可用
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
