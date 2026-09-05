FROM node:22.23.1-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server/*.js ./
COPY public/index.html public/viewer.js public/styles.css public/webrtc.js /app/public/
COPY public/vendor /app/public/vendor
USER node
CMD ["node", "main.js"]
