package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const PORT = "8082"
const FLASK_API = "127.0.0.1:5001"

var (
	users  []gin.H
	nextID = 1
	mu     sync.Mutex
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"name":      "Fere Test Go Server",
			"version":   "1.0.0",
			"framework": "gin",
			"endpoints": []string{
				"GET /",
				"GET /health",
				"GET /api/users",
				"POST /api/users",
				"GET /api/users/:id",
				"PUT /api/users/:id",
				"DELETE /api/users/:id",
			},
		})
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":    "healthy",
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"pid":       os.Getpid(),
		})
	})

	r.GET("/api/users", func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"users": users, "total": len(users)})
	})

	r.POST("/api/users", func(c *gin.Context) {
		var body map[string]interface{}
		if err := c.ShouldBindJSON(&body); err != nil {
			body = map[string]interface{}{}
		}
		mu.Lock()
		defer mu.Unlock()
		name, _ := body["name"].(string)
		if name == "" {
			name = fmt.Sprintf("User %d", nextID)
		}
		user := gin.H{
			"id":         nextID,
			"name":       name,
			"created_at": time.Now().UTC().Format(time.RFC3339),
		}
		users = append(users, user)
		nextID++
		c.JSON(http.StatusCreated, user)
	})

	r.GET("/api/users/:id", func(c *gin.Context) {
		id := c.Param("id")
		mu.Lock()
		defer mu.Unlock()
		for _, u := range users {
			if fmt.Sprintf("%v", u["id"]) == id {
				c.JSON(http.StatusOK, u)
				return
			}
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
	})

	r.PUT("/api/users/:id", func(c *gin.Context) {
		id := c.Param("id")
		var body map[string]interface{}
		if err := c.ShouldBindJSON(&body); err != nil {
			body = map[string]interface{}{}
		}
		mu.Lock()
		defer mu.Unlock()
		for i, u := range users {
			if fmt.Sprintf("%v", u["id"]) == id {
				if name, ok := body["name"].(string); ok {
					users[i]["name"] = name
				}
				users[i]["updated_at"] = time.Now().UTC().Format(time.RFC3339)
				c.JSON(http.StatusOK, users[i])
				return
			}
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
	})

	r.DELETE("/api/users/:id", func(c *gin.Context) {
		id := c.Param("id")
		mu.Lock()
		defer mu.Unlock()
		for i, u := range users {
			if fmt.Sprintf("%v", u["id"]) == id {
				users = append(users[:i], users[i+1:]...)
				c.JSON(http.StatusOK, gin.H{"deleted": true, "id": id})
				return
			}
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
	})

	// Keepalive to Flask so the edge shows up in the graph
	go keepaliveTCP(FLASK_API)

	fmt.Printf(`
╔═══════════════════════════════════════════════════════════════╗
║                Fere Test Go Server (Gin)                      ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:%s                      ║
║  PID: %-56d║
║                                                               ║
║  Endpoints:                                                   ║
║    GET    /                - Server info                      ║
║    GET    /health          - Health check                     ║
║    GET    /api/users       - List users                       ║
║    POST   /api/users       - Create user                      ║
║    GET    /api/users/:id   - Get user                         ║
║    PUT    /api/users/:id   - Update user                      ║
║    DELETE /api/users/:id   - Delete user                      ║
╚═══════════════════════════════════════════════════════════════╝
`, PORT, os.Getpid())

	r.Run("0.0.0.0:" + PORT)
}

func keepaliveTCP(addr string) {
	for {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		if tc, ok := conn.(*net.TCPConn); ok {
			tc.SetKeepAlive(true)
			tc.SetKeepAlivePeriod(10 * time.Second)
		}
		// Block until the remote closes or errors
		buf := make([]byte, 1)
		conn.Read(buf)
		conn.Close()
		time.Sleep(2 * time.Second)
	}
}
