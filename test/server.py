#!/usr/bin/env python3
"""
Test Flask API Server for Fere Dashboard Testing

This server provides various endpoints to test the Fere dev environment dashboard.
It demonstrates:
- Multiple API endpoints (GET, POST, PUT, DELETE)
- Database connections (simulated with SQLite)
- Redis connections (optional)
- Background tasks
- WebSocket-like long polling

Run with: python server.py
Or with: flask run --port 5001
"""

import os
import json
import time
import sqlite3
import threading
from datetime import datetime
from flask import Flask, jsonify, request, Response

app = Flask(__name__)

# Configuration
PORT = int(os.environ.get('PORT', 5001))
DATABASE = os.path.join(os.path.dirname(__file__), 'test.db')

# In-memory data store (simulates cache/state)
data_store = {
    'items': [],
    'counter': 0,
    'events': []
}

# Initialize SQLite database
def init_db():
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            level TEXT,
            message TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            value REAL,
            recorded_at TEXT
        )
    ''')
    conn.commit()
    conn.close()

# ============================================
# Health & Status Endpoints
# ============================================

@app.route('/')
def index():
    """Root endpoint - API info"""
    return jsonify({
        'name': 'Fere Test API',
        'version': '1.0.0',
        'status': 'running',
        'endpoints': [
            'GET /',
            'GET /health',
            'GET /status',
            'GET /api/items',
            'POST /api/items',
            'GET /api/items/<id>',
            'PUT /api/items/<id>',
            'DELETE /api/items/<id>',
            'GET /api/metrics',
            'POST /api/metrics',
            'GET /api/logs',
            'POST /api/logs',
            'GET /api/events/stream',
            'POST /api/events',
            'GET /api/db/stats',
            'GET /api/slow',
            'GET /api/error',
        ]
    })

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
        'uptime_seconds': time.time() - app.config.get('start_time', time.time())
    })

@app.route('/status')
def status():
    """Detailed status endpoint"""
    return jsonify({
        'server': 'flask',
        'port': PORT,
        'pid': os.getpid(),
        'python_version': os.popen('python3 --version').read().strip(),
        'items_count': len(data_store['items']),
        'events_count': len(data_store['events']),
        'counter': data_store['counter']
    })

# ============================================
# Items CRUD API
# ============================================

@app.route('/api/items', methods=['GET'])
def get_items():
    """Get all items"""
    return jsonify({
        'items': data_store['items'],
        'total': len(data_store['items'])
    })

@app.route('/api/items', methods=['POST'])
def create_item():
    """Create a new item"""
    data = request.get_json() or {}
    item = {
        'id': len(data_store['items']) + 1,
        'name': data.get('name', f'Item {len(data_store["items"]) + 1}'),
        'value': data.get('value', 0),
        'created_at': datetime.utcnow().isoformat()
    }
    data_store['items'].append(item)
    return jsonify(item), 201

@app.route('/api/items/<int:item_id>', methods=['GET'])
def get_item(item_id):
    """Get a specific item"""
    item = next((i for i in data_store['items'] if i['id'] == item_id), None)
    if item:
        return jsonify(item)
    return jsonify({'error': 'Item not found'}), 404

@app.route('/api/items/<int:item_id>', methods=['PUT'])
def update_item(item_id):
    """Update an item"""
    item = next((i for i in data_store['items'] if i['id'] == item_id), None)
    if not item:
        return jsonify({'error': 'Item not found'}), 404

    data = request.get_json() or {}
    item['name'] = data.get('name', item['name'])
    item['value'] = data.get('value', item['value'])
    item['updated_at'] = datetime.utcnow().isoformat()
    return jsonify(item)

@app.route('/api/items/<int:item_id>', methods=['DELETE'])
def delete_item(item_id):
    """Delete an item"""
    item = next((i for i in data_store['items'] if i['id'] == item_id), None)
    if not item:
        return jsonify({'error': 'Item not found'}), 404

    data_store['items'].remove(item)
    return jsonify({'deleted': True, 'id': item_id})

# ============================================
# Metrics API (with SQLite)
# ============================================

@app.route('/api/metrics', methods=['GET'])
def get_metrics():
    """Get all metrics from database"""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM metrics ORDER BY recorded_at DESC LIMIT 100')
    rows = cursor.fetchall()
    conn.close()

    metrics = [
        {'id': r[0], 'name': r[1], 'value': r[2], 'recorded_at': r[3]}
        for r in rows
    ]
    return jsonify({'metrics': metrics, 'total': len(metrics)})

@app.route('/api/metrics', methods=['POST'])
def create_metric():
    """Record a new metric"""
    data = request.get_json() or {}

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO metrics (name, value, recorded_at) VALUES (?, ?, ?)',
        (data.get('name', 'unnamed'), data.get('value', 0), datetime.utcnow().isoformat())
    )
    conn.commit()
    metric_id = cursor.lastrowid
    conn.close()

    return jsonify({
        'id': metric_id,
        'name': data.get('name', 'unnamed'),
        'value': data.get('value', 0)
    }), 201

# ============================================
# Logs API (with SQLite)
# ============================================

@app.route('/api/logs', methods=['GET'])
def get_logs():
    """Get recent logs"""
    level = request.args.get('level')
    limit = int(request.args.get('limit', 50))

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    if level:
        cursor.execute(
            'SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?',
            (level, limit)
        )
    else:
        cursor.execute('SELECT * FROM logs ORDER BY id DESC LIMIT ?', (limit,))

    rows = cursor.fetchall()
    conn.close()

    logs = [
        {'id': r[0], 'timestamp': r[1], 'level': r[2], 'message': r[3]}
        for r in rows
    ]
    return jsonify({'logs': logs, 'total': len(logs)})

@app.route('/api/logs', methods=['POST'])
def create_log():
    """Create a log entry"""
    data = request.get_json() or {}

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO logs (timestamp, level, message) VALUES (?, ?, ?)',
        (datetime.utcnow().isoformat(), data.get('level', 'info'), data.get('message', ''))
    )
    conn.commit()
    log_id = cursor.lastrowid
    conn.close()

    return jsonify({'id': log_id, 'created': True}), 201

# ============================================
# Events API (Server-Sent Events style)
# ============================================

@app.route('/api/events', methods=['POST'])
def create_event():
    """Push a new event"""
    data = request.get_json() or {}
    event = {
        'id': len(data_store['events']) + 1,
        'type': data.get('type', 'generic'),
        'payload': data.get('payload', {}),
        'timestamp': datetime.utcnow().isoformat()
    }
    data_store['events'].append(event)

    # Keep only last 100 events
    if len(data_store['events']) > 100:
        data_store['events'] = data_store['events'][-100:]

    return jsonify(event), 201

@app.route('/api/events/stream')
def stream_events():
    """Stream events (long polling simulation)"""
    def generate():
        last_id = int(request.args.get('last_id', 0))
        timeout = int(request.args.get('timeout', 30))
        start = time.time()

        while time.time() - start < timeout:
            new_events = [e for e in data_store['events'] if e['id'] > last_id]
            if new_events:
                for event in new_events:
                    yield f"data: {json.dumps(event)}\n\n"
                    last_id = event['id']
            time.sleep(0.5)

        yield f"data: {json.dumps({'type': 'timeout'})}\n\n"

    return Response(generate(), mimetype='text/event-stream')

# ============================================
# Database Stats
# ============================================

@app.route('/api/db/stats')
def db_stats():
    """Get database statistics"""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()

    cursor.execute('SELECT COUNT(*) FROM logs')
    log_count = cursor.fetchone()[0]

    cursor.execute('SELECT COUNT(*) FROM metrics')
    metric_count = cursor.fetchone()[0]

    # Get file size
    db_size = os.path.getsize(DATABASE) if os.path.exists(DATABASE) else 0

    conn.close()

    return jsonify({
        'database': DATABASE,
        'size_bytes': db_size,
        'tables': {
            'logs': {'count': log_count},
            'metrics': {'count': metric_count}
        }
    })

# ============================================
# Test Endpoints (for various scenarios)
# ============================================

@app.route('/api/slow')
def slow_endpoint():
    """Simulate a slow endpoint"""
    delay = float(request.args.get('delay', 2))
    time.sleep(delay)
    return jsonify({
        'message': 'Slow response completed',
        'delay_seconds': delay
    })

@app.route('/api/error')
def error_endpoint():
    """Simulate an error"""
    error_type = request.args.get('type', '500')

    if error_type == '400':
        return jsonify({'error': 'Bad Request'}), 400
    elif error_type == '401':
        return jsonify({'error': 'Unauthorized'}), 401
    elif error_type == '403':
        return jsonify({'error': 'Forbidden'}), 403
    elif error_type == '404':
        return jsonify({'error': 'Not Found'}), 404
    else:
        return jsonify({'error': 'Internal Server Error'}), 500

@app.route('/api/counter', methods=['GET'])
def get_counter():
    """Get current counter value"""
    return jsonify({'counter': data_store['counter']})

@app.route('/api/counter/increment', methods=['POST'])
def increment_counter():
    """Increment counter"""
    amount = request.get_json().get('amount', 1) if request.get_json() else 1
    data_store['counter'] += amount
    return jsonify({'counter': data_store['counter']})

@app.route('/api/counter/reset', methods=['POST'])
def reset_counter():
    """Reset counter to zero"""
    data_store['counter'] = 0
    return jsonify({'counter': 0})

# ============================================
# Main
# ============================================

if __name__ == '__main__':
    print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                    Fere Test API Server                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Server starting on http://localhost:{PORT}                      ║
║  PID: {os.getpid()}                                                 ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /health          - Health check                       ║
║    GET  /status          - Server status                      ║
║    GET  /api/items       - List items                         ║
║    POST /api/items       - Create item                        ║
║    GET  /api/metrics     - Get metrics (SQLite)               ║
║    GET  /api/logs        - Get logs (SQLite)                  ║
║    GET  /api/events/stream - SSE event stream                 ║
║    GET  /api/slow        - Slow endpoint (test timeouts)      ║
║    GET  /api/error       - Error endpoint (test errors)       ║
╚═══════════════════════════════════════════════════════════════╝
    """)

    # Initialize database
    init_db()

    # Store start time
    app.config['start_time'] = time.time()

    # Run the server
    app.run(
        host='0.0.0.0',
        port=PORT,
        debug=True,
        threaded=True
    )
