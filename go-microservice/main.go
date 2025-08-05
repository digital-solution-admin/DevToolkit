package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// ServiceRegistry manages microservice instances
type ServiceRegistry struct {
	services map[string]*ServiceInstance
	mutex    sync.RWMutex
	logger   *zap.Logger
}

type ServiceInstance struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Address  string    `json:"address"`
	Port     int       `json:"port"`
	Status   string    `json:"status"`
	LastSeen time.Time `json:"last_seen"`
	Metadata map[string]interface{} `json:"metadata"`
}

type LoadBalancer struct {
	services map[string][]*ServiceInstance
	current  map[string]int
	mutex    sync.RWMutex
	strategy string // round-robin, least-connections, random
}

type APIGateway struct {
	registry     *ServiceRegistry
	loadBalancer *LoadBalancer
	logger       *zap.Logger
	upgrader     websocket.Upgrader
	connections  map[string]*websocket.Conn
	connMutex    sync.RWMutex
	metrics      *Metrics
}

type Metrics struct {
	requestsTotal     prometheus.Counter
	requestDuration   prometheus.Histogram
	activeConnections prometheus.Gauge
	serviceHealth     *prometheus.GaugeVec
}

type HealthCheck struct {
	Status    string            `json:"status"`
	Timestamp time.Time         `json:"timestamp"`
	Services  map[string]string `json:"services"`
	Uptime    string            `json:"uptime"`
	Version   string            `json:"version"`
	Memory    MemoryInfo        `json:"memory"`
}

type MemoryInfo struct {
	Alloc      uint64 `json:"alloc"`
	TotalAlloc uint64 `json:"total_alloc"`
	Sys        uint64 `json:"sys"`
	NumGC      uint32 `json:"num_gc"`
}

var startTime = time.Now()

func NewServiceRegistry(logger *zap.Logger) *ServiceRegistry {
	return &ServiceRegistry{
		services: make(map[string]*ServiceInstance),
		logger:   logger,
	}
}

func NewLoadBalancer() *LoadBalancer {
	return &LoadBalancer{
		services: make(map[string][]*ServiceInstance),
		current:  make(map[string]int),
		strategy: "round-robin",
	}
}

func NewMetrics() *Metrics {
	return &Metrics{
		requestsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests",
		}),
		requestDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "http_request_duration_seconds",
			Help: "HTTP request duration in seconds",
		}),
		activeConnections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "websocket_connections_active",
			Help: "Number of active WebSocket connections",
		}),
		serviceHealth: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "service_health_status",
			Help: "Health status of registered services",
		}, []string{"service_name"}),
	}
}

func (m *Metrics) Register() {
	prometheus.MustRegister(m.requestsTotal)
	prometheus.MustRegister(m.requestDuration)
	prometheus.MustRegister(m.activeConnections)
	prometheus.MustRegister(m.serviceHealth)
}

func NewAPIGateway(logger *zap.Logger) *APIGateway {
	metrics := NewMetrics()
	metrics.Register()

	return &APIGateway{
		registry:     NewServiceRegistry(logger),
		loadBalancer: NewLoadBalancer(),
		logger:       logger,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins in development
			},
		},
		connections: make(map[string]*websocket.Conn),
		metrics:     metrics,
	}
}

// Service Discovery and Registration
func (sr *ServiceRegistry) RegisterService(service *ServiceInstance) error {
	sr.mutex.Lock()
	defer sr.mutex.Unlock()

	service.LastSeen = time.Now()
	service.Status = "healthy"
	sr.services[service.ID] = service

	sr.logger.Info("Service registered",
		zap.String("id", service.ID),
		zap.String("name", service.Name),
		zap.String("address", service.Address),
		zap.Int("port", service.Port))

	return nil
}

func (sr *ServiceRegistry) DeregisterService(serviceID string) error {
	sr.mutex.Lock()
	defer sr.mutex.Unlock()

	if service, exists := sr.services[serviceID]; exists {
		delete(sr.services, serviceID)
		sr.logger.Info("Service deregistered",
			zap.String("id", serviceID),
			zap.String("name", service.Name))
	}

	return nil
}

func (sr *ServiceRegistry) GetServices() map[string]*ServiceInstance {
	sr.mutex.RLock()
	defer sr.mutex.RUnlock()

	services := make(map[string]*ServiceInstance)
	for k, v := range sr.services {
		services[k] = v
	}
	return services
}

func (sr *ServiceRegistry) HealthCheck() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			sr.checkServiceHealth()
		}
	}
}

func (sr *ServiceRegistry) checkServiceHealth() {
	sr.mutex.Lock()
	defer sr.mutex.Unlock()

	for id, service := range sr.services {
		// Simple HTTP health check
		client := &http.Client{Timeout: 5 * time.Second}
		healthURL := fmt.Sprintf("http://%s:%d/health", service.Address, service.Port)
		
		resp, err := client.Get(healthURL)
		if err != nil || resp.StatusCode != http.StatusOK {
			service.Status = "unhealthy"
			sr.logger.Warn("Service health check failed",
				zap.String("id", id),
				zap.String("name", service.Name),
				zap.Error(err))
		} else {
			service.Status = "healthy"
			service.LastSeen = time.Now()
		}
		
		if resp != nil {
			resp.Body.Close()
		}
	}
}

// Load Balancing
func (lb *LoadBalancer) AddService(serviceName string, instance *ServiceInstance) {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	if lb.services[serviceName] == nil {
		lb.services[serviceName] = make([]*ServiceInstance, 0)
		lb.current[serviceName] = 0
	}

	lb.services[serviceName] = append(lb.services[serviceName], instance)
}

func (lb *LoadBalancer) GetNextService(serviceName string) *ServiceInstance {
	lb.mutex.Lock()
	defer lb.mutex.Unlock()

	instances := lb.services[serviceName]
	if len(instances) == 0 {
		return nil
	}

	switch lb.strategy {
	case "round-robin":
		current := lb.current[serviceName]
		service := instances[current]
		lb.current[serviceName] = (current + 1) % len(instances)
		return service
	default:
		return instances[0]
	}
}

// HTTP Handlers
func (gw *APIGateway) healthHandler(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	health := HealthCheck{
		Status:    "healthy",
		Timestamp: time.Now(),
		Services:  make(map[string]string),
		Uptime:    time.Since(startTime).String(),
		Version:   "1.0.0",
		Memory: MemoryInfo{
			Alloc:      m.Alloc,
			TotalAlloc: m.TotalAlloc,
			Sys:        m.Sys,
			NumGC:      m.NumGC,
		},
	}

	// Add service health status
	for id, service := range gw.registry.GetServices() {
		health.Services[service.Name] = service.Status
		
		// Update Prometheus metrics
		if service.Status == "healthy" {
			gw.metrics.serviceHealth.WithLabelValues(service.Name).Set(1)
		} else {
			gw.metrics.serviceHealth.WithLabelValues(service.Name).Set(0)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

func (gw *APIGateway) registerServiceHandler(w http.ResponseWriter, r *http.Request) {
	var service ServiceInstance
	if err := json.NewDecoder(r.Body).Decode(&service); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Generate ID if not provided
	if service.ID == "" {
		service.ID = fmt.Sprintf("%s-%d", service.Name, time.Now().Unix())
	}

	if err := gw.registry.RegisterService(&service); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Add to load balancer
	gw.loadBalancer.AddService(service.Name, &service)

	response := map[string]interface{}{
		"success":    true,
		"service_id": service.ID,
		"message":    "Service registered successfully",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (gw *APIGateway) servicesHandler(w http.ResponseWriter, r *http.Request) {
	services := gw.registry.GetServices()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(services)
}

func (gw *APIGateway) proxyHandler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	gw.metrics.requestsTotal.Inc()

	vars := mux.Vars(r)
	serviceName := vars["service"]

	// Get service instance from load balancer
	instance := gw.loadBalancer.GetNextService(serviceName)
	if instance == nil {
		http.Error(w, "Service not available", http.StatusServiceUnavailable)
		return
	}

	// Create proxy request
	targetURL := fmt.Sprintf("http://%s:%d%s", instance.Address, instance.Port, r.URL.Path)
	
	client := &http.Client{Timeout: 30 * time.Second}
	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, "Failed to create proxy request", http.StatusInternalServerError)
		return
	}

	// Copy headers
	for key, values := range r.Header {
		for _, value := range values {
			proxyReq.Header.Add(key, value)
		}
	}

	// Execute request
	resp, err := client.Do(proxyReq)
	if err != nil {
		gw.logger.Error("Proxy request failed",
			zap.String("service", serviceName),
			zap.String("target", targetURL),
			zap.Error(err))
		http.Error(w, "Service request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	// Copy status code and body
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)

	// Record metrics
	gw.metrics.requestDuration.Observe(time.Since(start).Seconds())
}

func (gw *APIGateway) websocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := gw.upgrader.Upgrade(w, r, nil)
	if err != nil {
		gw.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}
	defer conn.Close()

	clientID := fmt.Sprintf("client-%d", time.Now().UnixNano())
	
	gw.connMutex.Lock()
	gw.connections[clientID] = conn
	gw.metrics.activeConnections.Inc()
	gw.connMutex.Unlock()

	defer func() {
		gw.connMutex.Lock()
		delete(gw.connections, clientID)
		gw.metrics.activeConnections.Dec()
		gw.connMutex.Unlock()
	}()

	gw.logger.Info("WebSocket client connected", zap.String("client_id", clientID))

	// Send initial service list
	services := gw.registry.GetServices()
	message := map[string]interface{}{
		"type":     "service_list",
		"services": services,
	}
	conn.WriteJSON(message)

	// Handle incoming messages
	for {
		var msg map[string]interface{}
		if err := conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				gw.logger.Error("WebSocket error", zap.Error(err))
			}
			break
		}

		// Handle different message types
		switch msg["type"] {
		case "ping":
			conn.WriteJSON(map[string]interface{}{
				"type":      "pong",
				"timestamp": time.Now(),
			})
		case "get_services":
			services := gw.registry.GetServices()
			conn.WriteJSON(map[string]interface{}{
				"type":     "service_list",
				"services": services,
			})
		}
	}
}

func (gw *APIGateway) broadcastServiceUpdate() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			services := gw.registry.GetServices()
			message := map[string]interface{}{
				"type":      "service_update",
				"services":  services,
				"timestamp": time.Now(),
			}

			gw.connMutex.RLock()
			for clientID, conn := range gw.connections {
				if err := conn.WriteJSON(message); err != nil {
					gw.logger.Warn("Failed to send message to client",
						zap.String("client_id", clientID),
						zap.Error(err))
				}
			}
			gw.connMutex.RUnlock()
		}
	}
}

// Middleware
func (gw *APIGateway) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		next.ServeHTTP(w, r)
		
		gw.logger.Info("HTTP Request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("remote_addr", r.RemoteAddr),
			zap.Duration("duration", time.Since(start)))
	})
}

func (gw *APIGateway) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func main() {
	// Initialize logger
	logger, err := zap.NewProduction()
	if err != nil {
		log.Fatal("Failed to initialize logger:", err)
	}
	defer logger.Sync()

	// Create API Gateway
	gateway := NewAPIGateway(logger)

	// Start background services
	go gateway.registry.HealthCheck()
	go gateway.broadcastServiceUpdate()

	// Setup routes
	r := mux.NewRouter()

	// Apply middleware
	r.Use(gateway.loggingMiddleware)
	r.Use(gateway.corsMiddleware)

	// API routes
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/health", gateway.healthHandler).Methods("GET")
	api.HandleFunc("/services", gateway.servicesHandler).Methods("GET")
	api.HandleFunc("/services", gateway.registerServiceHandler).Methods("POST")
	api.HandleFunc("/proxy/{service:.*}", gateway.proxyHandler)

	// WebSocket endpoint
	r.HandleFunc("/ws", gateway.websocketHandler)

	// Metrics endpoint
	r.Handle("/metrics", promhttp.Handler())

	// Static file serving for dashboard
	r.PathPrefix("/").Handler(http.FileServer(http.Dir("./static/")))

	// Get port from environment or use default
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		logger.Info("Starting Go Microservice Gateway", zap.String("port", port))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("Server failed to start", zap.Error(err))
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Fatal("Server forced to shutdown", zap.Error(err))
	}

	logger.Info("Server exited")
}
