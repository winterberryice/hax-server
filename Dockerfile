# Use a recent Node.js LTS version
FROM node:20-bookworm

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
# This leverages Docker's build cache.
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# The command to run when the container starts
CMD [ "npm", "run", "start" ]
