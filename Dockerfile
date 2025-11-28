# Use Node.js 24
FROM node:24-alpine

# Set the working directory inside the container
WORKDIR /app

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
