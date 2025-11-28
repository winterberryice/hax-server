# Use Node.js 24 (Debian-based for better ARM64 support and prebuilt binaries)
FROM node:24-slim

# Set the working directory inside the container
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
# ARM64 binaries are not available, so we need to compile from source
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json (if available)
# This leverages Docker's build cache.
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Create data directory for SQLite database
RUN mkdir -p /app/data

# The command to run when the container starts
CMD [ "npm", "run", "start" ]
