# ---- Build Stage ----
FROM node:22-bookworm-slim AS build

WORKDIR /workdir

COPY package.json package-lock.json ./

RUN apt-get update && apt-get install -y git python3 build-essential \
    && npm install \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# ---- Runtime Stage ----
FROM node:22-bookworm-slim AS runtime

WORKDIR /workdir

# Copy only built node_modules and app code
COPY --from=build /workdir/node_modules ./node_modules
COPY --from=build /workdir ./

EXPOSE 10412

CMD ["npm", "start"]