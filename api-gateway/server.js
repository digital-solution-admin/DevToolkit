const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware } = require('http-proxy-middleware');
const winston = require('winston');
const Redis = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Redis client for caching
const redisClient = Redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3001'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET || 'dev-secret', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Authentication endpoints
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // In production, validate against database
    if (username === 'admin' && password === 'admin123') {
      const token = jwt.sign(
        { username, role: 'admin' },
        process.env.JWT_SECRET || 'dev-secret',
        { expiresIn: '24h' }
      );
      
      res.json({ token, user: { username, role: 'admin' } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Service proxy configurations
const services = {
  database: {
    target: 'http://localhost:5000',
    pathRewrite: { '^/api/database': '' }
  },
  generator: {
    target: 'http://localhost:8080',
    pathRewrite: { '^/api/generator': '' }
  },
  performance: {
    target: 'http://localhost:9000',
    pathRewrite: { '^/api/performance': '' }
  },
  automation: {
    target: 'http://localhost:7000',
    pathRewrite: { '^/api/automation': '' }
  }
};

// Setup proxies for each service
Object.keys(services).forEach(service => {
  const config = services[service];
  app.use(`/api/${service}`, authenticateToken, createProxyMiddleware({
    target: config.target,
    changeOrigin: true,
    pathRewrite: config.pathRewrite,
    onError: (err, req, res) => {
      logger.error(`Proxy error for ${service}:`, err);
      res.status(503).json({ error: `Service ${service} unavailable` });
    },
    onProxyRes: (proxyRes, req, res) => {
      logger.info(`Proxy response from ${service}: ${proxyRes.statusCode}`);
    }
  }));
});

// API Documentation endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    title: 'Developer Toolkit API Gateway',
    version: '1.0.0',
    description: 'Centralized API gateway for development tools',
    endpoints: {
      '/health': 'GET - System health check',
      '/auth/login': 'POST - User authentication',
      '/api/database/*': 'ALL - Database management service',
      '/api/generator/*': 'ALL - Code generation service',
      '/api/performance/*': 'ALL - Performance monitoring service',
      '/api/automation/*': 'ALL - Task automation service'
    },
    authentication: 'Bearer Token (JWT)',
    rateLimit: '100 requests per 15 minutes per IP'
  });
});

// Websocket support for real-time updates
const http = require('http');
const socketIo = require('socket.io');

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3001'],
    methods: ['GET', 'POST']
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  logger.info(`User ${socket.user.username} connected`);
  
  socket.on('subscribe', (room) => {
    socket.join(room);
    logger.info(`User ${socket.user.username} subscribed to ${room}`);
  });
  
  socket.on('disconnect', () => {
    logger.info(`User ${socket.user.username} disconnected`);
  });
});

// Broadcast system events
const broadcastEvent = (event, data) => {
  io.emit(event, {
    timestamp: new Date().toISOString(),
    data
  });
};

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    requestId: req.id
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`API docs: http://localhost:${PORT}/api/docs`);
});

module.exports = { app, server, broadcastEvent };
