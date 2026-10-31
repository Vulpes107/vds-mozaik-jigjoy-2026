FROM node:22-bookworm-slim AS build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY mocks /app/mocks
COPY contracts /app/contracts
COPY dashboard ./
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dashboard/dist /usr/share/nginx/html
EXPOSE 80
