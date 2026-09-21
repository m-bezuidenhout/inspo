# Small, boring, and the same locally as in production.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a code change doesn't reinstall them every build.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The hosted backend keeps images in Supabase, so this container holds no state
# and can be thrown away and recreated at any time.
CMD ["node", "server.js"]
