package main

import (
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

const PORT = "8084"
const FLASK_API = "127.0.0.1:5001"

var (
	orders    []fiber.Map
	nextID    = 1
	mu        sync.Mutex
)

func main() {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})

	app.Get("/", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"name":      "Fere Test Fiber Server",
			"version":   "1.0.0",
			"framework": "fiber",
			"endpoints": []string{
				"GET /",
				"GET /health",
				"GET /api/orders",
				"POST /api/orders",
				"GET /api/orders/:id",
				"PUT /api/orders/:id",
				"DELETE /api/orders/:id",
			},
		})
	})

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":    "healthy",
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"pid":       os.Getpid(),
		})
	})

	app.Get("/api/orders", func(c *fiber.Ctx) error {
		mu.Lock()
		defer mu.Unlock()
		return c.JSON(fiber.Map{"orders": orders, "total": len(orders)})
	})

	app.Post("/api/orders", func(c *fiber.Ctx) error {
		var body map[string]interface{}
		if err := c.BodyParser(&body); err != nil {
			body = map[string]interface{}{}
		}
		mu.Lock()
		defer mu.Unlock()
		order := fiber.Map{
			"id":         nextID,
			"status":     "pending",
			"created_at": time.Now().UTC().Format(time.RFC3339),
		}
		orders = append(orders, order)
		nextID++
		return c.Status(201).JSON(order)
	})

	app.Get("/api/orders/:id", func(c *fiber.Ctx) error {
		id := c.Params("id")
		mu.Lock()
		defer mu.Unlock()
		for _, o := range orders {
			if fmt.Sprintf("%v", o["id"]) == id {
				return c.JSON(o)
			}
		}
		return c.Status(404).JSON(fiber.Map{"error": "Order not found"})
	})

	app.Put("/api/orders/:id", func(c *fiber.Ctx) error {
		id := c.Params("id")
		var body map[string]interface{}
		c.BodyParser(&body)
		mu.Lock()
		defer mu.Unlock()
		for i, o := range orders {
			if fmt.Sprintf("%v", o["id"]) == id {
				if status, ok := body["status"].(string); ok {
					orders[i]["status"] = status
				}
				orders[i]["updated_at"] = time.Now().UTC().Format(time.RFC3339)
				return c.JSON(orders[i])
			}
		}
		return c.Status(404).JSON(fiber.Map{"error": "Order not found"})
	})

	app.Delete("/api/orders/:id", func(c *fiber.Ctx) error {
		id := c.Params("id")
		mu.Lock()
		defer mu.Unlock()
		for i, o := range orders {
			if fmt.Sprintf("%v", o["id"]) == id {
				orders = append(orders[:i], orders[i+1:]...)
				return c.JSON(fiber.Map{"deleted": true, "id": id})
			}
		}
		return c.Status(404).JSON(fiber.Map{"error": "Order not found"})
	})

	go keepaliveTCP(FLASK_API)

	fmt.Printf(`
╔═══════════════════════════════════════════════════════════════╗
║              Fere Test Fiber Server (Go Fiber)                ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:%s                      ║
║  PID: %-56d║
║  Framework: Fiber                                             ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET    /                 - Server info                     ║
║    GET    /health           - Health check                    ║
║    GET    /api/orders       - List orders                     ║
║    POST   /api/orders       - Create order                    ║
║    GET    /api/orders/:id   - Get order                       ║
║    PUT    /api/orders/:id   - Update order                    ║
║    DELETE /api/orders/:id   - Delete order                    ║
╚═══════════════════════════════════════════════════════════════╝
`, PORT, os.Getpid())

	app.Listen("0.0.0.0:" + PORT)
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
		buf := make([]byte, 1)
		conn.Read(buf)
		conn.Close()
		time.Sleep(2 * time.Second)
	}
}
