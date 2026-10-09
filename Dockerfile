FROM node:20-slim

WORKDIR /app

# better-sqlite3 是 optionalDependency，需要编译工具；用 memory 存储可不装。
# 如需 sqlite 持久化，取消下面一行注释。
# RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-optional

COPY . .

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
