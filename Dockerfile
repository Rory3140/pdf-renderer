FROM ghcr.io/puppeteer/puppeteer:23.10.1

USER root
WORKDIR /app
RUN chown pptruser:pptruser /app

USER pptruser

COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --production

COPY --chown=pptruser:pptruser . .

EXPOSE 8080

CMD ["node", "server.js"]
