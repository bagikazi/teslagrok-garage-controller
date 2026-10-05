FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY web/package.json web/package.json
COPY server/api/package.json server/api/package.json
COPY tools/mock-device/package.json tools/mock-device/package.json
RUN npm ci
COPY packages/shared-types packages/shared-types
COPY web web
RUN npm run build --workspace @garage-control/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared-types /app/packages/shared-types
COPY --from=build /app/web/package.json /app/web/package.json
COPY --from=build /app/web/.next /app/web/.next
COPY --from=build /app/web/public /app/web/public
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["npm", "--workspace", "@garage-control/web", "run", "start"]
