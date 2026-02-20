from django.urls import path
from django.http import JsonResponse
import json
import time

_store = {'products': [], 'orders': [], 'next_product_id': 1, 'next_order_id': 1}


def index(request):
    return JsonResponse({
        'name': 'Fere Test Django Server',
        'version': '1.0.0',
        'framework': 'django',
        'endpoints': [
            'GET /',
            'GET /health/',
            'GET /api/products/',
            'POST /api/products/',
            'GET /api/products/<id>/',
            'GET /api/orders/',
            'POST /api/orders/',
        ],
    })


def health(request):
    return JsonResponse({'status': 'healthy', 'timestamp': time.time()})


def products(request):
    if request.method == 'POST':
        data = json.loads(request.body or b'{}')
        product = {
            'id': _store['next_product_id'],
            'name': data.get('name', f"Product {_store['next_product_id']}"),
            'price': data.get('price', 0),
        }
        _store['products'].append(product)
        _store['next_product_id'] += 1
        return JsonResponse(product, status=201)
    return JsonResponse({'products': _store['products'], 'total': len(_store['products'])})


def product_detail(request, pk):
    item = next((p for p in _store['products'] if p['id'] == pk), None)
    if not item:
        return JsonResponse({'error': 'Not found'}, status=404)
    if request.method == 'DELETE':
        _store['products'].remove(item)
        return JsonResponse({'deleted': True, 'id': pk})
    return JsonResponse(item)


def orders(request):
    if request.method == 'POST':
        data = json.loads(request.body or b'{}')
        order = {
            'id': _store['next_order_id'],
            'status': data.get('status', 'pending'),
            'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        _store['orders'].append(order)
        _store['next_order_id'] += 1
        return JsonResponse(order, status=201)
    return JsonResponse({'orders': _store['orders'], 'total': len(_store['orders'])})


urlpatterns = [
    path('', index),
    path('health/', health),
    path('api/products/', products),
    path('api/products/<int:pk>/', product_detail),
    path('api/orders/', orders),
]
