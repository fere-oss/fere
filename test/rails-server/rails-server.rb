#!/usr/bin/env ruby
#
# Test Rails-style server for Fere Dashboard Testing
#
# Uses WEBrick (built-in Ruby) as the HTTP server.
# Route definitions live in config/routes.rb for Fere's route scanner.
#
# Run with: ruby rails-server.rb

require 'webrick'
require 'json'
require 'socket'

PORT = (ENV['PORT'] || 8092).to_i
FLASK_PORT = 5001

store = { products: [], orders: [], next_product: 1, next_order: 1 }

server = WEBrick::HTTPServer.new(
  Port: PORT,
  BindAddress: '0.0.0.0',
  Logger: WEBrick::Log.new(File.open(File::NULL, 'w')),
  AccessLog: []
)

server.mount_proc('/') do |req, res|
  res['Content-Type'] = 'application/json'
  res['Access-Control-Allow-Origin'] = '*'

  path = req.path.chomp('/')
  method = req.request_method

  begin
    case "#{method} #{path}"
    when 'GET '
      res.body = JSON.generate({
        name: 'Fere Test Rails Server',
        version: '1.0.0',
        framework: 'rails',
        endpoints: [
          'GET /', 'GET /health',
          'GET /products', 'POST /products', 'GET /products/:id',
          'GET /orders', 'POST /orders', 'GET /orders/:id', 'DELETE /orders/:id',
        ]
      })
    when 'GET /health'
      res.body = JSON.generate({ status: 'healthy', timestamp: Time.now.to_i })
    when 'GET /products'
      res.body = JSON.generate({ products: store[:products], total: store[:products].length })
    when 'POST /products'
      data = JSON.parse(req.body || '{}') rescue {}
      product = { id: store[:next_product], name: data['name'] || "Product #{store[:next_product]}", created_at: Time.now.to_s }
      store[:products] << product
      store[:next_product] += 1
      res.status = 201
      res.body = JSON.generate(product)
    when 'GET /orders'
      res.body = JSON.generate({ orders: store[:orders], total: store[:orders].length })
    when 'POST /orders'
      data = JSON.parse(req.body || '{}') rescue {}
      order = { id: store[:next_order], status: data['status'] || 'pending', created_at: Time.now.to_s }
      store[:orders] << order
      store[:next_order] += 1
      res.status = 201
      res.body = JSON.generate(order)
    else
      if (m = path.match(%r{^/products/(\d+)$}))
        product = store[:products].find { |p| p[:id] == m[1].to_i }
        if product
          if method == 'DELETE'
            store[:products].delete(product)
            res.body = JSON.generate({ deleted: true, id: m[1].to_i })
          else
            res.body = JSON.generate(product)
          end
        else
          res.status = 404
          res.body = JSON.generate({ error: 'Not Found' })
        end
      elsif (m = path.match(%r{^/orders/(\d+)$}))
        order = store[:orders].find { |o| o[:id] == m[1].to_i }
        if order
          if method == 'DELETE'
            store[:orders].delete(order)
            res.body = JSON.generate({ deleted: true, id: m[1].to_i })
          else
            res.body = JSON.generate(order)
          end
        else
          res.status = 404
          res.body = JSON.generate({ error: 'Not Found' })
        end
      else
        res.status = 404
        res.body = JSON.generate({ error: 'Not Found', path: req.path })
      end
    end
  rescue => e
    res.status = 500
    res.body = JSON.generate({ error: e.message })
  end
end

# Keepalive to Flask so the edge shows in the graph
Thread.new do
  loop do
    begin
      sock = TCPSocket.new('127.0.0.1', FLASK_PORT)
      sock.setsockopt(Socket::SOL_SOCKET, Socket::SO_KEEPALIVE, true)
      sock.read(1)
      sock.close
    rescue
      # ignore — reconnect after delay
    end
    sleep 2
  end
end

puts "
╔═══════════════════════════════════════════════════════════════╗
║             Fere Test Rails Server (WEBrick)                  ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:#{PORT}                      ║
║  PID: #{Process.pid}
║                                                               ║
║  Routes (config/routes.rb):                                   ║
║    GET  /              - Server info                          ║
║    GET  /health        - Health check                         ║
║    GET  /products      - List products (resources)            ║
║    POST /products      - Create product                       ║
║    GET  /orders        - List orders                          ║
║    POST /orders        - Create order                         ║
╚═══════════════════════════════════════════════════════════════╝
"

trap('INT')  { server.shutdown; exit 0 }
trap('TERM') { server.shutdown; exit 0 }
server.start
