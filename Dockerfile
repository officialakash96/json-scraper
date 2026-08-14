# Chromium and its system libraries are preinstalled in this image.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY server.js ./

# Free tiers are memory constrained, so keep one page at a time.
ENV HJP_BROWSER_CONCURRENCY=1
ENV PORT=3000
EXPOSE 3000

USER pwuser
CMD ["node", "server.js"]
