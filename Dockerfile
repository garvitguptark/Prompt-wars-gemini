# Small production image for Cloud Run: production dependencies only, running as the unprivileged "node" user.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
