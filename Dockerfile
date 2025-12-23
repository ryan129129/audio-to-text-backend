# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install system dependencies
# - dumb-init: proper signal handling
# - ffmpeg: audio processing for yt-dlp
# - python3: required by yt-dlp
# - yt-dlp: YouTube downloader (use latest version)
RUN apk add --no-cache dumb-init ffmpeg python3 py3-pip && \
    pip3 install --break-system-packages --upgrade yt-dlp

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 -G nodejs

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create tmp directory for YouTube downloads and set permissions
RUN mkdir -p /tmp/youtube && chmod 777 /tmp/youtube && chown -R nestjs:nodejs /app

USER nestjs

# Cloud Run uses PORT environment variable
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Use dumb-init as entrypoint for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/main.js"]
